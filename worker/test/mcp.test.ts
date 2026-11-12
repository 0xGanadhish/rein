import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DeskOrder, DeskPolicy } from '../../shared/desk';
import { handle, type ApiDeps } from '../src/api';
import * as payments from '../src/payments';
import { DEPLOYMENTS } from '../../shared/deployments';

const vault = '0x00000000000000000000000000000000000000aa';
const accepts = [
  {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '',
    payTo: '',
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod: 'near-intents',
      paymentFlow: 'upfront',
      destination: { network: 'near:mainnet', asset: 'usdc.near', amount: '1000000', recipient: 'treasury.near' },
    },
  },
];
const policy = {
  kill: false,
  spacing_s: 60,
  price_near: '1',
  price_usdc: '1000000',
  treasury: 'treasury.near',
  usdc_token: 'usdc.near',
} as DeskPolicy;
const order: DeskOrder = {
  id: 7,
  chain: 'monad',
  vault,
  source: 'x402',
  payer: null,
  amount: '1000000',
  created_s: 1000,
  status: 'delivered',
  valid_until: null,
  exit_pending_s: null,
};
let nudge = vi.fn(async () => ({ status: 'delivered' as const }));
const paymentDeps: payments.PaymentDeps = {
  fetch: async () => Response.json({ accepts }),
  desk: {
    policy: async () => policy,
    check_x402_request: async () => 'ok',
    get_order: async () => order,
    submit_x402_request: async () => 7,
  },
  tick: async () => {},
  sleep: async () => {},
  now: () => Date.now(),
};
function request(path: string, body: string, method = 'POST', overrides: Partial<ApiDeps> = {}) {
  return handle(
    new Request(`https://rein.test${path}`, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      ...(method === 'POST' ? { body } : {}),
    }),
    {
      ...env,
      NEAR_NETWORK: 'mainnet',
      PINGPAY_API_KEY: 'test-only-pingpay',
      QUOTE_RATE_LIMITER: { limit: async () => ({ success: true }) },
    },
    { kick: null!, health: null!, nudge, payments: async () => paymentDeps, ...overrides },
  );
}
async function call(args: Record<string, unknown> = {}) {
  const response = await request(
    '/mcp',
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_verdict', arguments: { chain: 'monad', vault, ...args } },
    }),
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)))
        .find((item) => item.id === 1)
    : JSON.parse(text);
  return payload.result;
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch(
    ['orders', 'posts', 'meta', 'judge_calls', 'broadcast_attempts'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  nudge = vi.fn(async () => ({ status: 'delivered' as const }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify([vault]))] } }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('get_verdict_without_payment_returns_requirements', async () => {
  const direct = await request('/v1/x402/judge', JSON.stringify({ chain: 'monad', vault }));
  expect(direct.status).toBe(402);
  const body = await direct.json<{ accepts: unknown[] }>();
  const result = await call();
  expect(result.structuredContent).toEqual({ payment_required: true, accepts: body.accepts });
  expect(result.isError).not.toBe(true);
  expect(nudge).not.toHaveBeenCalled();
});
it('stubbed_x402_result_becomes_verdict_record', async () => {
  const judge = vi
    .spyOn(payments, 'x402Judge')
    .mockResolvedValue(Response.json({ orderId: 7, verdict: { verdict: 'EXIT', confidenceBps: 9500, riskBps: 8000 } }));
  await env.DB.prepare(
    "INSERT INTO orders (id, source, payer, chain, vault, amount, created_s, status) VALUES (7, 'x402', NULL, 'monad', ?, '1000000', 1000, 'delivered')",
  )
    .bind(vault)
    .run();
  await env.DB.prepare(
    "INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at, pps_at_post, assets_at_post, liquidity_at_post, order_id, resolved, adverse, reasons) VALUES ('monad', 1, ?, 1, 9500, 8000, '0x123', 1000, '1', '1', '1', 7, 1, 1, 1)",
  )
    .bind(vault)
    .run();
  const result = await call({ payment: 'fake-payment' });
  expect(result.structuredContent).toEqual({
    order_id: 7,
    chain: 'monad',
    vault,
    verdict: 'EXIT',
    confidence_bps: 9500,
    risk_bps: 8000,
    reasons: ['share price fell'],
    posted_tx: null,
    oracle: DEPLOYMENTS.mainnet.oracles.monad,
    state_hash: '0x123',
    valid_until: null,
    explorer_url: null,
    grade: { adverse: true, resolved_at: null },
  });
  expect(result.isError).not.toBe(true);
  nudge.mockClear();
  judge.mockResolvedValue(Response.json({ status: 'pending', paymentRef: 'fake-ref' }, { status: 202 }));
  const pending = await call({ payment: 'fake-payment' });
  expect(pending.structuredContent).toEqual({ pending: true, payment_ref: 'fake-ref', order_id: null });
  expect(pending.content[0].text).toMatch(/still settling.*same payment/i);
  expect(nudge).not.toHaveBeenCalled();
});
it('malformed_jsonrpc_is_a_clean_error', async () => {
  const response = await request('/mcp', 'not json');
  const body = await response.json<{ error?: unknown }>();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(body.error).toBeDefined();
  for (const method of ['GET', 'PUT', 'HEAD']) {
    const wrong = await request('/mcp', '', method);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('Allow')).toBe('POST');
    expect(wrong.headers.get('content-type')).toBe('application/json');
    if (method !== 'HEAD') expect(await wrong.json()).toEqual({ error: 'method not allowed' });
  }
});
