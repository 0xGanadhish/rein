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
const FINAL = new Set(['delivered', 'rejected', 'refunded']);

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
  desk: Pick<DeskClient, 'list_orders' | 'stats'>;
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

  // Orders: from the lowest id that wasn't final last time, a page at a time until a page comes back empty.
  const orderKey = `mirror:orders:${network}`;
  const start = await cursor(db, orderKey);
  let low = start;
  let advancing = true;
  for (let page = 0, from = start; page < ORDER_PAGES; page++, from += ORDER_PAGE) {
    const orders: DeskOrder[] = await deps.desk.list_orders(from, ORDER_PAGE);
    if (orders.length === 0) break;
    await db.batch(orders.map((o) => db.prepare(`INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET status = excluded.status`)
      .bind(o.id, o.source, o.payer, o.chain, o.vault.toLowerCase(), o.amount, o.created_s, o.status)));
    tally.orders += orders.length;
    for (const o of orders) {
      if (advancing && FINAL.has(o.status)) low = o.id + 1;
      else advancing = false;
    }
  }
  if (low !== start) await setCursor(db, orderKey, low);

  const stats = await deps.desk.stats();
  await db.prepare('INSERT INTO meta (key, json, at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET json = ?2, at = ?3')
    .bind('desk_stats', JSON.stringify(stats), now).run();

  // Posts: every id past the last one copied. Grading fields are filled in by gradeDue.
  for (const chain of NETWORK_CHAINS[network]) {
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
