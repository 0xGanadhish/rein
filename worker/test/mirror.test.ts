import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { keccak256, toBytes } from 'viem';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { DeskOrder, DeskStats } from '../../shared/desk';
import { tick } from '../src/index';
import { BroadcastJournal } from '../src/journal';
import type { OrderDeps } from '../src/order';
import { mirror, type MirrorDeps, type OraclePost } from '../src/mirror';

const NOW = 1_793_774_225;
function order(id: number, status: DeskOrder['status']): DeskOrder {
  return { id, source: 'near', payer: 'alice.testnet', chain: 'base',
    vault: '0x00000000000000000000000000000000000000aa', amount: '1', created_s: NOW - 60,
    status, exit_pending_s: null, valid_until: null };
}
function setup(orders: DeskOrder[]) {
  const pages: number[] = [];
  const desk = {
    open_orders: async (limit: number) => orders.filter((o) => o.status === 'open').slice(0, limit),
    list_orders: async (from: number, limit: number) => { pages.push(from); return orders.filter((o) => o.id >= from && o.id < from + limit); },
    next_order_id: async () => orders.reduce((next, o) => Math.max(next, o.id + 1), 0),
    stats: async () => ({} as DeskStats),
  };
  const deps: MirrorDeps = {
    desk,
    oracle: () => null,
  };
  return { deps, pages, desk };
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(['cursors', 'orders', 'posts', 'docs', 'meta'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

it('post_failed_advances_mirror_cursor', async () => {
  const s = setup([order(0, 'post_failed'), order(1, 'delivered')]);
  await mirror(env, 'mainnet', s.deps, NOW);
  expect(await env.DB.prepare('SELECT value FROM cursors WHERE key = ?').bind('mirror:orders:mainnet').first('value')).toBe(2);
  expect(await env.DB.prepare('SELECT status FROM orders WHERE id = 0').first('status')).toBe('post_failed');
});

it('late_doc_repairs_post_linkage', async () => {
  const doc = 'rein-v1|order=7|pps=100|assets=1000|liquidity=50';
  const badDoc = 'rein-v1|order=8|pps=200|assets=1000|liquidity=50';
  const hashes = [keccak256(toBytes(doc)), keccak256(toBytes(badDoc))];
  const s = setup([]);
  let reads = 0;
  s.deps.oracle = (chain) => chain !== 'base' ? null : {
    postCount: async () => 2n,
    getPost: async (id): Promise<OraclePost> => {
      reads++;
      return { vault: '0x00000000000000000000000000000000000000aa', verdict: 0, confidenceBps: 9000,
        riskBps: 500, stateHash: hashes[Number(id) - 1], postedAt: BigInt(NOW),
        ppsAtPost: 100n, assetsAtPost: 1000n, liquidityAtPost: 500n };
    },
  };
  await mirror(env, 'mainnet', s.deps, NOW);
  expect(await env.DB.prepare('SELECT order_id, input_check FROM posts WHERE chain = ? AND id = 1').bind('base').first())
    .toEqual({ order_id: null, input_check: 'unknown' });
  await env.DB.batch([
    env.DB.prepare('INSERT INTO docs (hash, order_id, doc) VALUES (?, 7, ?)').bind(hashes[0], doc),
    env.DB.prepare('INSERT INTO docs (hash, order_id, doc) VALUES (?, 8, ?)').bind(hashes[1], badDoc),
    env.DB.prepare('UPDATE posts SET sampled = 2, resample_at = 123, resolved = 1, adverse = 1, reasons = 3 WHERE chain = ? AND id = 1').bind('base'),
  ]);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    await mirror(env, 'mainnet', s.deps, NOW + 1);
  } finally {
    console.error = originalError;
  }
  expect(await env.DB.prepare('SELECT order_id, input_check, sampled, resample_at, resolved, adverse, reasons FROM posts WHERE chain = ? AND id = 1').bind('base').first())
    .toEqual({ order_id: 7, input_check: 'match', sampled: 2, resample_at: 123, resolved: 1, adverse: 1, reasons: 3 });
  expect(await env.DB.prepare('SELECT order_id, input_check FROM posts WHERE chain = ? AND id = 2').bind('base').first())
    .toEqual({ order_id: 8, input_check: 'mismatch' });
  expect(logs.some((line) => line.includes('post_input_mismatch'))).toBe(true);
  expect(reads).toBe(2);
  await mirror(env, 'mainnet', s.deps, NOW + 2);
  expect(reads).toBe(2);

  // A later burst of docs is repaired in bounded batches, rather than one unbounded tick.
  await env.DB.batch(['posts', 'docs'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  for (let id = 1; id <= 55; id++) {
    const hash = keccak256(toBytes(`${doc}|order=${id}`));
    await env.DB.batch([
      env.DB.prepare('INSERT INTO docs (hash, order_id, doc) VALUES (?, ?, ?)').bind(hash, id, `${doc}|order=${id}`),
      env.DB.prepare(`INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash,
        posted_at, pps_at_post, assets_at_post, liquidity_at_post) VALUES ('base', ?, '0xaa', 0, 9000, 500, ?, ?, '100', '1000', '500')`)
        .bind(id, hash, NOW),
    ]);
  }
  const bounded = setup([]);
  await mirror(env, 'mainnet', bounded.deps, NOW);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE order_id IS NOT NULL').first('n')).toBe(50);
  await mirror(env, 'mainnet', bounded.deps, NOW + 1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM posts WHERE order_id IS NOT NULL').first('n')).toBe(55);
});

it('pruned_id_range_does_not_stop_mirror', async () => {
  const orders = [order(0, 'signing'), order(1600, 'signed')];
  let workedLater = false;
  let revisitedEarlier = false;
  let mirroredEarlier = false;
  let boundsRead = 0;
  for (let phase = 0; phase < 2; phase++) {
    if (phase === 1) orders[0].status = 'signed';
    for (let n = 0; n < 100 && !(phase === 0 ? workedLater : revisitedEarlier && mirroredEarlier); n++) {
      // All runner state is recreated: only durable cursors may carry progress across ticks.
      const fresh = setup(orders);
      const nextId = fresh.desk.next_order_id;
      fresh.desk.next_order_id = async () => { boundsRead++; return nextId(); };
      const now = NOW + phase * 100 + n;
      await mirror(env, 'mainnet', fresh.deps, now);
      expect(fresh.pages.length).toBeLessThanOrEqual(10);
      if (phase === 1) mirroredEarlier = await env.DB.prepare('SELECT status FROM orders WHERE id = 0').first('status') === 'signed';
      const desk = {
        ...fresh.desk,
        policy: async () => ({ exit_confirm_min_s: 30, exit_confirm_max_s: 300 }),
        get_signed_tx: async () => null,
      };
      const result = await tick(env, 'mainnet', {
        desk, journal: new BroadcastJournal(env.DB, 'mainnet'), now: () => now, chain: () => ({}),
      } as unknown as OrderDeps);
      if (result[1600] === 'pending') workedLater = true;
      if (phase === 1 && result[0] === 'pending') revisitedEarlier = true;
    }
  }
  expect(await env.DB.prepare('SELECT status FROM orders WHERE id = 1600').first('status')).toBe('signed');
  expect(await env.DB.prepare('SELECT status FROM orders WHERE id = 0').first('status')).toBe('signed');
  expect(workedLater).toBe(true);
  expect(revisitedEarlier).toBe(true);
  expect(boundsRead).toBeGreaterThan(0);
});

it('an_older_empty_order_page_does_not_permanently_hide_a_new_order', async () => {
  const s = setup([order(0, 'open')]);
  const list = s.desk.list_orders;
  let first = true;
  s.desk.list_orders = async (from, limit) => {
    if (first) { first = false; return []; }
    return list(from, limit);
  };
  await mirror(env, 'mainnet', s.deps, NOW);
  await mirror(env, 'mainnet', s.deps, NOW + 1);
  expect(await env.DB.prepare('SELECT status FROM orders WHERE id = 0').first('status')).toBe('open');
});
