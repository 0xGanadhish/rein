import { newCalls, scoreLedger, type ScoreVerdict } from '../../shared/score';
import { NETWORK_CHAINS } from './deskTypes';
import type { Env, NearNetwork } from './env';
import type { Health } from './health';
import { quote, quoteStatus, x402Judge, type PaymentDeps } from './payments';

export interface ApiDeps {
  /** One pass of everything the cron does. */
  kick(): Promise<unknown>;
  health(): Promise<Health>;
  payments(): Promise<PaymentDeps>;
}

const VERDICTS: ScoreVerdict[] = ['HOLD', 'EXIT', 'MOVE'];
const LEDGER_POSTS = 200;

interface PostRow {
  chain: string;
  id: number;
  vault: string;
  verdict: number;
  confidence_bps: number;
  risk_bps: number;
  posted_at: number;
  order_id: number | null;
  input_check: string;
  resolved: number;
  adverse: number | null;
  reasons: number | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), { status, headers: { 'content-type': 'application/json' } });

/** Sales and refunds from the desk, plus what judging cost and how orders and watch requests went. */
async function business(env: Env) {
  const db = env.DB;
  const [stats, cost, orders, watch] = await Promise.all([
    db.prepare(`SELECT json, at FROM meta WHERE key = 'desk_stats'`).first<{ json: string; at: number }>(),
    db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS micros FROM judge_calls').first<{ calls: number; micros: number }>(),
    db.prepare('SELECT source, status, COUNT(*) AS n FROM orders GROUP BY source, status ORDER BY source, status').all<{ source: string; status: string; n: number }>(),
    db.prepare('SELECT COUNT(*) AS asked, COUNT(order_id) AS opened FROM watch_requests').first<{ asked: number; opened: number }>(),
  ]);
  return {
    desk: stats ? { ...JSON.parse(stats.json), as_of: stats.at } : null,
    judge_calls: cost?.calls ?? 0,
    judge_cost_usd_micros: cost?.micros ?? 0,
    orders: orders.results,
    watch: { asked: watch?.asked ?? 0, opened: watch?.opened ?? 0 },
  };
}

async function ledger(env: Env, network: NearNetwork) {
  const chains = NETWORK_CHAINS[network];
  const { results } = await env.DB.prepare(`SELECT chain, id, vault, verdict, confidence_bps, risk_bps, posted_at, order_id, input_check, resolved, adverse, reasons
      FROM posts WHERE chain IN (${chains.map(() => '?').join(', ')}) ORDER BY posted_at, chain, id`).bind(...chains).all<PostRow>();
  const rows = results.map((r) => ({
    ...r,
    verdict: VERDICTS[r.verdict] ?? 'HOLD',
    postedAt: r.posted_at,
    confidenceBps: r.confidence_bps,
    riskBps: r.risk_bps,
    resolved: r.resolved === 1,
    adverse: r.adverse === null ? null : r.adverse === 1,
  }));
  const calls = newCalls(rows);
  const isNew = new Set(calls);
  return {
    network,
    score: scoreLedger(calls),
    posts: rows.length,
    calls: calls.length,
    input_checks: {
      match: rows.filter((r) => r.input_check === 'match').length,
      mismatch: rows.filter((r) => r.input_check === 'mismatch').length,
      unknown: rows.filter((r) => r.input_check === 'unknown').length,
    },
    business: await business(env),
    recent: rows.slice(-LEDGER_POSTS).reverse().map((r) => ({
      chain: r.chain, id: r.id, vault: r.vault, verdict: r.verdict, confidence_bps: r.confidence_bps, risk_bps: r.risk_bps,
      posted_at: r.posted_at, order_id: r.order_id, input_check: r.input_check, resolved: r.resolved, adverse: r.adverse,
      reasons: r.reasons, repeat: !isNew.has(r),
    })),
  };
}

/** The Worker's HTTP API. */
export async function handle(request: Request, env: Env, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/v1/kick') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
    return json(await deps.kick());
  }
  const post = (handler: () => Promise<Response>) =>
    request.method === 'POST' ? handler() : new Response('method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (path === '/v1/quote') return post(async () => quote(request, await deps.payments()));
  if (path === '/v1/x402/judge') return post(async () => x402Judge(request, env, await deps.payments()));
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { Allow: 'GET' } });

  if (path === '/v1/ledger') {
    const network = (url.searchParams.get('network') ?? env.NEAR_NETWORK) as NearNetwork;
    if (!Object.hasOwn(NETWORK_CHAINS, network)) return json({ error: 'network must be testnet or mainnet' }, 400);
    return json(await ledger(env, network));
  }
  const order = /^\/v1\/orders\/(\d+)$/.exec(path);
  if (order) {
    const id = Number(order[1]);
    const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not found' }, 404);
    const { results: posts } = await env.DB.prepare(`SELECT chain, id, verdict, confidence_bps, risk_bps, state_hash, posted_at, input_check,
        sampled, resolved, adverse, reasons FROM posts WHERE order_id = ? ORDER BY chain, id`).bind(id).all<{ verdict: number }>();
    return json({ ...row, posts: posts.map((p) => ({ ...p, verdict: VERDICTS[p.verdict] ?? p.verdict })) });
  }
  if (path === '/v1/quote/status') return quoteStatus(url, await deps.payments());
  if (path === '/v1/stats') return json(await business(env));
  if (path === '/v1/health') {
    const h = await deps.health();
    return json(h, h.ok ? 200 : 503);
  }
  return new Response('not found', { status: 404 });
}
