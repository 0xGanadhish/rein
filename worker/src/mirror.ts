import { createPublicClient, http, type Address, type Hex } from 'viem';
import type { DeskChain, DeskOrder } from '../../shared/desk';
import { oracleAbi } from './abis';
import { CHAINS, ORACLES } from './broadcast';
import { NETWORK_CHAINS, type DeskClient } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';
import { inputCheck } from './inputCheck';

const ORDER_PAGE = 100;
const ORDER_PAGES = 10;
const POST_BATCH = 50;
const FINAL: Record<string, true> = { delivered: true, rejected: true, refunded: true, post_failed: true };

export interface OraclePost {
  vault: Address;
  verdict: number;
  confidenceBps: number;
  riskBps: number;
  stateHash: Hex;
  postedAt: bigint;
  ppsAtPost: bigint;
  assetsAtPost: bigint;
  liquidityAtPost: bigint;
}

export interface OracleReader {
  postCount(): Promise<bigint>;
  getPost(id: bigint): Promise<OraclePost>;
}

export interface MirrorDeps {
  desk: Pick<DeskClient, 'list_orders' | 'next_order_id' | 'stats'>;
  /** Null while the chain has no oracle. */
  oracle(chain: DeskChain): OracleReader | null;
}

export function realMirrorDeps(env: Env, desk: DeskClient): MirrorDeps {
  return {
    desk,
    oracle(chain) {
      const address = ORACLES[chain];
      if (!address) return null;
      const client = createPublicClient({ chain: CHAINS[chain], transport: http(rpcFor(env, chain), { retryCount: 2 }) });
      return {
        postCount: () => client.readContract({ address, abi: oracleAbi, functionName: 'postCount' }),
        getPost: (id) => client.readContract({ address, abi: oracleAbi, functionName: 'getPost', args: [id] }),
      };
    },
  };
}

async function cursor(db: D1Database, key: string): Promise<number> {
  return (await db.prepare('SELECT value FROM cursors WHERE key = ?').bind(key).first<number>('value')) ?? 0;
}
async function setCursor(db: D1Database, key: string, value: number): Promise<void> {
  await db.prepare('INSERT INTO cursors (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2').bind(key, value).run();
}

/** Copies desk orders, desk stats and new oracle posts into D1, checking each post against the doc it was judged on. */
export async function mirror(env: Env, network: NearNetwork, deps: MirrorDeps, now = Math.floor(Date.now() / 1000)): Promise<{ orders: number; posts: number }> {
  const db = env.DB;
  const tally = { orders: 0, posts: 0 };

  // Keep the oldest unfinished ID, but rotate a separate scan cursor beyond stuck prefixes.
  // list_orders returns ID intervals, so an empty page below next_order_id is a pruned gap, not EOF.
  const orderKey = `mirror:orders:${network}`;
  const scanKey = `mirror:scan:${network}`;
  const [start, savedScan, bound] = await Promise.all([
    cursor(db, orderKey), cursor(db, scanKey), deps.desk.next_order_id(),
  ]);
  let low = start;
  let from = Math.max(low, savedScan);
  if (from >= bound) from = low;
  for (let page = 0; page < ORDER_PAGES && from < bound; page++) {
    const end = Math.min(from + ORDER_PAGE, bound);
    const orders: DeskOrder[] = await deps.desk.list_orders(from, end - from);
    if (orders.length) {
      await db.batch(orders.map((o) => db.prepare(`INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status`)
        .bind(o.id, o.source, o.payer, o.chain, o.vault.toLowerCase(), o.amount, o.created_s, o.status)));
      tally.orders += orders.length;
    }
    if (from === low) {
      // Separate RPC views can disagree about a recent ID. Only explicit contiguous finals advance the low mark.
      for (const order of orders) {
        if (order.id !== low || !FINAL[order.status]) break;
        low = order.id + 1;
      }
    }
    from = end;
  }
  if (low !== start) await setCursor(db, orderKey, low);
  await setCursor(db, scanKey, from >= bound ? low : from);

  const stats = await deps.desk.stats();
  await db.prepare('INSERT INTO meta (key, json, at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET json = ?2, at = ?3')
    .bind('desk_stats', JSON.stringify(stats), now).run();

  // Posts: every id past the last one copied. Grading fields are filled in by gradeDue.
  for (const chain of NETWORK_CHAINS[network]) {
    // A post can land before its judged doc is durable locally. Link it once the doc arrives;
    // only linkage/check columns change, leaving independently collected grading intact.
    const { results: unlinked } = await db.prepare(`SELECT p.id, p.pps_at_post, p.assets_at_post, p.liquidity_at_post, d.order_id, d.doc
        FROM posts p JOIN docs d ON d.hash = p.state_hash
        WHERE p.chain = ? AND p.order_id IS NULL ORDER BY p.id LIMIT ?`)
      .bind(chain, POST_BATCH).all<{ id: number; pps_at_post: string; assets_at_post: string; liquidity_at_post: string; order_id: number; doc: string }>();
    for (const p of unlinked) {
      const check = inputCheck(p.doc, {
        ppsAtPost: BigInt(p.pps_at_post), assetsAtPost: BigInt(p.assets_at_post), liquidityAtPost: BigInt(p.liquidity_at_post),
      });
      await db.prepare('UPDATE posts SET order_id = ?, input_check = ? WHERE chain = ? AND id = ? AND order_id IS NULL')
        .bind(p.order_id, check, chain, p.id).run();
      if (check === 'mismatch') console.error(JSON.stringify({ msg: 'post_input_mismatch', chain, verdictId: p.id, orderId: p.order_id }));
    }
    const oracle = deps.oracle(chain);
    if (!oracle) continue;
    const key = `mirror:posts:${chain}`;
    const done = await cursor(db, key);
    const count = Number(await oracle.postCount());
    const until = Math.min(count, done + POST_BATCH);
    for (let id = done + 1; id <= until; id++) {
      const p = await oracle.getPost(BigInt(id));
      const hash = p.stateHash.toLowerCase();
      const doc = await db.prepare('SELECT order_id, doc FROM docs WHERE hash = ?').bind(hash).first<{ order_id: number; doc: string }>();
      const check = doc ? inputCheck(doc.doc, p) : 'unknown';
      await db.prepare(`INSERT OR IGNORE INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at,
          pps_at_post, assets_at_post, liquidity_at_post, order_id, input_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(chain, id, p.vault.toLowerCase(), p.verdict, p.confidenceBps, p.riskBps, hash, Number(p.postedAt),
          String(p.ppsAtPost), String(p.assetsAtPost), String(p.liquidityAtPost), doc?.order_id ?? null, check).run();
      if (check === 'mismatch') console.error(JSON.stringify({ msg: 'post_input_mismatch', chain, verdictId: id, orderId: doc?.order_id }));
      tally.posts++;
    }
    if (until > done) await setCursor(db, key, until);
  }
  return tally;
}
