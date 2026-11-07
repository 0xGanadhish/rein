import { createPublicClient, http, keccak256, toBytes, type Address } from 'viem';
import type { DeskChain } from '../../shared/desk';
import { erc4626Abi } from './abis';
import { handle } from './api';
import { CHAINS, viemChain } from './broadcast';
import { NETWORK_CHAINS, type DeskClient, type DeskOrder } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';
import { gradeDue, realGradeDeps, type GradeDeps } from './grade';
import { checkHealth, type HealthDeps } from './health';
import { judge } from './judge';
import { BroadcastJournal } from './journal';
import { withLock } from './lock';
import { mirror, realMirrorDeps, type MirrorDeps } from './mirror';
import { orderReady, processOrder, type ChainClient, type OrderDeps, type OrderOutcome } from './order';
import { rememberSignedTx } from './payments';
import { readVault } from './vendor/vaultReader';
import { netOutPct1h, realWatchDeps, watchOnce, type WatchDeps } from './watch';

const OPEN_LIMIT = 20;
const SCAN_LIMIT = 100;
/** Orders one runner takes per chain per tick; the rest wait for the next minute. */
const PER_CHAIN = 10;
/** A cron invocation can run 15 minutes, so a lock this old has no live holder. */
const LOCK_TTL_S = 900;

/**
 * Merge active orders with a rotating ID window. Reserve one slot for the active-order fast path;
 * use the rest for scan progress, sharing spare capacity without skipping deferred work.
 */
async function ordersToWork(db: D1Database, desk: DeskClient, network: NearNetwork, chain: DeskChain, now: number) {
  const key = `work:${network}:${chain}`;
  const [saved, bound, policy, open] = await Promise.all([
    db.prepare('SELECT value FROM cursors WHERE key = ?').bind(key).first<number>('value'),
    desk.next_order_id(),
    desk.policy(),
    desk.open_orders(OPEN_LIMIT),
  ]);
  const from = (saved ?? 0) < bound ? saved ?? 0 : 0;
  const page = from < bound ? await desk.list_orders(from, Math.min(SCAN_LIMIT, bound - from)) : [];
  const scanned = page.filter((o) => o.chain === chain && orderReady(o, now, policy)).sort((a, b) => a.id - b.id);
  const active = open.filter((o) => o.chain === chain && orderReady(o, now, policy));
  const selected = new Map<number, DeskOrder>();
  for (const order of scanned.slice(0, PER_CHAIN - 1)) selected.set(order.id, order);
  for (const candidates of [active, scanned]) {
    for (const order of candidates) {
      if (selected.size === PER_CHAIN) break;
      if (!selected.has(order.id)) selected.set(order.id, order);
    }
  }
  // Fast-path IDs may be far ahead of the window; they must not move its cursor past deferred orders.
  const deferred = scanned.find((o) => !selected.has(o.id));
  const end = deferred?.id ?? Math.min(from + SCAN_LIMIT, bound);
  const next = end < bound ? end : 0;
  const orders: DeskOrder[] = [];
  // Start active work before waiting for receipts from the historical scan.
  for (const order of active) {
    if (selected.delete(order.id)) orders.push(order);
  }
  orders.push(...selected.values());
  return { key, orders, next };
}

function realDeps(env: Env, desk: DeskClient): OrderDeps {
  const chains = new Map<DeskChain, ChainClient>();
  return {
    desk,
    journal: new BroadcastJournal(env.DB, env.NEAR_NETWORK),
    async read(c, vault) {
      const client = createPublicClient({ chain: CHAINS[c], transport: http(rpcFor(env, c), { retryCount: 2 }) });
      const [block, name, stats, prev] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({ address: vault as Address, abi: erc4626Abi, functionName: 'name' }),
        readVault(env, c, { address: vault, mirror: c === 'monad-testnet' || c === 'base-sepolia' }, { client }),
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
  const result: Record<string, OrderOutcome | 'busy' | 'error'> = {};
  await Promise.all(NETWORK_CHAINS[network].map(async (chain) => {
    const run = await withLock(env.DB, `chain:${network}:${chain}`, LOCK_TTL_S, async () => {
      const { key, orders, next } = await ordersToWork(env.DB, deps.desk, network, chain, deps.now());
      for (const order of orders) {
        try {
          result[order.id] = await processOrder(order, deps);
        } catch (e) {
          console.error(`order ${order.id}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
          result[order.id] = 'error';
        }
      }
      await env.DB.prepare('INSERT INTO cursors (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2').bind(key, next).run();
    });
    if (!run.ran) {
      const { orders } = await ordersToWork(env.DB, deps.desk, network, chain, deps.now());
      for (const o of orders) result[o.id] = 'busy';
    }
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
  // One desk per request, shared by the order loop and the x402 route, so a signed tx read by one is seen by both.
  const desk = rememberSignedTx(nearDesk(env));
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
