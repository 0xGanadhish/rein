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
import type { OraclePost } from '../src/mirror';

const T = 1_793_774_400;
const VAULT = '0x00000000000000000000000000000000000000aa';
const STATS: DeskStats = { sales_near: '3000000000000000000000000', sales_usdc: '2000000', sales_x402_usdc: '1000000', refunds: 1, open_paid: 0 };
const TABLES = ['orders', 'docs', 'posts', 'watch_snapshots', 'watch_baselines', 'watch_requests', 'meta', 'cursors', 'judge_calls', 'locks'];

const get = (path: string, deps: Partial<ApiDeps> = {}) =>
  handle(new Request(`https://rein.test${path}`), env, { kick: async () => ({}), health: async () => { throw new Error('unused'); }, ...deps });

describe('api', () => {
  beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  beforeEach(async () => { await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`))); });

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
    expect(body.business).toEqual({
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
    const order: DeskOrder = { id: 5, source: 'near', payer: 'alice.testnet', chain: 'monad-testnet', vault: VAULT, amount: '1', created_s: T - 3700, status: 'delivered' };
    const onchainPost: OraclePost = {
      vault: VAULT, verdict: 0, confidenceBps: 9000, riskBps: 500, stateHash: keccak256(toBytes(doc)), postedAt: BigInt(T - 3600),
      ppsAtPost: 1_000_000n, assetsAtPost: 5_000_000n, liquidityAtPost: maxUint256,
    };
    const calls: string[] = [];
    let resolved = false;
    const desk = {
      open_orders: async () => [],
      list_orders: async (from: number) => (from <= 5 ? [order] : []),
      stats: async () => STATS,
      menu: async () => [VAULT],
      submit_watch_request: async () => { calls.push('submit_watch_request'); return 6; },
    };
    const deps: CronDeps = {
      order: { desk: desk as never, read: null!, flows: null!, judge: null!, chain: null!, now: () => T, alert: async () => {} },
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
    const kick = () => handle(new Request('https://rein.test/v1/kick', { method: 'POST' }), env, { kick: () => runAll(env, 'testnet', T, deps), health: null! });
    const dump = async () => Promise.all(['orders', 'posts', 'watch_snapshots', 'watch_baselines', 'watch_requests'].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results));

    const first = await (await kick()).json();
    expect(first).toEqual({
      orders: {},
      mirror: { orders: 1, posts: 1 },
      grade: { 'monad-testnet': { sampled: 0, sent: 1, synced: 0, failed: 0, unsampled: 0 } },
      watch: { snapshots: 1, submitted: 0, refused: 0, failed: 0 },
    });
    const after = await dump();

    const second = await (await kick()).json();
    expect(second).toEqual({
      orders: {},
      mirror: { orders: 0, posts: 0 },
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
    expect(await checkHealth('mainnet', deps())).toEqual({
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
});
