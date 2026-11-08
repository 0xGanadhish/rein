import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { encodeFunctionData, parseAbi, serializeTransaction } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeskChain, DeskPolicy } from '../../shared/desk';
import { handle } from '../src/api';
import type { DeskOrder } from '../src/deskTypes';
import { ONECLICK, PINGPAY, SIGN_WAIT_MS, rememberSignedTx, type PaymentDeps } from '../src/payments';

const VAULT = '0x00000000000000000000000000000000000000aa';
const USDC = 'usdc.fakes.testnet';
const T0 = 1_793_774_400_000;
const postAbi = parseAbi(['function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256 id)']);
const SIGNED = serializeTransaction(
  { chainId: 10143, nonce: 0, gas: 400_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, to: '0x00000000000000000000000000000000000000cc',
    data: encodeFunctionData({ abi: postAbi, functionName: 'post', args: [VAULT, 1, 9200, 7100, `0x${'11'.repeat(32)}`, BigInt(T0 / 1000 + 1800)] }) },
  { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, yParity: 0 },
);

type Call = [string, ...unknown[]];

/** 1Click, PingPay and the desk on NEAR, in memory. */
class Fakes {
  calls: Call[] = [];
  clock = T0;
  orders = new Map<number, DeskOrder>();
  nextId = 40;
  /** `delivered` runs the whole order loop in one tick: it reads the signed tx, broadcasts, and delivery clears it. */
  outcome: 'signed' | 'delivered' | 'rejected' | 'post_failed' | 'stuck' = 'signed';
  refusal: string | null = null;
  valid = true;

  named(name: string) { return this.calls.filter((c) => c[0] === name); }

  deps(): PaymentDeps {
    const desk = rememberSignedTx({
      policy: async () => ({ price_usdc: '1000000', usdc_token: USDC }) as DeskPolicy,
      submit_x402_request: async (chain: DeskChain, vault: string, payment_ref: string, amount: string) => {
        this.calls.push(['submit_x402_request', chain, vault, payment_ref, amount]);
        if (this.refusal) throw new Error(`Smart contract panicked: ${this.refusal}`);
        const id = this.nextId++;
        this.orders.set(id, { id, source: 'x402', payer: null, chain, vault, amount, created_s: this.clock / 1000, status: 'open', exit_pending_s: null, valid_until: null });
        return id;
      },
      get_order: async (id: number) => (this.orders.has(id) ? { ...this.orders.get(id)! } : null),
      get_signed_tx: async (id: number) => (this.orders.get(id)?.status === 'signed' ? SIGNED : null),
    });
    return {
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        this.calls.push(['fetch', url, body]);
        if (url === `${ONECLICK.base}/quote`) {
          return Response.json({ quote: { depositAddress: '0xdep051t', amountIn: body.amount, amountOut: '995000', deadline: '2026-11-04T13:00:00.000Z' } });
        }
        if (url.startsWith(`${ONECLICK.base}/status?`)) return Response.json({ status: 'PENDING_DEPOSIT' });
        if (url === PINGPAY.base + PINGPAY.verifyPath) return Response.json(this.valid ? { isValid: true, payer: 'buyer.testnet' } : { isValid: false, invalidReason: 'insufficient_funds' });
        if (url === PINGPAY.base + PINGPAY.settlePath) return Response.json({ success: true, transaction: 'settle-tx', network: 'near:testnet', payer: 'buyer.testnet' });
        return new Response('unexpected', { status: 500 });
      },
      desk,
      tick: async () => {
        this.calls.push(['tick']);
        for (const o of this.orders.values()) {
          if (o.status !== 'open' || this.outcome === 'stuck') continue;
          if (this.outcome !== 'delivered') { o.status = this.outcome; continue; }
          o.status = 'signed';
          await desk.get_signed_tx(o.id);
          o.status = 'delivered';
        }
      },
      sleep: async (ms) => { this.clock += ms; },
      now: () => this.clock,
    };
  }
}

const payment = (nonce: string) => btoa(JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'near:testnet', payload: { nonce } }));

function call(fakes: Fakes, path: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`https://rein.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return handle(request, env, { kick: async () => ({}), health: async () => { throw new Error('unused'); }, payments: async () => fakes.deps() });
}
const judge = (fakes: Fakes, pay?: string, chain = 'monad-testnet') =>
  call(fakes, '/v1/x402/judge', { chain, vault: VAULT }, pay ? { [PINGPAY.paymentHeader]: pay } : {});

describe('payments', () => {
  beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
  beforeEach(async () => { await env.DB.prepare('DELETE FROM meta').run(); });

  it('quote_targets_customer_account_and_usdc_on_near', async () => {
    const fakes = new Fakes();
    const res = await call(fakes, '/v1/quote', { originAsset: 'nep141:eth.omft.near', amount: '400000000000000', recipientNear: 'alice.near' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ depositAddress: '0xdep051t', amountIn: '400000000000000', expiresAt: '2026-11-04T13:00:00.000Z' });
    const [[, url, sent]] = fakes.named('fetch') as [string, string, Record<string, unknown>][];
    expect(url).toBe(`${ONECLICK.base}/quote`);
    expect(sent).toMatchObject({
      originAsset: 'nep141:eth.omft.near',
      amount: '400000000000000',
      destinationAsset: ONECLICK.usdcOnNear,
      recipient: 'alice.near',
      recipientType: 'DESTINATION_CHAIN',
      refundTo: 'alice.near',
    });

    const status = await handle(new Request('https://rein.test/v1/quote/status?depositAddress=0xdep051t'), env,
      { kick: async () => ({}), health: async () => { throw new Error('unused'); }, payments: async () => fakes.deps() });
    expect(await status.json()).toEqual({ status: 'PENDING_DEPOSIT' });
    expect(fakes.named('fetch').at(-1)![1]).toBe(`${ONECLICK.base}/status?depositAddress=0xdep051t`);

    expect((await call(fakes, '/v1/quote', { originAsset: 'x', amount: '1', recipientNear: 'Not An Account' })).status).toBe(400);
  });

  it('x402_without_payment_returns_402', async () => {
    const fakes = new Fakes();
    const res = await judge(fakes);
    expect(res.status).toBe(402);
    const body = await res.json<Record<string, unknown>>();
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toEqual([expect.objectContaining({
      scheme: 'exact', network: 'near:testnet', maxAmountRequired: '1000000', asset: USDC, payTo: env.AGENT_ACCOUNT,
      resource: 'https://rein.test/v1/x402/judge',
    })]);
    expect(fakes.named('submit_x402_request')).toEqual([]);
    expect((await judge(new Fakes(), undefined, 'base-sepolia')).status).toBe(402);

    // A payment PingPay won't verify gets the same answer and opens nothing.
    fakes.valid = false;
    const bad = await judge(fakes, payment('n0'));
    expect(bad.status).toBe(402);
    expect((await bad.json<Record<string, unknown>>()).error).toBe('insufficient_funds');
    expect(fakes.named('submit_x402_request')).toEqual([]);
  });

  it('x402_verify_order_settle', async () => {
    const fakes = new Fakes();
    const res = await judge(fakes, payment('n1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: 40, signedTx: SIGNED, verdict: { verdict: 'EXIT', confidenceBps: 9200, riskBps: 7100 } });
    expect(JSON.parse(atob(res.headers.get(PINGPAY.responseHeader)!))).toMatchObject({ success: true, transaction: 'settle-tx' });

    const steps = fakes.calls.map((c) => (c[0] === 'fetch' ? String(c[1]).replace(PINGPAY.base, '') : c[0]));
    expect(steps).toEqual(['/verify', 'submit_x402_request', 'tick', '/settle']);
    const [[, chain, vault, ref, amount]] = fakes.named('submit_x402_request');
    expect([chain, vault, amount]).toEqual(['monad-testnet', VAULT, '1000000']);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    // Verify and settle carry the buyer's payload against the same requirements.
    const [verify, settle] = fakes.named('fetch').map((c) => c[2] as Record<string, unknown>);
    expect(verify.paymentPayload).toEqual({ x402Version: 1, scheme: 'exact', network: 'near:testnet', payload: { nonce: 'n1' } });
    expect(settle).toEqual(verify);
  });

  it('x402_not_settled_when_the_order_fails', async () => {
    const rejected = new Fakes();
    rejected.outcome = 'rejected';
    const res = await judge(rejected, payment('n2'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ orderId: 40, reason: 'rejected' });
    expect(rejected.named('fetch').map((c) => c[1])).toEqual([PINGPAY.base + PINGPAY.verifyPath]);

    const failed = new Fakes();
    failed.outcome = 'post_failed';
    const failedPost = await judge(failed, payment('failed-post'));
    expect(failedPost.status).toBe(502);
    expect(await failedPost.json()).toEqual({ orderId: 40, reason: 'post_failed' });
    expect(failed.named('fetch').map((c) => c[1])).toEqual([PINGPAY.base + PINGPAY.verifyPath]);

    // An order still unsigned after the wait isn't settled either.
    const stuck = new Fakes();
    stuck.outcome = 'stuck';
    const late = await judge(stuck, payment('n3'));
    expect(late.status).toBe(502);
    expect(await late.json()).toEqual({ orderId: 40, reason: 'not signed in time' });
    expect(stuck.clock - T0).toBe(SIGN_WAIT_MS);
    expect(stuck.named('tick').length).toBeGreaterThan(1);
    expect(stuck.named('fetch').map((c) => c[1])).toEqual([PINGPAY.base + PINGPAY.verifyPath]);
  });

  it('x402_refused_by_policy_not_settled', async () => {
    const fakes = new Fakes();
    fakes.refusal = 'spacing';
    const res = await judge(fakes, payment('n4'));
    expect(res.status).toBe(422);
    expect((await res.json<Record<string, unknown>>()).reason).toContain('spacing');
    expect(fakes.named('tick')).toEqual([]);
    expect(fakes.named('fetch').map((c) => c[1])).toEqual([PINGPAY.base + PINGPAY.verifyPath]);
  });

  it('x402_payment_ref_used_once', async () => {
    const fakes = new Fakes();
    expect((await judge(fakes, payment('n5'))).status).toBe(200);
    const again = await judge(fakes, payment('n5'), 'monad');
    expect(again.status).toBe(409);
    expect(fakes.named('submit_x402_request')).toHaveLength(1);
    expect(fakes.named('fetch').filter((c) => c[1] === PINGPAY.base + PINGPAY.settlePath)).toHaveLength(1);

    // A refused payment is spent too: its retry opens nothing.
    fakes.refusal = 'kill';
    expect((await judge(fakes, payment('n6'))).status).toBe(422);
    fakes.refusal = null;
    expect((await judge(fakes, payment('n6'))).status).toBe(409);
    expect(fakes.named('submit_x402_request')).toHaveLength(2);
  });

  it('x402_settles_after_delivery_clears_signed_tx', async () => {
    const fakes = new Fakes();
    fakes.outcome = 'delivered';
    const res = await judge(fakes, payment('n-delivered'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orderId: 40, signedTx: SIGNED, verdict: { verdict: 'EXIT' } });
    expect(fakes.named('fetch').filter(([, url]) => url === PINGPAY.base + PINGPAY.settlePath)).toHaveLength(1);
  });
});
