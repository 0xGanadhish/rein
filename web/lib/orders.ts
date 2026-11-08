import type { DeskOrder, DeskPolicy } from '../../shared/desk';

/**
 * The order id a payment opened: `request_judgement` returns it, and the desk logs "order N opened" from `ft_on_transfer`.
 * Null when the wallet didn't hand back an outcome.
 */
export function orderIdFrom(outcome: unknown): number | null {
  const o = outcome as
    { status?: { SuccessValue?: string }; receipts_outcome?: { outcome?: { logs?: string[] } }[] } | undefined;
  for (const r of o?.receipts_outcome ?? []) {
    for (const log of r.outcome?.logs ?? []) {
      const m = /^order (\d+) opened$/.exec(log);
      if (m) return Number(m[1]);
    }
  }
  const v = o?.status?.SuccessValue;
  if (v) {
    const n = Number(atob(v));
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Whether anyone may call the desk's `refund` on this order now, on the desk's own terms: an open order after its
 * deadline or under the kill switch, a signed one only once its post has expired plus the deadline as grace (the kill
 * switch doesn't shorten that). Watch and x402 orders hold no escrow.
 */
export function refundable(
  order: Pick<DeskOrder, 'status' | 'source' | 'created_s' | 'valid_until'>,
  policy: Pick<DeskPolicy, 'deadline_s' | 'kill'> | null,
  nowS: number,
): boolean {
  if (!policy || order.source === 'watch' || order.source === 'x402') return false;
  if (order.status === 'signed') return order.valid_until !== null && nowS > order.valid_until + policy.deadline_s;
  if (order.status !== 'open' && order.status !== 'exit_pending') return false;
  return policy.kill || nowS >= order.created_s + policy.deadline_s;
}
