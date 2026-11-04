import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem';
import type { DeskChain } from '../../shared/desk';
import { erc4626Abi } from './abis';
import { handle } from './api';
import { CHAINS, viemChain } from './broadcast';
import type { DeskClient, DeskOrder } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';
import { gradeDue, realGradeDeps, type GradeDeps } from './grade';
import { checkHealth, type HealthDeps } from './health';
import { judge } from './judge';
import { withLock } from './lock';
import { mirror, realMirrorDeps, type MirrorDeps } from './mirror';
import { processOrder, type ChainClient, type OrderDeps, type OrderOutcome } from './order';
import { readVault } from './vendor/vaultReader';
import { netOutPct1h, realWatchDeps, watchOnce, type WatchDeps } from './watch';

const OPEN_LIMIT = 20;
const SCAN_LIMIT = 100;
/** Orders one runner takes per chain per tick; the rest wait for the next minute. */
const PER_CHAIN = 10;
/** A cron invocation can run 15 minutes, so a lock this old has no live holder. */
const LOCK_TTL_S = 900;

const FINAL = new Set(['delivered', 'rejected', 'refunded']);
const IN_FLIGHT = new Set(['exit_pending', 'signing', 'signed']);

/**
 * Open orders, plus every order the desk has in flight. In-flight orders are found by scanning `list_orders` from
 * the lowest id that wasn't final last time; the scan moves that mark up past finished orders.
 */
async function ordersToWork(db: D1Database, desk: DeskClient, network: NearNetwork): Promise<DeskOrder[]> {
  const key = `low:${network}`;
  const from = (await db.prepare('SELECT value FROM cursors WHERE key = ?').bind(key).first<number>('value')) ?? 0;
  const [open, page] = await Promise.all([desk.open_orders(OPEN_LIMIT), desk.list_orders(from, SCAN_LIMIT)]);
  let low = from;
  let advancing = true;
  const byId = new Map(open.map((o) => [o.id, o]));
  for (const o of page) {
    if (FINAL.has(o.status)) {
      if (advancing) low = o.id + 1;
      continue;
    }
    advancing = false;
    if (IN_FLIGHT.has(o.status)) byId.set(o.id, o);
  }
  if (low !== from) {
    await db.prepare('INSERT INTO cursors (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2').bind(key, low).run();
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function realDeps(env: Env, desk: DeskClient): OrderDeps {
  const chains = new Map<DeskChain, ChainClient>();
  return {
    desk,
    async read(c, vault) {
      const client = createPublicClient({ chain: CHAINS[c], transport: http(rpcFor(env, c), { retryCount: 2 }) });
      const [block, name, stats, prev] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: vault as Address, abi: erc4626Abi, functionName: 'name' }),
        readVault(env, c, { address: vault, mirror: c === 'monad-testnet' }, { client }),
        env.DB.prepare('SELECT apy_bps FROM watch_snapshots WHERE chain = ? AND vault = ? ORDER BY at DESC LIMIT 1')
          .bind(c, vault.toLowerCase()).first<number | null>('apy_bps'),
      ]);
      // Vaults without an APY source read as 0, as the watch feed has no APY for them either.
      const apyBps = stats.apyBps ?? 0;
      return { block, name, pps: stats.pps, totalAssets: stats.totalAssets, liquidityPct: stats.liquidityPct, apyBps, apyBpsPrev: prev ?? apyBps, utilBps: stats.utilBps };
    },
    flows: async (c, vault) => ({ netOutPct1h: await netOutPct1h(env.DB, c, vault, Math.floor(Date.now() / 1000)) }),
    judge: async (doc, prompt, opts) => {
      const j = await judge(doc, prompt, { ...opts, apiKey: env.NEAR_AI_API_KEY });
      const orderId = Number(/\|order=(\d+)\|/.exec(doc)?.[1] ?? -1);
      await env.DB.batch([
        env.DB.prepare('INSERT INTO judge_calls (order_id, at, signing_address, cost_usd_micros) VALUES (?, ?, ?, ?)')
          .bind(orderId, Math.floor(Date.now() / 1000), j.signingAddress, j.costUsdMicros),
        // The oracle post commits to keccak256(doc); this leads the mirrored post back to its order and doc.
        env.DB.prepare('INSERT OR IGNORE INTO docs (hash, order_id, doc) VALUES (?, ?, ?)').bind(keccak256(toBytes(doc)), orderId, doc),
      ]);
      return j;
    },
    chain: (c) => {
      let client = chains.get(c);
      if (!client) chains.set(c, (client = viemChain(c, rpcFor(env, c))));
      return client;
    },
    now: () => Math.floor(Date.now() / 1000),
    alert: async (msg) => { console.error(`ALERT ${msg}`); },
  };
}

/** One pass over the desk: every order it can advance, one runner per chain. */
export async function tick(env: Env, network: NearNetwork, deps: OrderDeps): Promise<Record<string, OrderOutcome | 'busy' | 'error'>> {
  const orders = await ordersToWork(env.DB, deps.desk, network);
  const byChain = new Map<DeskChain, DeskOrder[]>();
  for (const o of orders) byChain.set(o.chain, [...(byChain.get(o.chain) ?? []), o]);

  const result: Record<string, OrderOutcome | 'busy' | 'error'> = {};
  await Promise.all([...byChain].map(async ([chain, list]) => {
    const run = await withLock(env.DB, `chain:${network}:${chain}`, LOCK_TTL_S, async () => {
      for (const order of list.slice(0, PER_CHAIN)) {
        try {
          result[order.id] = await processOrder(order, deps);
        } catch (e) {
          console.error(`order ${order.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          result[order.id] = 'error';
        }
      }
    });
    if (!run.ran) for (const o of list) result[o.id] = 'busy';
  }));
  return result;
}

export interface CronDeps {
  order: OrderDeps;
  mirror: MirrorDeps;
  grade: GradeDeps;
  watch: WatchDeps;
}

async function realCronDeps(env: Env): Promise<CronDeps> {
  // Loaded on first use: @near-js pulls in CommonJS crypto that the Vitest workerd runner can't load.
  const { nearDesk } = await import('./near');
  const desk = nearDesk(env);
  return { order: realDeps(env, desk), mirror: realMirrorDeps(env, desk), grade: realGradeDeps(env), watch: realWatchDeps(env, desk) };
}

async function realHealthDeps(env: Env): Promise<HealthDeps> {
  const { agentStatus, nearDesk } = await import('./near');
  return {
    derivedAddress: () => nearDesk(env).derived_address(),
    gasBalance: (chain, address) => createPublicClient({ chain: CHAINS[chain], transport: http(rpcFor(env, chain)) }).getBalance({ address: address as Address }),
    agent: () => agentStatus(env),
    allowanceGranted: env.AGENT_KEY_ALLOWANCE ? BigInt(env.AGENT_KEY_ALLOWANCE) : null,
  };
}

const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | 'error'> => {
  try {
    return await fn();
  } catch (e) {
    console.error(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    return 'error';
  }
};

/**
 * Everything one cron minute does: advance orders, mirror orders and posts, grade what is due, then the watch feed.
 * Each step works from stored state, so running it twice at once or back to back does nothing twice.
 */
export async function runAll(env: Env, network: NearNetwork, now: number, deps: CronDeps) {
  const orders = await step('orders', () => tick(env, network, deps.order));
  const mirrored = await step('mirror', () => mirror(env, network, deps.mirror, now));
  const graded = await step('grade', async () => {
    const run = await withLock(env.DB, `grade:${network}`, LOCK_TTL_S, () => gradeDue(env, network, now, deps.grade));
    return run.ran ? run.value : 'busy';
  });
  const watched = await step('watch', async () => {
    const run = await withLock(env.DB, `watch:${network}`, LOCK_TTL_S, () => watchOnce(env, network, now, deps.watch));
    return run.ran ? run.value : 'busy';
  });
  return { orders, mirror: mirrored, grade: graded, watch: watched };
}

const nowS = () => Math.floor(Date.now() / 1000);

export default {
  async fetch(request, env) {
    return handle(request, env, {
      kick: async () => runAll(env, env.NEAR_NETWORK, nowS(), await realCronDeps(env)),
      health: async () => checkHealth(env.NEAR_NETWORK, await realHealthDeps(env)),
      payments: async () => {
        const deps = await realCronDeps(env);
        return {
          fetch: (input, init) => fetch(input, init),
          desk: deps.order.desk,
          tick: () => tick(env, env.NEAR_NETWORK, deps.order),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          now: () => Date.now(),
        };
      },
    });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(realCronDeps(env).then((deps) => runAll(env, env.NEAR_NETWORK, nowS(), deps)));
  },
} satisfies ExportedHandler<Env>;
