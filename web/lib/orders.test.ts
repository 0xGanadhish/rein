import { describe, expect, it } from 'vitest';
import { orderIdFrom, refundable } from './orders';

const policy = { deadline_s: 600, kill: false };
const order = { status: 'open' as const, source: 'near' as const, created_s: 1_000, valid_until: null };

describe('orders', () => {
  it('order_zero_opens_its_receipt', () => {
    expect(orderIdFrom({ status: { SuccessValue: btoa('0') } })).toBe(0);
    expect(orderIdFrom({ receipts_outcome: [{ outcome: { logs: ['order 0 opened'] } }] })).toBe(0);
  });

  it('refund_shows_under_kill_switch', () => {
    expect(refundable(order, policy, 1_100)).toBe(false);
    expect(refundable(order, { ...policy, kill: true }, 1_100)).toBe(true);
  });

  it('refund_shows_for_signed_after_expiry_grace', () => {
    const signed = { ...order, status: 'signed' as const, valid_until: 2_000 };
    expect(refundable(signed, policy, 2_600)).toBe(false);
    expect(refundable(signed, policy, 2_601)).toBe(true);
    expect(refundable(signed, { ...policy, kill: true }, 2_100)).toBe(false);
  });
});
