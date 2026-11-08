import type { DeskChain, DeskPolicy } from '../../shared/desk';
import { CHAIN_IDS, NETWORK_CHAINS, type DeskClient } from './deskTypes';
import type { Env } from './env';
import { withLock } from './lock';
import { paymentResponse, readPayment, runPaidJudgement } from './x402';

export const ONECLICK = {
  base: 'https://1click.chaindefuser.com/v0',
  /** Native USDC on NEAR, as a NEAR Intents asset id. */
  usdcOnNear: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  slippageBps: 100,
  quoteTtlS: 3600,
};

export const PINGPAY = {
  base: 'https://pay.pingpay.io/agentpay/x402',
  verifyPath: '/verify',
  settlePath: '/settle',
  x402Version: 2,
  scheme: 'exact',
  paymentHeader: 'PAYMENT-SIGNATURE',
  responseHeader: 'PAYMENT-RESPONSE',
};

export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: string;
    paymentFlow: string;
    destination: { network: string; asset: string; amount: string; recipient: string };
    operationToken?: string;
    refundDeadline?: string;
    depositMemo?: string;
    [key: string]: unknown;
  };
}
interface PaymentPayload {
  x402Version: number;
  resource: { url: string };
  accepted: PaymentRequirements;
  payload: {
    type: 'quote' | 'deposit';
    refundTo?: string;
    slippageTolerance?: number;
    operationToken?: string;
    depositAddress?: string;
    depositMemo?: string;
    txHash?: string;
  };
}
interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  extra?: {
    depositAddress: string;
    amountIn: string;
    refundDeadline: string;
    operationToken: string;
    depositMemo?: string;
  };
}
interface SettleResponse {
  success: boolean;
  transaction: string;
  network: string;
  errorReason?: string;
  amount?: string;
  extra?: { status?: string; [key: string]: unknown };
}

export interface PaymentDeps {
  fetch: typeof fetch;
  desk: Pick<DeskClient, 'policy' | 'check_x402_request' | 'submit_x402_request' | 'get_order'>;
  tick(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds. */
  now(): number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isChain = (c: unknown): c is DeskChain => typeof c === 'string' && Object.hasOwn(CHAIN_IDS, c);
const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `POST /v1/quote`: a 1Click quote that lands USDC on NEAR in the customer's own account. */
export async function quote(request: Request, deps: Pick<PaymentDeps, 'fetch' | 'now'>): Promise<Response> {
  const b = await body(request);
  const { originAsset, amount, recipientNear } = b ?? {};
  if (typeof originAsset !== 'string' || !originAsset) return json({ error: 'originAsset required' }, 400);
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount))
    return json({ error: 'amount must be a positive integer string' }, 400);
  if (typeof recipientNear !== 'string' || !NEAR_ACCOUNT.test(recipientNear))
    return json({ error: 'recipientNear must be a NEAR account' }, 400);

  const res = await deps.fetch(`${ONECLICK.base}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dry: false,
      swapType: 'EXACT_INPUT',
      slippageTolerance: ONECLICK.slippageBps,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: ONECLICK.usdcOnNear,
      amount,
      // A failed swap refunds to the customer's own intents account; we hold no origin-chain address for them.
      refundTo: recipientNear,
      refundType: 'INTENTS',
      recipient: recipientNear,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(deps.now() + ONECLICK.quoteTtlS * 1000).toISOString(),
    }),
  });
  if (!res.ok) return json({ error: 'quote failed' }, 502);
  const q = (await res.json<{ quote?: { depositAddress?: string; amountIn?: string; deadline?: string } }>()).quote;
  if (!q?.depositAddress) return json({ error: 'quote has no deposit address' }, 502);
  return json({ depositAddress: q.depositAddress, amountIn: q.amountIn, expiresAt: q.deadline });
}

/** `GET /v1/quote/status?depositAddress=`: pass through status responses, normalize upstream errors. */
export async function quoteStatus(url: URL, deps: Pick<PaymentDeps, 'fetch'>): Promise<Response> {
  const depositAddress = url.searchParams.get('depositAddress');
  if (!depositAddress) return json({ error: 'depositAddress required' }, 400);
  const res = await deps.fetch(`${ONECLICK.base}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  if (res.status >= 400) return json({ error: 'quote status failed' }, res.status);
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

async function pingpay<T>(
  env: Env,
  deps: PaymentDeps,
  path: string,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<T> {
  const res = await deps.fetch(`${PINGPAY.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': env.PINGPAY_API_KEY },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (res.status >= 500) throw new Error(`PingPay ${path} unavailable`);
  return res.json<T>();
}

function decodePayment(header: string): PaymentPayload | null {
  try {
    const p = JSON.parse(atob(header)) as PaymentPayload;
    if (
      p?.x402Version !== 2 ||
      typeof p.resource?.url !== 'string' ||
      p.accepted?.scheme !== 'exact' ||
      typeof p.accepted.network !== 'string' ||
      typeof p.accepted.asset !== 'string' ||
      p.accepted.extra?.assetTransferMethod !== 'near-intents' ||
      p.accepted.extra.paymentFlow !== 'upfront'
    )
      return null;
    if (p.payload?.type === 'quote' && typeof p.payload.refundTo === 'string' && p.payload.refundTo) return p;
    if (
      p.payload?.type === 'deposit' &&
      typeof p.payload.operationToken === 'string' &&
      p.payload.operationToken &&
      typeof p.payload.depositAddress === 'string' &&
      p.payload.depositAddress &&
      typeof p.payload.txHash === 'string' &&
      p.payload.txHash &&
      (p.payload.depositMemo === undefined || typeof p.payload.depositMemo === 'string')
    )
      return p;
    return null;
  } catch {
    return null;
  }
}

async function offers(env: Env, deps: PaymentDeps, policy: DeskPolicy): Promise<PaymentRequirements[]> {
  const res = await deps.fetch(`${PINGPAY.base}/offers?amountOut=${encodeURIComponent(policy.price_usdc)}`, {
    headers: { 'X-Api-Key': env.PINGPAY_API_KEY },
  });
  if (!res.ok) throw new Error('PingPay offers unavailable');
  const { accepts } = await res.json<{ accepts: PaymentRequirements[] }>();
  if (!Array.isArray(accepts)) throw new Error('PingPay offers missing');
  // The API key's organization controls routing. Fail closed rather than pay another recipient.
  const matching = accepts.filter(
    (r) =>
      r.scheme === 'exact' &&
      typeof r.network === 'string' &&
      typeof r.asset === 'string' &&
      r.payTo === '' &&
      r.amount === '' &&
      Number.isFinite(r.maxTimeoutSeconds) &&
      r.maxTimeoutSeconds > 0 &&
      r.extra?.assetTransferMethod === 'near-intents' &&
      r.extra.paymentFlow === 'upfront' &&
      r.extra.destination?.recipient === policy.treasury &&
      r.extra.destination.network === 'near:mainnet' &&
      r.extra.destination.amount === policy.price_usdc &&
      r.extra.destination.asset.replace(/^nep141:/, '') === policy.usdc_token,
  );
  if (!matching.length) throw new Error('PingPay offers do not match treasury and USDC policy');
  return matching;
}

/** x402 v2 upfront payment; only delivery earns revenue. Failed paid attempts become a one-use credit. */
export async function x402Judge(request: Request, env: Env, deps: PaymentDeps): Promise<Response> {
  const b = await body(request);
  const chain = b?.chain;
  const vault = typeof b?.vault === 'string' ? b.vault.toLowerCase() : null;
  if (!isChain(chain)) return json({ error: 'chain must be monad-testnet, monad, base or base-sepolia' }, 400);
  if (!vault || !/^0x[0-9a-f]{40}$/.test(vault)) return json({ error: 'vault must be a 0x address' }, 400);
  if (env.NEAR_NETWORK !== 'mainnet' || !NETWORK_CHAINS.mainnet.includes(chain))
    return json({ error: 'PingPay x402 is mainnet only' }, 503);
  const resource = { url: `${new URL(request.url).origin}/v1/x402/judge?chain=${chain}&vault=${vault}` };
  const required = (error: string, accepts: PaymentRequirements[] = []) => {
    const response = { x402Version: 2, error, resource, accepts };
    return json(response, 402, { 'PAYMENT-REQUIRED': btoa(JSON.stringify(response)) });
  };
  const header = request.headers.get(PINGPAY.paymentHeader);
  const payload = header ? decodePayment(header) : null;
  if (header && !payload) return required('PAYMENT-SIGNATURE must contain a valid x402 v2 payload');
  if (payload && payload.resource.url !== resource.url) return required('payment resource does not match judgement');

  if (payload?.payload.type === 'deposit') {
    const instrument = payload.payload;
    // EVM address casing is not a different payment. The provider's original spelling remains in the record.
    const address = payload.accepted.network.startsWith('eip155:')
      ? instrument.depositAddress!.toLowerCase()
      : instrument.depositAddress!;
    const id = JSON.stringify([env.NEAR_NETWORK, payload.accepted.network, address, instrument.depositMemo ?? '']);
    const payment = await readPayment(env.DB, id);
    if (!payment || payment.resource_url !== resource.url || payment.chain !== chain || payment.vault !== vault)
      return required('payment operation not found for this judgement');
    const terms = JSON.parse(payment.requirements_json) as PaymentRequirements;
    if (payload.accepted.asset !== terms.asset) return required('payment asset does not match operation');
    const encoder = new TextEncoder();
    const [presented, stored] = await Promise.all(
      [instrument.operationToken!, payment.operation_token].map((token) =>
        crypto.subtle.digest('SHA-256', encoder.encode(token)),
      ),
    );
    if (!crypto.subtle.timingSafeEqual(presented, stored)) return required('payment operation token invalid');
    const locked = await withLock(env.DB, `x402:${id}`, 60, async () => {
      let current = (await readPayment(env.DB, id))!;
      if (current.settlement_status === 'failed')
        return paymentResponse(current, JSON.parse(current.settlement_json!), 402);
      if (current.settlement_status !== 'settled') {
        let settled: SettleResponse;
        try {
          settled = await pingpay<SettleResponse>(env, deps, '/settle', payload, terms);
        } catch {
          return paymentResponse(current, { status: 'pending', paymentRef: id }, 202);
        }
        if (
          typeof settled.success !== 'boolean' ||
          typeof settled.transaction !== 'string' ||
          typeof settled.network !== 'string'
        )
          return json({ error: 'invalid PingPay settlement receipt' }, 502);
        if (
          settled.success &&
          (settled.network !== 'near:mainnet' ||
            !settled.transaction ||
            (settled.amount !== undefined && settled.amount !== current.amount))
        )
          return json({ error: 'PingPay settlement receipt does not match purchase' }, 502);
        const pending =
          settled.errorReason === 'settlement_pending' ||
          (!settled.success && settled.extra?.status === 'INCOMPLETE_DEPOSIT');
        const terminal =
          settled.extra?.status === 'REFUNDED' ||
          settled.extra?.status === 'FAILED' ||
          settled.errorReason === 'exact_near_intents_payment_failed' ||
          settled.errorReason === 'exact_near_intents_insufficient_deposit';
        await env.DB.prepare('UPDATE x402_payments SET settlement_status = ?, settlement_json = ? WHERE id = ?')
          .bind(
            settled.success ? 'settled' : terminal ? 'failed' : pending ? 'pending' : 'quoted',
            JSON.stringify(settled),
            id,
          )
          .run();
        current = (await readPayment(env.DB, id))!;
        if (!settled.success) return paymentResponse(current, settled, pending ? 202 : 402);
      }
      return runPaidJudgement(env.DB, current, deps, b?.redeemCredit === true);
    });
    return locked.ran ? locked.value : json({ status: 'pending', paymentRef: id }, 202);
  }

  // Quote-time refusals have no operation/claim to burn. The same request is reusable once admission opens.
  const admission = await deps.desk.check_x402_request(chain, vault);
  if (admission !== 'ok') return json({ error: admission }, 422);
  const policy = await deps.desk.policy();
  if (!policy.usdc_token) return json({ error: 'USDC payments are off' }, 503);
  let accepts: PaymentRequirements[];
  try {
    accepts = await offers(env, deps, policy);
  } catch (e) {
    return json({ error: message(e) }, 502);
  }
  if (!payload) return required('payment required', accepts);
  const requirements = accepts.find(
    (r) => r.network === payload.accepted.network && r.asset === payload.accepted.asset,
  );
  if (!requirements) return required('payment origin not offered', accepts);
  const { success } = await env.QUOTE_RATE_LIMITER.limit({
    key: `x402:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`,
  });
  if (!success) return json({ error: 'rate limited' }, 429, { 'Retry-After': '60' });
  let verified: VerifyResponse;
  try {
    verified = await pingpay<VerifyResponse>(env, deps, '/verify', payload, requirements);
  } catch {
    return json({ error: 'PingPay quote unavailable' }, 502);
  }
  if (!verified.isValid) return required(verified.invalidReason ?? 'payment quote invalid', accepts);
  const q = verified.extra;
  if (
    !q ||
    typeof q.depositAddress !== 'string' ||
    !q.depositAddress ||
    typeof q.operationToken !== 'string' ||
    !q.operationToken ||
    typeof q.amountIn !== 'string' ||
    !/^[1-9]\d*$/.test(q.amountIn) ||
    typeof q.refundDeadline !== 'string' ||
    !Number.isFinite(Date.parse(q.refundDeadline)) ||
    (q.depositMemo !== undefined && typeof q.depositMemo !== 'string')
  )
    return json({ error: 'invalid PingPay quote' }, 502);
  const address = requirements.network.startsWith('eip155:') ? q.depositAddress.toLowerCase() : q.depositAddress;
  const id = JSON.stringify([env.NEAR_NETWORK, requirements.network, address, q.depositMemo ?? '']);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO x402_payments
    (id, network, origin_network, deposit_address, deposit_memo, operation_token, resource_url, chain, vault, amount,
      requirements_json, refund_deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      env.NEAR_NETWORK,
      requirements.network,
      q.depositAddress,
      q.depositMemo ?? '',
      q.operationToken,
      resource.url,
      chain,
      vault,
      policy.price_usdc,
      JSON.stringify(requirements),
      q.refundDeadline,
      Math.floor(deps.now() / 1000),
    )
    .run();
  const recorded = (await readPayment(env.DB, id))!;
  if (recorded.operation_token !== q.operationToken || recorded.resource_url !== resource.url)
    return json({ error: 'PingPay quote instrument already issued' }, 502);
  return required('deposit required', [
    {
      ...requirements,
      payTo: q.depositAddress,
      amount: q.amountIn,
      extra: {
        ...requirements.extra,
        operationToken: q.operationToken,
        refundDeadline: q.refundDeadline,
        ...(q.depositMemo === undefined ? {} : { depositMemo: q.depositMemo }),
      },
    },
  ]);
}
