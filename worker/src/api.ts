import { Hono, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { DeskChain } from '../../shared/desk';
import { CRON_INTERVAL_S } from './health';
import { RESOLVE_WINDOW_S, SAMPLE_WINDOW_S } from './vendor/cadence';
import type { DeskStats } from '../../shared/desk';
import { changeSubscription } from './alerts';
import { economics } from './economics';
import { brierSeries, newCalls, scoreLedger, type ScoreVerdict } from '../../shared/score';
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
const ORDERS_PAGE = 20;
const ORDERS_MAX = 50;

async function kickAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const provided = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([provided, token].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a, b);
}

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
  sampled: number;
  resolved_at: number | null;
  doc: string | null;
  signer: string | null;
}

const json = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
    { status, headers: { 'content-type': 'application/json' } },
  );

/** Sales and refunds from the desk, plus what judging cost and how orders and watch requests went. */
async function business(env: Env) {
  const db = env.DB;
  const [stats, cost, orders, watch] = await Promise.all([
    db.prepare(`SELECT json, at FROM meta WHERE key = 'desk_stats'`).first<{ json: string; at: number }>(),
    db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd_micros), 0) AS micros FROM judge_calls')
      .first<{ calls: number; micros: number }>(),
    db
      .prepare('SELECT source, status, COUNT(*) AS n FROM orders GROUP BY source, status ORDER BY source, status')
      .all<{ source: string; status: string; n: number }>(),
    db
      .prepare('SELECT COUNT(*) AS asked, COUNT(order_id) AS opened FROM watch_requests')
      .first<{ asked: number; opened: number }>(),
  ]);
  return {
    desk: stats ? { ...JSON.parse(stats.json), as_of: stats.at } : null,
    judge_calls: cost?.calls ?? 0,
    judge_cost_usd_micros: cost?.micros ?? 0,
    orders: orders.results,
    watch: { asked: watch?.asked ?? 0, opened: watch?.opened ?? 0 },
    ...(await economics(db, stats ? (JSON.parse(stats.json) as DeskStats) : null)),
  };
}

/** Every post on the network's chains, oldest first, in the shape the scorer reads. */
async function ledgerRows(env: Env, network: NearNetwork) {
  const chains = NETWORK_CHAINS[network];
  const { results } = await env.DB.prepare(
    `SELECT p.chain, p.id, p.vault, p.verdict, p.confidence_bps, p.risk_bps, p.posted_at, p.order_id, p.input_check,
        p.resolved, p.adverse, p.reasons, p.sampled, p.resolved_at, d.doc,
        (SELECT j.signing_address FROM judge_calls j WHERE j.order_id = p.order_id AND j.failure IS NULL
          ORDER BY j.at DESC LIMIT 1) AS signer
      FROM posts p LEFT JOIN docs d ON d.hash = p.state_hash
      WHERE p.chain IN (${chains.map(() => '?').join(', ')}) ORDER BY p.posted_at, p.chain, p.id`,
  )
    .bind(...chains)
    .all<PostRow>();
  return results.map((r) => ({
    ...r,
    verdict: VERDICTS[r.verdict] ?? 'HOLD',
    postedAt: r.posted_at,
    confidenceBps: r.confidence_bps,
    riskBps: r.risk_bps,
    resolved: r.resolved === 1,
    adverse: r.adverse === null ? null : r.adverse === 1,
    resolvedAt: r.resolved_at,
  }));
}

async function ledger(env: Env, network: NearNetwork) {
  const rows = await ledgerRows(env, network);
  const calls = newCalls(rows);
  const now = Math.floor(Date.now() / 1000);
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
    recent: rows
      .slice(-LEDGER_POSTS)
      .reverse()
      .map((r) => ({
        chain: r.chain,
        id: r.id,
        vault: r.vault,
        verdict: r.verdict,
        confidence_bps: r.confidence_bps,
        risk_bps: r.risk_bps,
        posted_at: r.posted_at,
        order_id: r.order_id,
        input_check: r.input_check,
        resolved: r.resolved,
        adverse: r.adverse,
        reasons: r.reasons,
        doc: r.doc,
        signer: r.signer,
        repeat: !isNew.has(r),
        ...gradeQuality(r, now),
      })),
  };
}

function gradeQuality(
  row: Omit<PostRow, 'resolved' | 'adverse' | 'verdict'> & { resolved: boolean | number },
  now: number,
) {
  const chain = row.chain as DeskChain;
  const due = row.posted_at + RESOLVE_WINDOW_S[chain] + SAMPLE_WINDOW_S[chain];
  const quality: string[] = [];
  if (!row.resolved && now >= due) quality.push('unresolved');
  if (row.resolved_at !== null && row.resolved_at > due + CRON_INTERVAL_S) quality.push('late');
  if (SAMPLE_WINDOW_S[chain] > 0 && now >= due && row.sampled < 2) quality.push('degraded');
  return {
    grading_quality: quality,
    grade_due_s: due,
    resolved_at: row.resolved_at,
    grading_time_unknown: !!row.resolved && row.resolved_at === null,
  };
}

type ApiEnv = { Bindings: Env & { deps: ApiDeps } };

const requireKickToken: MiddlewareHandler<ApiEnv> = async (c, next) => {
  if (!(await kickAuthorized(c.req.raw, c.env.KICK_TOKEN))) return json({ error: 'unauthorized' }, 401);
  await next();
};

const limitQuote: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const { success } = await c.env.QUOTE_RATE_LIMITER.limit({ key: c.req.header('CF-Connecting-IP') ?? 'unknown' });
  if (!success) {
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '60' },
    });
  }
  await next();
};

const app = new Hono<ApiEnv>({ strict: true });
// Browsers subscribe to EXIT alerts from the site's own origin. These routes carry no credentials.
app.use('/v1/alerts/*', cors({ origin: '*', allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'] }));
const POST_PATHS = ['/v1/kick', '/v1/quote', '/v1/x402/judge', '/v1/alerts/subscribe', '/v1/alerts/unsubscribe'];
const methodNotAllowed = (allow: string) => {
  const response = json({ error: 'method not allowed' }, 405);
  response.headers.set('Allow', allow);
  return response;
};

// Hono otherwise serves HEAD using GET; this API has always rejected HEAD.
app.use('*', async (c, next) => {
  if (c.req.method === 'HEAD') return methodNotAllowed(POST_PATHS.includes(c.req.path) ? 'POST' : 'GET');
  await next();
});
app.onError((error, c) => {
  console.error('API request failed', { path: new URL(c.req.url).pathname, error });
  return json({ error: 'internal error' }, 500);
});
app.notFound(() => json({ error: 'not found' }, 404));

app.post('/v1/kick', requireKickToken, async (c) => json(await c.env.deps.kick()));
app.post('/v1/quote', limitQuote, async (c) => quote(c.req.raw, await c.env.deps.payments()));
app.post('/v1/x402/judge', async (c) => x402Judge(c.req.raw, c.env, await c.env.deps.payments()));
for (const [path, on] of [
  ['/v1/alerts/subscribe', true],
  ['/v1/alerts/unsubscribe', false],
] as const) {
  app.post(path, limitQuote, async (c) => {
    if (!c.env.VAPID_PUBLIC_KEY) return json({ error: 'alerts are off' }, 503);
    const body = await c.req.json().catch(() => null);
    const r = await changeSubscription(c.env.DB, c.env.NEAR_NETWORK, body, on, Math.floor(Date.now() / 1000));
    return json(r.body, r.status);
  });
}
for (const path of POST_PATHS) app.all(path, () => methodNotAllowed('POST'));

app.get('/v1/ledger', async (c) => {
  const network = (c.req.query('network') ?? c.env.NEAR_NETWORK) as NearNetwork;
  if (!Object.hasOwn(NETWORK_CHAINS, network)) return json({ error: 'network must be testnet or mainnet' }, 400);
  return json(await ledger(c.env, network));
});
/** The running Brier score over every resolved call, for the Ledger's chart; /v1/ledger lists only recent posts. */
app.get('/v1/ledger/brier', async (c) => {
  const network = (c.req.query('network') ?? c.env.NEAR_NETWORK) as NearNetwork;
  if (!Object.hasOwn(NETWORK_CHAINS, network)) return json({ error: 'network must be testnet or mainnet' }, 400);
  return json({ network, points: brierSeries(newCalls(await ledgerRows(c.env, network))) });
});
/** A NEAR account's orders, newest first. */
app.get('/v1/orders', async (c) => {
  const payer = c.req.query('payer');
  if (!payer) return json({ error: 'payer required' }, 400);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || ORDERS_PAGE, 1), ORDERS_MAX);
  const { results } = await c.env.DB.prepare('SELECT * FROM orders WHERE payer = ? ORDER BY id DESC LIMIT ?')
    .bind(payer, limit)
    .all();
  return json({ orders: results });
});
/** An order's receipt: each post with the doc the model read, the judge calls that returned a signed answer, and the post's transaction. */
app.get('/v1/orders/:id{[0-9]+}', async (c) => {
  const id = Number(c.req.param('id'));
  const row = await c.env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  const [{ results: posts }, { results: judgeCalls }, landed] = await Promise.all([
    c.env.DB.prepare(
      `SELECT p.chain, p.id, p.verdict, p.confidence_bps, p.risk_bps, p.state_hash, p.posted_at, p.input_check,
        p.sampled, p.resolved, p.adverse, p.reasons, d.doc FROM posts p LEFT JOIN docs d ON d.hash = p.state_hash
        WHERE p.order_id = ? ORDER BY p.chain, p.id`,
    )
      .bind(id)
      .all<{ verdict: number }>(),
    c.env.DB.prepare('SELECT at, signing_address FROM judge_calls WHERE order_id = ? AND failure IS NULL ORDER BY at')
      .bind(id)
      .all(),
    c.env.DB.prepare(
      "SELECT hash FROM broadcast_attempts WHERE order_id = ? AND chain = ? AND receipt_status = 'success' LIMIT 1",
    )
      .bind(id, row.chain)
      .first<{ hash: string }>(),
  ]);
  return json({
    ...row,
    posts: posts.map((p) => ({ ...p, verdict: VERDICTS[p.verdict] ?? p.verdict })),
    judge_calls: judgeCalls,
    // The EVM transaction that landed the post, once its receipt is known.
    post_tx: landed?.hash ?? null,
  });
});
/** The VAPID public key a browser subscribes with; null while alerts are off. */
app.get('/v1/alerts/key', (c) => json({ key: c.env.VAPID_PUBLIC_KEY ?? null }));
app.get('/v1/quote/status', async (c) => quoteStatus(new URL(c.req.url), await c.env.deps.payments()));
app.get('/v1/stats', async (c) => json(await business(c.env)));
app.get('/v1/health', async (c) => {
  const h = await c.env.deps.health();
  return json(h, h.ok ? 200 : 503);
});
app.all('*', (c) => (c.req.method === 'GET' ? c.notFound() : methodNotAllowed('GET')));

/** The Worker's HTTP API. */
export async function handle(request: Request, env: Env, deps: ApiDeps): Promise<Response> {
  return app.fetch(request, { ...env, deps });
}
