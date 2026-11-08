import { decodeFunctionData, parseAbi, parseTransaction, type Hex } from 'viem';
import type { DeskChain } from '../../shared/desk';
import type { DeskClient } from './deskTypes';
import type { NearNetwork } from './env';
import type { PaymentDeps } from './payments';

export interface X402Payment {
  id: string;
  network: NearNetwork;
  origin_network: string;
  deposit_address: string;
  deposit_memo: string;
  operation_token: string;
  resource_url: string;
  chain: DeskChain;
  vault: string;
  amount: string;
  requirements_json: string;
  refund_deadline: string;
  settlement_status: 'quoted' | 'pending' | 'settled' | 'failed';
  settlement_json: string | null;
  state: 'ready' | 'running' | 'credit' | 'delivered' | 'exhausted';
  credit_used: number;
  result_json: string | null;
  result_status: number | null;
}
interface Attempt {
  attempt: number;
  order_id: number | null;
  amount: string;
}
const WAIT_MS = 150_000;
const POLL_MS = 5_000;
const VERDICTS = ['HOLD', 'EXIT', 'MOVE'] as const;
const postAbi = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256 id)',
]);

export const readPayment = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM x402_payments WHERE id = ?').bind(id).first<X402Payment>();

export function paymentResponse(payment: X402Payment, body: unknown, status: number): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (payment.settlement_json) headers['PAYMENT-RESPONSE'] = btoa(payment.settlement_json);
  return new Response(JSON.stringify(body), { status, headers });
}
function savedResponse(payment: X402Payment): Response {
  return paymentResponse(payment, JSON.parse(payment.result_json!), payment.result_status!);
}
const pending = (p: X402Payment, orderId: number | null) =>
  paymentResponse(p, { status: 'pending', paymentRef: p.id, ...(orderId === null ? {} : { orderId }) }, 202);

async function finish(
  db: D1Database,
  p: X402Payment,
  attempt: Attempt,
  status: 'delivered' | 'failed',
  result: unknown,
  httpStatus: number,
) {
  await db.batch([
    db
      .prepare('UPDATE x402_attempts SET status = ? WHERE payment_id = ? AND attempt = ?')
      .bind(status, p.id, attempt.attempt),
    db
      .prepare(
        `UPDATE x402_payments SET state = ?, result_json = ?, result_status = ?
      WHERE id = ? AND state = 'running' AND credit_used = ?`,
      )
      .bind(
        status === 'delivered' ? 'delivered' : attempt.attempt === 0 ? 'credit' : 'exhausted',
        JSON.stringify(result),
        httpStatus,
        p.id,
        attempt.attempt,
      ),
  ]);
}
async function fail(db: D1Database, p: X402Payment, a: Attempt, reason: string, status: number) {
  await finish(
    db,
    p,
    a,
    'failed',
    {
      error: reason,
      paymentRef: p.id,
      ...(a.order_id === null ? {} : { orderId: a.order_id }),
      creditAvailable: a.attempt === 0,
    },
    status,
  );
}

async function refresh(db: D1Database, p: X402Payment, a: Attempt, desk: Pick<DeskClient, 'get_order'>) {
  if (a.order_id === null) return;
  const order = await desk.get_order(a.order_id);
  // Only finished orders can be pruned; their mirrored outcome and purchased result remain recoverable.
  const status =
    order?.status ??
    (await db
      .prepare(
        `SELECT status FROM orders
    WHERE id = ? AND source = 'x402' AND chain = ? AND vault = ?`,
      )
      .bind(a.order_id, p.chain, p.vault)
      .first<string>('status'));
  if (!status) return;
  if (['post_failed', 'rejected', 'refunded'].includes(status)) {
    await fail(db, p, a, status, 502);
  } else if (status === 'delivered') {
    // The broadcast journal is written before sending. It survives delivery clearing the desk's signed tx.
    const raw = await db
      .prepare(
        `SELECT raw_tx FROM broadcast_attempts WHERE network = ? AND order_id = ?
      ORDER BY CASE WHEN receipt_status = 'success' THEN 0 ELSE 1 END, attempted_at DESC LIMIT 1`,
      )
      .bind(p.network, a.order_id)
      .first<string>('raw_tx');
    let verdict: { verdict: string; confidenceBps: number; riskBps: number } | null = null;
    if (raw) {
      const { args } = decodeFunctionData({ abi: postAbi, data: parseTransaction(raw as Hex).data! });
      verdict = { verdict: VERDICTS[args[1]], confidenceBps: args[2], riskBps: args[3] };
    } else {
      // An external broadcaster may have delivered without this Worker's broadcast journal.
      const post = await db
        .prepare(`SELECT verdict, confidence_bps, risk_bps FROM posts WHERE order_id = ? AND chain = ? LIMIT 1`)
        .bind(a.order_id, p.chain)
        .first<{ verdict: number; confidence_bps: number; risk_bps: number }>();
      if (post)
        verdict = { verdict: VERDICTS[post.verdict], confidenceBps: post.confidence_bps, riskBps: post.risk_bps };
    }
    // Until the oracle mirror supplies the purchased verdict, preserve the resumable operation.
    if (!verdict) return;
    await finish(db, p, a, 'delivered', { orderId: a.order_id, signedTx: raw, verdict }, 200);
  }
}

/** Cron closes money states even if the original HTTP connection disappeared. No payment/credit is consumed here. */
export async function reconcileX402(db: D1Database, network: NearNetwork, desk: Pick<DeskClient, 'get_order'>) {
  const payments = await db
    .prepare(
      `SELECT p.* FROM x402_payments p JOIN x402_attempts a
    ON a.payment_id = p.id AND a.attempt = p.credit_used JOIN orders o ON o.id = a.order_id
    WHERE p.network = ? AND p.state = 'running' AND o.status IN ('delivered', 'post_failed', 'rejected', 'refunded')
    AND (o.status != 'delivered' OR EXISTS (SELECT 1 FROM broadcast_attempts b WHERE b.network = p.network AND b.order_id = a.order_id)
      OR EXISTS (SELECT 1 FROM posts s WHERE s.chain = p.chain AND s.order_id = a.order_id))
    ORDER BY a.order_id LIMIT 20`,
    )
    .bind(network)
    .all<X402Payment>();
  for (const p of payments.results) {
    const a = await db
      .prepare('SELECT attempt, order_id, amount FROM x402_attempts WHERE payment_id = ? AND attempt = ?')
      .bind(p.id, p.credit_used)
      .first<Attempt>();
    if (a) await refresh(db, p, a, desk);
  }
}

/** Called under the per-operation renewable lock. The desk independently deduplicates each attempt's reference. */
export async function runPaidJudgement(
  db: D1Database,
  p: X402Payment,
  deps: PaymentDeps,
  redeemCredit: boolean,
): Promise<Response> {
  if (p.state === 'delivered' || p.state === 'exhausted' || (p.state === 'credit' && !redeemCredit))
    return savedResponse(p);
  if (p.state === 'credit') {
    const admission = await deps.desk.check_x402_request(p.chain, p.vault);
    if (admission !== 'ok') return paymentResponse(p, { error: admission, creditAvailable: true }, 422);
    const policy = await deps.desk.policy();
    await db.batch([
      db
        .prepare(
          `UPDATE x402_payments SET state = 'running', credit_used = 1, result_json = NULL, result_status = NULL
        WHERE id = ? AND state = 'credit' AND credit_used = 0`,
        )
        .bind(p.id),
      db
        .prepare(
          `INSERT OR IGNORE INTO x402_attempts (payment_id, attempt, amount)
        SELECT id, 1, ? FROM x402_payments WHERE id = ? AND state = 'running' AND credit_used = 1`,
        )
        .bind(policy.price_usdc, p.id),
    ]);
  } else if (p.state === 'ready') {
    await db.batch([
      db.prepare("UPDATE x402_payments SET state = 'running' WHERE id = ? AND state = 'ready'").bind(p.id),
      db
        .prepare('INSERT OR IGNORE INTO x402_attempts (payment_id, attempt, amount) VALUES (?, 0, ?)')
        .bind(p.id, p.amount),
    ]);
  }
  p = (await readPayment(db, p.id))!;
  const a = (await db
    .prepare('SELECT attempt, order_id, amount FROM x402_attempts WHERE payment_id = ? AND attempt = ?')
    .bind(p.id, p.credit_used)
    .first<Attempt>())!;
  if (a.order_id === null) {
    try {
      // Same reference on every recovery, including a lost response after successful NEAR execution.
      a.order_id = await deps.desk.submit_x402_request(p.chain, p.vault, `${p.id}#${a.attempt}`, a.amount);
      await db
        .prepare("UPDATE x402_attempts SET order_id = ?, status = 'open' WHERE payment_id = ? AND attempt = ?")
        .bind(a.order_id, p.id, a.attempt)
        .run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const refused = /Smart contract panicked:\s*([^\n]+)/.exec(message)?.[1];
      if (!refused) return pending(p, null); // Transport ambiguity is not a refusal; retry the identical reference.
      await fail(db, p, a, refused.slice(0, 200), 422);
      return savedResponse((await readPayment(db, p.id))!);
    }
  }
  const until = deps.now() + WAIT_MS;
  for (;;) {
    await refresh(db, p, a, deps.desk);
    const current = (await readPayment(db, p.id))!;
    if (current.result_json) return savedResponse(current);
    if (deps.now() >= until) return pending(current, a.order_id);
    try {
      await deps.tick();
    } catch {
      // The order loop has its own durable broadcast/recovery journal. A request retry resumes this order.
    }
    await refresh(db, p, a, deps.desk);
    const afterTick = (await readPayment(db, p.id))!;
    if (afterTick.result_json) return savedResponse(afterTick);
    await deps.sleep(POLL_MS);
  }
}
