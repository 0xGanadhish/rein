import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { encodeAbiParameters, encodeEventTopics, keccak256, maxUint256, toBytes, decodeFunctionData, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeskStats } from '../../shared/desk';
import { oracleAbi } from '../src/abis';
import { handle, type ApiDeps } from '../src/api';
import type { DeskOrder } from '../src/deskTypes';
import { checkHealth, type HealthDeps } from '../src/health';
import { runAll, type CronDeps } from '../src/index';
import { BroadcastJournal } from '../src/journal';
import type { OraclePost } from '../src/mirror';

const T = 1_793_774_400;
const VAULT = '0x00000000000000000000000000000000000000aa';
const STATS: DeskStats = {
  sales_near: '3000000000000000000000000', sales_usdc: '2000000', sales_x402_usdc: '1000000', refunds: 1, open_paid: 0,
  inference_tokens_in: 0, inference_tokens_out: 0, gas_wei: { 'monad-testnet': '0', monad: '0', base: '0', 'base-sepolia': '0' },
  paid_treasury: { near: '0', usdc: '0' }, paid_agent: { near: '0', usdc: '0' }, owed: '0', owed_near: '0', watch_orders: 0,
};
const TABLES = ['orders', 'docs', 'posts', 'watch_snapshots', 'watch_baselines', 'watch_requests', 'meta', 'cursors', 'judge_calls', 'locks'];

const get = (path: string, deps: Partial<ApiDeps> = {}) =>
  handle(new Request(`https://rein.test${path}`), env, { kick: async () => ({}), health: async () => { throw new Error('unused'); },
    payments: async () => { throw new Error('unused'); }, ...deps });

describe('api', () => {
  beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  beforeEach(async () => { await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`))); });

  it('kick_refused_without_token', async () => {
    let invoked = false;
    const deps = { kick: async () => { invoked = true; return {}; }, health: null!, payments: null! };
    const response = await handle(new Request('https://rein.test/v1/kick', { method: 'POST' }), env, deps);
    expect(response.status).toBe(401);
    expect(invoked).toBe(false);
    const configured = { ...env, KICK_TOKEN: 'test-only-kick' };
    expect((await handle(new Request('https://rein.test/v1/kick', { method: 'POST' }), configured, deps)).status).toBe(401);
    expect((await handle(new Request('https://rein.test/v1/kick', {
      method: 'POST', headers: { Authorization: 'Bearer test-only-kick' },
    }), configured, deps)).status).toBe(200);
  });

  it('quote_rate_limit_returns_429_before_payment_dependencies', async () => {
    let paymentsCalled = false;
    let limitedKey: string | undefined;
    const response = await handle(new Request('https://rein.test/v1/quote', {
      method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' }, body: 'not JSON',
    }), { ...env, QUOTE_RATE_LIMITER: { limit: async ({ key }) => {
      limitedKey = key;
      return { success: false };
    } } }, {
      kick: null!, health: null!, payments: async () => { paymentsCalled = true; throw new Error('must not initialize'); },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({ error: 'rate limited' });
    expect(limitedKey).toBe('192.0.2.1');
    expect(paymentsCalled).toBe(false);
  });

  it('health_flags_stuck_order_and_stale_cron', async () => {
    const deps = {
      derivedAddress: async () => '0xdead',
      gasBalance: async () => 10n ** 18n,
      agent: async () => ({ balance: 10n ** 24n, allowance: null }),
      allowanceGranted: null,
      activity: async () => ({
        last_cron_s: T - 601, last_delivery_s: T - 100,
        oldest_stuck_order: { id: 7, status: 'signed', created_s: T - 3601, deadline_s: 1800, valid_until: T - 1801 },
        pending_refunds: { usdc: '0', near: '0', orders: 0 },
      }),
      now: () => T,
    };
    const health = await checkHealth('testnet', deps);
    expect(health.flags).toContain('stale_cron');
    expect(health.flags).toContain('stuck_order:7');
    expect(health).toMatchObject({ last_cron_s: T - 601, last_delivery_s: T - 100, oldest_stuck_order: { id: 7 } });
  });

  it('ledger_returns_score_and_business_panel', async () => {
    const post = env.DB.prepare(`INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at, pps_at_post,
        assets_at_post, liquidity_at_post, order_id, input_check, resolved, adverse, reasons) VALUES (?, ?, ?, ?, ?, ?, '0x00', ?, '1', '1', '1', ?, ?, ?, ?, ?)`);
    await env.DB.batch([
      // An EXIT that came true, repeated 30 s later; a HOLD that held; one unresolved; and a Base post the testnet ledger leaves out.
      post.bind('monad-testnet', 1, VAULT, 1, 9500, 8000, T, 10, 'match', 1, 1, 1),
      post.bind('monad-testnet', 2, VAULT, 1, 9500, 8000, T + 30, 11, 'match', 1, 1, 1),
      post.bind('monad-testnet', 3, '0xbb', 0, 8500, 1000, T + 60, 12, 'mismatch', 1, 0, 0),
      post.bind('monad-testnet', 4, '0xbb', 2, 7000, 3000, T + 90, null, 'unknown', 0, null, null),
      post.bind('base', 1, VAULT, 0, 9000, 1000, T, 13, 'match', 1, 1, 1),
      env.DB.prepare(`INSERT INTO meta (key, json, at) VALUES ('desk_stats', ?, ?)`).bind(JSON.stringify(STATS), T),
      env.DB.prepare(`INSERT INTO judge_calls (order_id, at, signing_address, cost_usd_micros) VALUES (10, ?, '0xs', 1200), (11, ?, '0xs', 800)`).bind(T, T),
      env.DB.prepare(`INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status) VALUES
          (10, 'near', 'alice.testnet', 'monad-testnet', ?1, '1', ?2, 'delivered'), (11, 'watch', NULL, 'monad-testnet', ?1, '0', ?2, 'delivered'),
          (12, 'near', 'bob.testnet', 'monad-testnet', '0xbb', '1', ?2, 'refunded')`).bind(VAULT, T),
      env.DB.prepare(`INSERT INTO watch_requests (chain, vault, at, reason, order_id, refusal) VALUES
          ('monad-testnet', ?1, ?2, 'apy', 11, NULL), ('monad-testnet', ?1, ?2, 'apy', NULL, 'spacing')`).bind(VAULT, T),
    ]);

    const res = await get('/v1/ledger?network=testnet');
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, any>>();
    expect(body.network).toBe('testnet');
    expect(body).toMatchObject({ posts: 4, calls: 3, input_checks: { match: 2, mismatch: 1, unknown: 1 } });
    // Two resolved calls, the repeat not counted: (0.8 - 1)² and (0.1 - 0)².
    expect(body.score.n).toBe(2);
    expect(body.score.brier).toBeCloseTo((0.04 + 0.01) / 2, 10);
    expect(body.score.early).toBe(true);
    expect(body.score.bands.find((b: any) => b.band === '95-100')).toEqual({ band: '95-100', n: 1, hitRate: 1 });
    expect(body.recent.map((r: any) => [r.id, r.verdict, r.repeat])).toEqual([[4, 'MOVE', false], [3, 'HOLD', false], [2, 'EXIT', true], [1, 'EXIT', false]]);
    expect(body.business).toMatchObject({
      desk: { ...STATS, as_of: T },
      judge_calls: 2,
      judge_cost_usd_micros: 2000,
      orders: [
        { source: 'near', status: 'delivered', n: 1 }, { source: 'near', status: 'refunded', n: 1 }, { source: 'watch', status: 'delivered', n: 1 },
      ],
      watch: { asked: 2, opened: 1 },
    });
    expect(await (await get('/v1/stats')).json()).toEqual(body.business);
    expect((await get('/v1/ledger?network=devnet')).status).toBe(400);
  });

  it('kick_is_idempotent', async () => {
    // Order 5 was judged on `doc`, delivered, and its post landed an hour ago, so it is due to resolve.
    const doc = `rein-v1|order=5|chain=monad-testnet|vault=${VAULT}|at=${T - 3601}|block=9|pps=1000000|assets=5000000|liquidity=na|apy_bps=500|apy_bps_prev=500|util_bps=5000|net_out_pct_1h=0.00|name=M`;
    await env.DB.prepare('INSERT INTO docs (hash, order_id, doc) VALUES (?, 5, ?)').bind(keccak256(toBytes(doc)), doc).run();
    const order: DeskOrder = { id: 5, source: 'near', payer: 'alice.testnet', chain: 'monad-testnet', vault: VAULT, amount: '1', created_s: T - 3700, status: 'delivered', exit_pending_s: null, valid_until: T - 1900 };
    const onchainPost: OraclePost = {
      vault: VAULT, verdict: 0, confidenceBps: 9000, riskBps: 500, stateHash: keccak256(toBytes(doc)), postedAt: BigInt(T - 3600),
      ppsAtPost: 1_000_000n, assetsAtPost: 5_000_000n, liquidityAtPost: maxUint256,
    };
    const calls: string[] = [];
    let resolved = false;
    const desk = {
      open_orders: async () => [],
      list_orders: async (from: number) => (from <= 5 ? [order] : []),
      next_order_id: async () => 6,
      policy: async () => ({ exit_confirm_min_s: 30, exit_confirm_max_s: 300 }),
      stats: async () => STATS,
      menu: async (chain: string) => chain === 'monad-testnet' ? [VAULT] : [],
      submit_watch_request: async () => { calls.push('submit_watch_request'); return 6; },
    };
    const deps: CronDeps = {
      order: { desk: desk as never, journal: new BroadcastJournal(env.DB, 'testnet'), read: null!, flows: null!, judge: null!, chain: null!, now: () => T, alert: async () => {} },
      mirror: { desk, oracle: (chain) => chain !== 'monad-testnet' ? null : { postCount: async () => 1n, getPost: async () => onchainPost } },
      grade: {
        resolver: (chain) => chain !== 'monad-testnet' ? null : {
          oracle: '0x0000000000000000000000000000000000000c1e',
          readResolution: async () => ({ resolved, adverse: false, reasons: 0 }),
          sender: {
            async send({ data }) {
              const { functionName, args } = decodeFunctionData({ abi: oracleAbi, data });
              calls.push(functionName);
              resolved = true;
              return {
                status: 'success', hash: '0x02', logs: [{
                  address: '0x0000000000000000000000000000000000000c1e', blockHash: null, blockNumber: null, logIndex: null, transactionHash: null,
                  transactionIndex: null, removed: false, data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint8' }], [false, 0]),
                  topics: encodeEventTopics({ abi: oracleAbi, eventName: 'VerdictResolved', args: { id: args![0] as bigint } }) as [Hex, ...Hex[]],
                }],
              };
            },
          },
        },
      },
      watch: { desk, read: async () => ({ apyBps: 500, utilBps: 5000, totalAssets: 5_000_000n }) },
    };
    const kick = () => handle(new Request('https://rein.test/v1/kick', { method: 'POST', headers: { Authorization: 'Bearer test-only-kick' } }),
      { ...env, KICK_TOKEN: 'test-only-kick' }, { kick: () => runAll(env, 'testnet', T, deps), health: null!, payments: null! });
    const dump = async () => Promise.all(['orders', 'posts', 'watch_snapshots', 'watch_baselines', 'watch_requests'].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results));

    const first = await (await kick()).json();
    expect(first).toMatchObject({
      orders: {},
      grade: { 'monad-testnet': { sampled: 0, sent: 1, synced: 0, failed: 0, unsampled: 0 } },
      watch: { snapshots: 1, submitted: 0, refused: 0, failed: 0 },
    });
    const after = await dump();

    const second = await (await kick()).json();
    expect(second).toMatchObject({
      orders: {},
      grade: { 'monad-testnet': { sampled: 0, sent: 0, synced: 0, failed: 0, unsampled: 0 } },
      watch: { snapshots: 0, submitted: 0, refused: 0, failed: 0 },
    });
    expect(await dump()).toEqual(after);
    expect(calls).toEqual(['resolve']);

    const o = await (await get('/v1/orders/5')).json<Record<string, any>>();
    expect(o).toMatchObject({ id: 5, status: 'delivered', posts: [{ chain: 'monad-testnet', id: 1, verdict: 'HOLD', input_check: 'match', resolved: 1, adverse: 0 }] });
    expect((await get('/v1/orders/6')).status).toBe(404);
    expect((await get('/v1/kick')).status).toBe(405);
  });

  it('health_flags_low_gas_and_allowance', async () => {
    const deps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
      derivedAddress: async () => '0xdead',
      gasBalance: async (chain) => (chain === 'base' ? 10n ** 14n - 1n : 10n ** 18n),
      agent: async () => ({ balance: 2n * 10n ** 23n - 1n, allowance: 19n * 10n ** 21n }),
      allowanceGranted: 10n ** 23n,
      ...over,
    });
    expect(await checkHealth('mainnet', deps())).toMatchObject({
      ok: false,
      flags: ['low_gas:base', 'low_near', 'low_allowance'],
      gas: { monad: '1000000000000000000', base: '99999999999999' },
      agent_yocto: '199999999999999999999999',
      allowance_pct: 19,
    });
    const healthy = await checkHealth('testnet', deps({
      gasBalance: async () => 10n ** 18n,
      agent: async () => ({ balance: 2n * 10n ** 23n, allowance: 2n * 10n ** 22n }),
    }));
    expect(healthy).toMatchObject({ ok: true, flags: [], allowance_pct: 20 });
    // An unlimited key has no allowance to run out of; an unreadable chain is a flag.
    const unlimited = await checkHealth('mainnet', deps({
      gasBalance: async (chain) => { if (chain === 'monad') throw new Error('rpc down'); return 10n ** 18n; },
      agent: async () => ({ balance: 10n ** 24n, allowance: null }),
    }));
    expect(unlimited).toMatchObject({ ok: false, flags: ['gas_unreadable:monad'], allowance_pct: null });

    const res = await get('/v1/health', { health: () => checkHealth('mainnet', deps()) });
    expect(res.status).toBe(503);
    expect((await res.json<Record<string, any>>()).flags).toEqual(['low_gas:base', 'low_near', 'low_allowance']);
  });

  it('orders_by_payer_returns_their_orders', async () => {
    await env.DB.prepare(`INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status) VALUES
        (1, 'near', 'alice.testnet', 'monad-testnet', ?1, '1', ?2, 'delivered'), (2, 'near', 'bob.testnet', 'monad-testnet', ?1, '1', ?2, 'open'),
        (3, 'usdc', 'alice.testnet', 'base-sepolia', ?1, '1', ?2, 'open')`).bind(VAULT, T).run();
    const res = await get('/v1/orders?payer=alice.testnet');
    expect(res.status).toBe(200);
    expect((await res.json<{ orders: { id: number }[] }>()).orders.map((o) => o.id)).toEqual([3, 1]);
    expect((await get('/v1/orders?payer=alice.testnet&limit=1').then((r) => r.json<{ orders: unknown[] }>())).orders).toHaveLength(1);
    expect((await get('/v1/orders')).status).toBe(400);
  });

  it('receipt_includes_doc_and_judge_calls', async () => {
    const doc = 'rein-v1|order=5|chain=monad-testnet';
    const hash = keccak256(toBytes(doc));
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status) VALUES
          (5, 'near', 'alice.testnet', 'monad-testnet', ?, '1', ?, 'delivered')`).bind(VAULT, T),
      env.DB.prepare('INSERT INTO docs (hash, order_id, doc) VALUES (?, 5, ?)').bind(hash, doc),
      env.DB.prepare(`INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at, pps_at_post,
          assets_at_post, liquidity_at_post, order_id) VALUES ('monad-testnet', 1, ?, 0, 9000, 1000, ?, ?, '1', '1', '1', 5)`).bind(VAULT, hash, T),
      env.DB.prepare(`INSERT INTO judge_calls (order_id, at, signing_address, cost_usd_micros, stage, failure) VALUES
          (5, ?, '0xsigner', 37, NULL, NULL), (5, ?, '', 37, 'signature', 'HTTP 500')`).bind(T, T + 1),
    ]);
    const body = await (await get('/v1/orders/5')).json<{ posts: { doc: string | null }[]; judge_calls: { at: number; signing_address: string }[] }>();
    expect(body.posts[0].doc).toBe(doc);
    expect(body.judge_calls).toEqual([{ at: T, signing_address: '0xsigner' }]);
  });
});
