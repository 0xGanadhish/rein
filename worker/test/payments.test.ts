import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { encodeFunctionData, parseAbi, serializeTransaction } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeskChain, DeskPolicy } from '../../shared/desk';
import { handle } from '../src/api';
import type { DeskOrder } from '../src/deskTypes';
import { ONECLICK, PINGPAY, type PaymentDeps } from '../src/payments';
import { reconcileX402 } from '../src/x402';

const VAULT = '0x00000000000000000000000000000000000000aa';
const DEPOSIT = '0x00000000000000000000000000000000000000dd';
const ORIGIN_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC = 'usdc.near';
const T0 = 1_793_774_400_000;
const RESOURCE = `https://rein.test/v1/x402/judge?chain=monad&vault=${VAULT}`;
const REQUIREMENTS = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '',
  asset: ORIGIN_USDC,
  payTo: '',
  maxTimeoutSeconds: 300,
  extra: {
    assetTransferMethod: 'near-intents',
    paymentFlow: 'upfront',
    destination: {
      network: 'near:mainnet',
      asset: USDC,
      amount: '1000000',
      recipient: 'treasury.near',
    },
  },
};
const postAbi = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256 id)',
]);
const SIGNED = serializeTransaction(
  {
    chainId: 143,
    nonce: 0,
    gas: 400_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    to: '0x00000000000000000000000000000000000000cc',
    data: encodeFunctionData({
      abi: postAbi,
      functionName: 'post',
      args: [VAULT, 1, 9200, 7100, `0x${'11'.repeat(32)}`, BigInt(T0 / 1000 + 1800)],
    }),
  },
  { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, yParity: 0 },
);

class Fakes {
  clock = T0;
  orders = new Map<number, DeskOrder>();
  refs = new Map<string, number>();
  nextId = 40;
  outcome: 'signed' | 'delivered' | 'rejected' | 'post_failed' | 'stuck' = 'delivered';
  refusal: string | null = null;
  admissionRace = false;
  valid = true;
  providerCalls: string[] = [];
  clientKey = crypto.randomUUID();
  settlements = 0;
  pendingSettlement = false;
  terminalRefund = false;
  loseSubmission = false;

  deps(): PaymentDeps {
    return {
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        if (url === `${ONECLICK.base}/quote`)
          return Response.json({
            quote: {
              depositAddress: '0xdep051t',
              amountIn: body.amount,
              deadline: '2026-11-04T13:00:00.000Z',
            },
          });
        if (url.startsWith(`${ONECLICK.base}/status?`)) return Response.json({ status: 'PENDING_DEPOSIT' });
        this.providerCalls.push(url);
        if (new Headers(init?.headers).get('X-Api-Key') !== 'test-only-pingpay')
          return new Response(null, { status: 401 });
        if (url === `${PINGPAY.base}/offers?amountOut=1000000`) return Response.json({ accepts: [REQUIREMENTS] });
        if (
          body?.x402Version !== 2 ||
          body.paymentPayload?.resource?.url !== RESOURCE ||
          JSON.stringify(body.paymentRequirements) !== JSON.stringify(REQUIREMENTS)
        )
          return new Response(null, { status: 400 });
        if (url === `${PINGPAY.base}/verify`) {
          if (body.paymentPayload.payload.type !== 'quote' || !body.paymentPayload.payload.refundTo)
            return new Response(null, { status: 400 });
          return Response.json(
            this.valid
              ? {
                  isValid: true,
                  extra: {
                    depositAddress: DEPOSIT,
                    amountIn: '1005000',
                    operationToken: 'private-operation-token',
                    refundDeadline: new Date(T0 + 300_000).toISOString(),
                  },
                }
              : { isValid: false, invalidReason: 'refund_address_required' },
          );
        }
        if (url === `${PINGPAY.base}/settle`) {
          if (
            body.paymentPayload.payload.type !== 'deposit' ||
            body.paymentPayload.payload.operationToken !== 'private-operation-token' ||
            body.paymentPayload.payload.depositAddress !== DEPOSIT
          )
            return new Response(null, { status: 400 });
          if (body.paymentPayload.payload.txHash !== '0xdeposit')
            return Response.json(
              {
                success: false,
                errorReason: 'invalid_exact_near_intents_deposit_not_found',
                transaction: '',
                network: 'eip155:8453',
              },
              { status: 402 },
            );
          if (this.terminalRefund)
            return Response.json(
              {
                success: false,
                errorReason: 'exact_near_intents_payment_failed',
                transaction: '',
                network: 'eip155:8453',
                extra: { status: 'REFUNDED', refundTo: VAULT },
              },
              { status: 402 },
            );
          if (this.pendingSettlement)
            return Response.json({
              success: false,
              errorReason: 'settlement_pending',
              transaction: '0xdeposit',
              network: 'eip155:8453',
            });
          this.settlements++;
          if (this.admissionRace) this.refusal = 'kill switch on';
          return Response.json({
            success: true,
            transaction: 'near-settlement-tx',
            network: 'near:mainnet',
            amount: '1000000',
          });
        }
        return new Response(null, { status: 500 });
      },
      desk: {
        policy: async () => ({ price_usdc: '1000000', usdc_token: USDC, treasury: 'treasury.near' }) as DeskPolicy,
        check_x402_request: async () => this.refusal ?? 'ok',
        submit_x402_request: async (chain: DeskChain, vault: string, ref: string, amount: string) => {
          if (!this.settlements) throw new Error('order opened before settlement');
          if (this.refs.has(ref)) return this.refs.get(ref)!;
          if (this.refusal) throw new Error(`Smart contract panicked: ${this.refusal}`);
          const id = this.nextId++;
          this.refs.set(ref, id);
          this.orders.set(id, {
            id,
            source: 'x402',
            payer: null,
            chain,
            vault,
            amount,
            created_s: this.clock / 1000,
            status: 'open',
            exit_pending_s: null,
            valid_until: null,
          });
          if (this.loseSubmission) {
            this.loseSubmission = false;
            throw new Error('transport response lost');
          }
          return id;
        },
        get_order: async (id: number) => this.orders.get(id) ?? null,
      },
      tick: async () => {
        for (const o of this.orders.values()) {
          if (!['open', 'signed'].includes(o.status) || this.outcome === 'stuck') continue;
          if (this.outcome === 'delivered') {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO broadcast_attempts
              (network, chain, order_id, nonce, hash, raw_tx, attempted_at, receipt_status, gas_wei)
              VALUES ('mainnet', ?, ?, 0, ?, ?, ?, 'success', '12')`,
            )
              .bind(o.chain, o.id, `0x${o.id}`, SIGNED, this.clock / 1000)
              .run();
          }
          o.status = this.outcome;
          await env.DB.prepare(
            `INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status)
            VALUES (?, 'x402', NULL, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
          )
            .bind(o.id, o.chain, o.vault, o.amount, o.created_s, o.status)
            .run();
        }
      },
      sleep: async (ms) => {
        this.clock += ms;
      },
      now: () => this.clock,
    };
  }
}
const payment = (type: 'quote' | 'deposit', pretty = false) =>
  btoa(
    JSON.stringify(
      {
        x402Version: 2,
        resource: { url: RESOURCE },
        accepted: REQUIREMENTS,
        payload:
          type === 'quote'
            ? { type, refundTo: VAULT }
            : {
                type,
                operationToken: 'private-operation-token',
                depositAddress: DEPOSIT,
                txHash: '0xdeposit',
              },
      },
      null,
      pretty ? 2 : undefined,
    ),
  );
function call(fakes: Fakes, path: string, body: unknown, headers: Record<string, string> = {}) {
  return handle(
    new Request(`https://rein.test${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': fakes.clientKey, ...headers },
    }),
    { ...env, NEAR_NETWORK: 'mainnet', PINGPAY_API_KEY: 'test-only-pingpay' },
    {
      kick: async () => ({}),
      health: null!,
      payments: async () => fakes.deps(),
    },
  );
}
const judge = (f: Fakes, pay?: string, redeemCredit = false, chain = 'monad') =>
  call(f, '/v1/x402/judge', { chain, vault: VAULT, redeemCredit }, pay ? { 'PAYMENT-SIGNATURE': pay } : {});
const purchase = async (f: Fakes) => {
  expect((await judge(f, payment('quote'))).status).toBe(402);
  return judge(f, payment('deposit'));
};
const business = async () =>
  (await handle(new Request('https://rein.test/v1/stats'), env, { kick: null!, health: null!, payments: null! })).json<
    Record<string, unknown>
  >();

describe('payments', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    for (const table of ['meta', 'orders', 'broadcast_attempts', 'pending_nonces', 'locks'])
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    await env.DB.prepare('DELETE FROM x402_attempts').run();
    await env.DB.prepare('DELETE FROM x402_payments').run();
  });

  it('quote_targets_customer_account_and_usdc_on_near', async () => {
    const f = new Fakes();
    const res = await call(f, '/v1/quote', {
      originAsset: 'nep141:eth.omft.near',
      amount: '400000000000000',
      recipientNear: 'alice.near',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      depositAddress: '0xdep051t',
      amountIn: '400000000000000',
      expiresAt: '2026-11-04T13:00:00.000Z',
    });
    const status = await handle(new Request('https://rein.test/v1/quote/status?depositAddress=0xdep051t'), env, {
      kick: null!,
      health: null!,
      payments: async () => f.deps(),
    });
    expect(await status.json()).toEqual({ status: 'PENDING_DEPOSIT' });
    expect(
      (await call(f, '/v1/quote', { originAsset: 'x', amount: '1', recipientNear: 'Not An Account' })).status,
    ).toBe(400);
  });

  it('x402_without_payment_returns_402', async () => {
    const f = new Fakes();
    const res = await judge(f);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ x402Version: 2, resource: { url: RESOURCE }, accepts: [REQUIREMENTS] });
    expect(JSON.parse(atob(res.headers.get('PAYMENT-REQUIRED')!))).toMatchObject({
      x402Version: 2,
      accepts: [REQUIREMENTS],
    });
    expect(f.orders.size).toBe(0);
    f.valid = false;
    const bad = await judge(f, payment('quote'));
    expect(bad.status).toBe(402);
    expect(await bad.json()).toMatchObject({ error: 'refund_address_required' });
    expect(f.settlements).toBe(0);
  });

  it('x402_verify_order_settle', async () => {
    const f = new Fakes();
    const quoted = await judge(f, payment('quote'));
    expect(quoted.status).toBe(402);
    expect(await quoted.json()).toMatchObject({
      accepts: [
        {
          payTo: DEPOSIT,
          amount: '1005000',
          extra: {
            operationToken: 'private-operation-token',
            destination: { recipient: 'treasury.near' },
          },
        },
      ],
    });
    expect(f.orders.size).toBe(0);
    const res = await judge(f, payment('deposit'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      orderId: 40,
      signedTx: SIGNED,
      verdict: { verdict: 'EXIT', confidenceBps: 9200, riskBps: 7100 },
    });
    expect(JSON.parse(atob(res.headers.get('PAYMENT-RESPONSE')!))).toMatchObject({
      success: true,
      transaction: 'near-settlement-tx',
      network: 'near:mainnet',
    });
    expect(await business()).toMatchObject({
      settled_revenue: { x402_usdc: '1000000' },
      x402_unsettled_usdc: '0',
      per_order_margin: [{ x402_settled: true, revenue: { usdc: '1000000' } }],
    });
  });

  it('x402_failed_post_leaves_redeemable_credit', async () => {
    const f = new Fakes();
    f.outcome = 'post_failed';
    const failed = await purchase(f);
    expect(failed.status).toBe(502);
    const result = await failed.json();
    expect(result).toMatchObject({ orderId: 40, error: 'post_failed', creditAvailable: true });
    expect(f.settlements).toBe(1);
    expect(await business()).toMatchObject({
      settled_revenue: { x402_usdc: '0' },
      unpaid_liabilities: { x402_credit_usdc: '1000000' },
    });
    expect(await (await judge(f, payment('deposit', true))).json()).toEqual(result);
    f.outcome = 'delivered';
    const retries = await Promise.all([judge(f, payment('deposit'), true), judge(f, payment('deposit'), true)]);
    expect(retries.map((r) => r.status)).toContain(200);
    expect(f.orders.size).toBe(2);
    const delivered = await judge(f, payment('deposit'), true);
    expect(await delivered.json()).toMatchObject({ orderId: 41, verdict: { verdict: 'EXIT' } });
    expect(f.orders.size).toBe(2);
    expect(f.settlements).toBe(1);
    expect(await business()).toMatchObject({
      settled_revenue: { x402_usdc: '1000000' },
      unpaid_liabilities: { x402_credit_usdc: '0' },
    });
  });

  it.each([
    'kill switch on',
    'vault not on menu',
    'vault has an open order',
    'too many open orders',
    'spacing',
    'per-vault cap',
    'global cap',
  ])('x402_refused_by_policy_not_settled: %s', async (reason) => {
    const f = new Fakes();
    f.refusal = reason;
    const res = await judge(f, payment('quote'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: reason });
    expect(f.providerCalls).toEqual([]);
    f.refusal = null;
    expect((await purchase(f)).status).toBe(200);
  });

  it('x402_payment_ref_used_once', async () => {
    const f = new Fakes();
    f.loseSubmission = true;
    expect((await purchase(f)).status).toBe(202);
    const res = await judge(f, payment('deposit', true));
    expect(res.status).toBe(200);
    const saved = await res.json();
    // New dependencies and a different byte encoding must resume the same purchased result.
    f.refusal = 'kill switch on';
    expect(await (await judge(f, payment('deposit'))).json()).toEqual(saved);
    expect(f.orders.size).toBe(1);
    expect(f.settlements).toBe(1);
    expect((await judge(f, payment('deposit'), false, 'base')).status).toBe(402);
    const stolen = JSON.parse(atob(payment('deposit')));
    stolen.payload.operationToken = 'wrong-token';
    expect((await judge(f, btoa(JSON.stringify(stolen)))).status).toBe(402);
  });

  it('x402_pending_order_resumes_without_second_charge', async () => {
    const f = new Fakes();
    f.pendingSettlement = true;
    expect((await purchase(f)).status).toBe(202);
    expect(f.orders.size).toBe(0);
    f.pendingSettlement = false;
    f.outcome = 'signed';
    const pending = await judge(f, payment('deposit'));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({ orderId: 40, status: 'pending' });
    expect(await business()).toMatchObject({ settled_revenue: { x402_usdc: '0' } });
    f.outcome = 'delivered';
    expect((await judge(f, payment('deposit'))).status).toBe(200);
    expect(f.settlements).toBe(1);
    expect(f.orders.size).toBe(1);
  });

  it('x402_result_survives_delivery_clearing_signed_tx', async () => {
    const f = new Fakes();
    f.outcome = 'signed';
    expect((await purchase(f)).status).toBe(202);
    f.outcome = 'delivered';
    await f.deps().tick();
    // The route died before saving its result; the desk subsequently pruned the finished order.
    f.orders.clear();
    const delivered = await judge(f, payment('deposit'));
    expect(delivered.status).toBe(200);
    const result = await delivered.json();
    f.orders.clear();
    await env.DB.prepare('DELETE FROM broadcast_attempts').run();
    expect(await (await judge(f, payment('deposit', true))).json()).toEqual(result);
    expect(f.settlements).toBe(1);
  });

  it('x402_settled_admission_race_preserves_credit', async () => {
    const f = new Fakes();
    f.admissionRace = true;
    const refused = await purchase(f);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'kill switch on', creditAvailable: true });
    expect(f.settlements).toBe(1);
    f.refusal = null;
    f.admissionRace = false;
    f.outcome = 'post_failed';
    const spent = await judge(f, payment('deposit'), true);
    expect(spent.status).toBe(502);
    expect(await spent.json()).toMatchObject({ error: 'post_failed', creditAvailable: false });
    await judge(f, payment('deposit'), true);
    expect(f.orders.size).toBe(1);
    expect(f.settlements).toBe(1);
  });
  it('x402_invalid_deposit_does_not_consume_operation', async () => {
    const f = new Fakes();
    expect((await judge(f, payment('quote'))).status).toBe(402);
    const wrong = JSON.parse(atob(payment('deposit')));
    wrong.payload.txHash = '0xwrong-deposit';
    expect((await judge(f, btoa(JSON.stringify(wrong)))).status).toBe(402);
    expect(f.orders.size).toBe(0);
    expect((await judge(f, payment('deposit'))).status).toBe(200);
    expect(f.orders.size).toBe(1);
    expect(f.settlements).toBe(1);
  });
  it('x402_terminal_refund_replays_receipt', async () => {
    const f = new Fakes();
    f.terminalRefund = true;
    const first = await purchase(f);
    expect(first.status).toBe(402);
    const result = await first.json();
    expect(result).toMatchObject({ success: false, extra: { status: 'REFUNDED' } });
    expect(await (await judge(f, payment('deposit'))).json()).toEqual(result);
    expect(f.orders.size).toBe(0);
  });

  it('x402_pending_operations_do_not_starve_deliveries', async () => {
    const f = new Fakes();
    f.outcome = 'signed';
    expect((await purchase(f)).status).toBe(202);
    f.outcome = 'delivered';
    await f.deps().tick();
    const original = await env.DB.prepare('SELECT id FROM x402_payments').first<string>('id');
    for (let i = 0; i < 20; i++) {
      const id = `pending-payment-${i}`;
      await env.DB.prepare(
        `INSERT INTO x402_payments
        (id, network, origin_network, deposit_address, deposit_memo, operation_token, resource_url, chain, vault, amount,
          requirements_json, refund_deadline, settlement_status, state, created_at)
        SELECT ?, network, origin_network, ?, deposit_memo, operation_token, resource_url, chain, vault, amount,
          requirements_json, refund_deadline, 'settled', 'running', created_at FROM x402_payments WHERE id = ?`,
      )
        .bind(id, `pending-deposit-${i}`, original)
        .run();
      await env.DB.prepare(
        `INSERT INTO x402_attempts (payment_id, attempt, amount, order_id, status) VALUES (?, 0, '1000000', ?, 'open')`,
      )
        .bind(id, i)
        .run();
    }
    await reconcileX402(env.DB, 'mainnet', f.deps().desk);
    expect(await business()).toMatchObject({ settled_revenue: { x402_usdc: '1000000' } });
  });
});
