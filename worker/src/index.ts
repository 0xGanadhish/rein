import { viemChain } from './broadcast';
import type { DeskChain, DeskClient, DeskOrder } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';
import { judge } from './judge';
import { withLock } from './lock';
import { processOrder, type ChainClient, type OrderDeps, type OrderOutcome } from './order';

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

async function realDeps(env: Env): Promise<OrderDeps> {
  // Loaded on first use: @near-js pulls in CommonJS crypto that the Vitest workerd runner can't load.
  const { nearDesk } = await import('./near');
  const chains = new Map<DeskChain, ChainClient>();
  return {
    desk: nearDesk(env),
    read: async () => { throw new Error('vault reader not wired'); },
    flows: async () => { throw new Error('flow reader not wired'); },
    judge: async (doc, prompt, opts) => {
      const j = await judge(doc, prompt, { ...opts, apiKey: env.NEAR_AI_API_KEY });
      const orderId = Number(/\|order=(\d+)\|/.exec(doc)?.[1] ?? -1);
      await env.DB.prepare('INSERT INTO judge_calls (order_id, at, signing_address, cost_usd_micros) VALUES (?, ?, ?, ?)')
        .bind(orderId, Math.floor(Date.now() / 1000), j.signingAddress, j.costUsdMicros).run();
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
export async function tick(env: Env, network: NearNetwork, given?: OrderDeps): Promise<Record<string, OrderOutcome | 'busy' | 'error'>> {
  const deps = given ?? await realDeps(env);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/kick') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
      return Response.json({ orders: await tick(env, env.NEAR_NETWORK) });
    }
    return new Response('not found', { status: 404 });
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(tick(env, env.NEAR_NETWORK));
  },
} satisfies ExportedHandler<Env>;
