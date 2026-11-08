import { decodeFunctionData, parseAbi, parseTransaction, type Hex } from 'viem';
import type { DeskChain } from '../../shared/desk';
import { CHAIN_IDS, type DeskClient } from './deskTypes';
import type { Env, NearNetwork } from './env';

/**
 * Wire shapes of the two payment services, kept here so they are easy to adjust.
 * 1Click: the NEAR Intents 1Click API, `/v0/quote` and `/v0/status`.
 * PingPay: the standard x402 v1 facilitator shapes (`/verify`, `/settle`, `X-PAYMENT`) are assumed.
 */
export const ONECLICK = {
  base: 'https://1click.chaindefuser.com/v0',
  /** Native USDC on NEAR, as a NEAR Intents asset id. */
  usdcOnNear: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  slippageBps: 100,
  quoteTtlS: 3600,
};

export const PINGPAY = {
  base: 'https://api.pingpay.io/x402',
  verifyPath: '/verify',
  settlePath: '/settle',
  x402Version: 1,
  scheme: 'exact',
  network: { testnet: 'near:testnet', mainnet: 'near:mainnet' } as Record<NearNetwork, string>,
  paymentHeader: 'X-PAYMENT',
  responseHeader: 'X-PAYMENT-RESPONSE',
  maxTimeoutSeconds: 300,
};

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
}

interface VerifyResponse { isValid: boolean; invalidReason?: string; payer?: string }
interface SettleResponse { success: boolean; errorReason?: string; transaction?: string; network?: string; payer?: string }

/** How long a paid request waits for its order to be signed. */
export const SIGN_WAIT_MS = 150_000;
const POLL_MS = 5_000;
const VERDICTS = ['HOLD', 'EXIT', 'MOVE'] as const;
const postAbi = parseAbi(['function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256 id)']);

export interface PaymentDeps {
  /** Reaches 1Click and PingPay. */
  fetch: typeof fetch;
  desk: Pick<DeskClient, 'policy' | 'submit_x402_request' | 'get_order' | 'get_signed_tx'>;
  /** One pass of the order loop. */
  tick(): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds. */
  now(): number;
}

/**
 * The desk, but `get_signed_tx` keeps answering with the last signed tx it saw for an order. Delivery clears the tx on
 * the desk, and the order loop reads it before broadcasting, so a paid request that waited through a whole tick can
 * still return it. Give the order loop and the x402 route the same wrapped desk.
 */
export function rememberSignedTx<D extends Pick<DeskClient, 'get_signed_tx'>>(desk: D): D {
  const seen = new Map<number, string>();
  return {
    ...desk,
    async get_signed_tx(order_id: number) {
      const tx = await desk.get_signed_tx(order_id);
      if (tx) seen.set(order_id, tx);
      return tx ?? seen.get(order_id) ?? null;
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const isChain = (c: unknown): c is DeskChain => typeof c === 'string' && Object.hasOwn(CHAIN_IDS, c);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

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
  if (typeof amount !== 'string' || !/^[1-9]\d*$/.test(amount)) return json({ error: 'amount must be a positive integer string' }, 400);
  if (typeof recipientNear !== 'string' || !NEAR_ACCOUNT.test(recipientNear)) return json({ error: 'recipientNear must be a NEAR account' }, 400);

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
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } });
}

async function pingpay<T>(env: Env, deps: PaymentDeps, path: string, payload: unknown, requirements: PaymentRequirements): Promise<T> {
  const res = await deps.fetch(`${PINGPAY.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PINGPAY_API_KEY}` },
    body: JSON.stringify({ x402Version: PINGPAY.x402Version, paymentPayload: payload, paymentRequirements: requirements }),
  });
  if (!res.ok) throw new Error(`pingpay ${path} ${res.status}`);
  return res.json<T>();
}

function decodePayment(header: string): unknown {
  try {
    return JSON.parse(atob(header));
  } catch {
    return null;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The verdict a signed post carries. */
function verdictOf(signedTx: string) {
  try {
    const { args } = decodeFunctionData({ abi: postAbi, data: parseTransaction(signedTx as Hex).data! });
    const [, verdict, confidenceBps, riskBps] = args;
    return { verdict: VERDICTS[verdict] ?? verdict, confidenceBps, riskBps };
  } catch {
    return null;
  }
}

/**
 * `POST /v1/x402/judge {chain, vault}`. Without payment: 402 and the requirements. With payment: verify it, record the
 * order on the desk, run the order loop until the post is signed, then settle. A payment is taken only for a signed post.
 */
export async function x402Judge(request: Request, env: Env, deps: PaymentDeps): Promise<Response> {
  const b = await body(request);
  const chain = b?.chain;
  const vault = typeof b?.vault === 'string' ? b.vault.toLowerCase() : null;
  if (!isChain(chain)) return json({ error: 'chain must be monad-testnet, monad, base or base-sepolia' }, 400);
  if (!vault || !/^0x[0-9a-f]{40}$/.test(vault)) return json({ error: 'vault must be a 0x address' }, 400);

  const policy = await deps.desk.policy();
  if (!policy.usdc_token) return json({ error: 'USDC payments are off' }, 503);
  const requirements: PaymentRequirements = {
    scheme: PINGPAY.scheme,
    network: PINGPAY.network[env.NEAR_NETWORK],
    maxAmountRequired: policy.price_usdc,
    resource: new URL(request.url).origin + '/v1/x402/judge',
    description: `Rein verdict on ${vault} (${chain})`,
    mimeType: 'application/json',
    payTo: env.AGENT_ACCOUNT,
    maxTimeoutSeconds: PINGPAY.maxTimeoutSeconds,
    asset: policy.usdc_token,
  };
  const required = (error: string) => json({ x402Version: PINGPAY.x402Version, error, accepts: [requirements] }, 402);

  const header = request.headers.get(PINGPAY.paymentHeader);
  if (!header) return required(`${PINGPAY.paymentHeader} header is required`);
  const payload = decodePayment(header);
  if (!payload) return required('payment header is not base64 JSON');

  const verified = await pingpay<VerifyResponse>(env, deps, PINGPAY.verifyPath, payload, requirements);
  if (!verified.isValid) return required(verified.invalidReason ?? 'payment invalid');

  // A payment opens one order at most, whatever happens to it.
  const paymentRef = await sha256Hex(header);
  const claim = await env.DB.prepare(`INSERT OR IGNORE INTO meta (key, json, at) VALUES (?, ?, ?)`)
    .bind(`x402:${paymentRef}`, JSON.stringify({ chain, vault, payer: verified.payer ?? null }), Math.floor(deps.now() / 1000)).run();
  if (claim.meta.changes === 0) return json({ error: 'payment already used', paymentRef }, 409);

  let orderId: number;
  try {
    orderId = await deps.desk.submit_x402_request(chain, vault, paymentRef, requirements.maxAmountRequired);
  } catch (e) {
    return json({ error: 'refused', reason: message(e) }, 422);
  }
  await env.DB.prepare(`UPDATE meta SET json = json_set(json, '$.orderId', ?) WHERE key = ?`).bind(orderId, `x402:${paymentRef}`).run();

  const deadline = deps.now() + SIGN_WAIT_MS;
  let signedTx: string | null;
  for (;;) {
    try {
      await deps.tick();
    } catch (e) {
      console.error(JSON.stringify({ msg: 'x402_tick_failed', orderId, error: message(e) }));
    }
    const order = await deps.desk.get_order(orderId);
    if (order && (order.status === 'signed' || order.status === 'delivered')) {
      signedTx = await deps.desk.get_signed_tx(orderId);
      if (signedTx) break;
    }
    if (order && (order.status === 'rejected' || order.status === 'refunded' || order.status === 'post_failed')) return json({ orderId, reason: order.status }, 502);
    if (deps.now() >= deadline) return json({ orderId, reason: 'not signed in time' }, 502);
    await deps.sleep(POLL_MS);
  }

  let settled: SettleResponse;
  try {
    settled = await pingpay<SettleResponse>(env, deps, PINGPAY.settlePath, payload, requirements);
  } catch (e) {
    settled = { success: false, errorReason: message(e) };
  }
  if (!settled.success) {
    console.error(JSON.stringify({ msg: 'x402_settle_failed', orderId, paymentRef, error: settled.errorReason }));
    return json({ orderId, reason: `settle failed: ${settled.errorReason ?? 'unknown'}` }, 502);
  }
  return json({ orderId, signedTx, verdict: verdictOf(signedTx) }, 200, { [PINGPAY.responseHeader]: btoa(JSON.stringify(settled)) });
}
