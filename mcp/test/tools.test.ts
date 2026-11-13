import { expect, it, vi } from 'vitest';
import { DEPLOYMENTS } from '../../shared/deployments';
import { makeTools } from '../src/tools';
import type { Payer, ReinReader } from '../src/types';

const chain = 'monad-testnet' as const;
const vault = '0x00000000000000000000000000000000000000aa';
function fixture() {
  let now = 1000;
  const reader: ReinReader = {
    ledger: vi.fn(async () => ({ recent: [] })),
    order: vi.fn(async () => ({ id: 7, chain, vault, status: 'delivered', posts: [] })),
    policy: vi.fn(async () => ({ kill: false, spacing_s: 60, price_near: '1', price_usdc: '1' })),
    menu: vi.fn(async () => [vault]),
    getOrder: vi.fn(async () => ({ id: 7, status: 'open' })),
    nudge: vi.fn(async () => {}),
  };
  const payer: Payer = { buy: vi.fn(async () => ({ orderId: 7 })) };
  const tools = makeTools(reader, payer, {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms / 1000;
    },
    waitCapS: 6,
    pollS: 3,
  });
  const call = (name: string, args = {}) => tools.find((t) => t.name === name)!.handler(args);
  return { reader, payer, call };
}

it('refusal_returns_reason_and_next_allowed', async () => {
  const { reader, payer, call } = fixture();
  vi.mocked(payer.buy).mockResolvedValue({ refused: 'spacing', nextAllowedS: 1100 });
  const result = await call('get_verdict', { chain, vault });
  expect(result.structuredContent).toEqual({ refused: 'spacing', nextAllowedS: 1100 });
  expect(result.content[0].text).toContain('spacing');
  expect(payer.buy).toHaveBeenCalledOnce();
  expect(reader.nudge).not.toHaveBeenCalled();
  expect(reader.getOrder).not.toHaveBeenCalled();
  expect(reader.order).not.toHaveBeenCalled();
});
it('wait_cap_returns_pending_with_order_id', async () => {
  const { reader, call } = fixture();
  const result = await call('get_verdict', { chain, vault });
  expect(result.structuredContent).toEqual({ order_id: 7, status: 'open', pending: true });
  expect(reader.nudge).toHaveBeenCalledWith(7);
  expect(reader.getOrder).toHaveBeenCalledTimes(3);
});
it('failed_statuses_name_the_automatic_refund', async () => {
  for (const status of ['post_failed', 'refunded']) {
    const { reader, call } = fixture();
    vi.mocked(reader.getOrder).mockResolvedValue({ id: 7, status });
    const result = await call('get_verdict', { chain, vault });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(status);
    expect(result.content[0].text).toMatch(/refund is automatic/i);
  }
});
it('verdict_record_maps_ledger_row', async () => {
  const { reader, call } = fixture();
  vi.mocked(reader.order).mockResolvedValue({
    id: 7,
    chain,
    vault,
    status: 'delivered',
    post_tx: '0xabc',
    posts: [
      {
        verdict: 'EXIT',
        confidence_bps: 9500,
        risk_bps: 8000,
        state_hash: '0x123',
        resolved: 1,
        adverse: 1,
        reasons: 5,
      },
    ],
  });
  expect((await call('order_status', { order_id: 7 })).structuredContent).toEqual({
    order_id: 7,
    chain,
    vault,
    verdict: 'EXIT',
    confidence_bps: 9500,
    risk_bps: 8000,
    reasons: ['share price fell', 'liquidity under 5%'],
    posted_tx: '0xabc',
    oracle: DEPLOYMENTS.testnet.oracles[chain],
    state_hash: '0x123',
    valid_until: null,
    explorer_url: 'https://testnet.monadscan.com/tx/0xabc',
    grade: { adverse: true, resolved_at: null },
  });
  vi.mocked(reader.order).mockResolvedValue({
    id: 7,
    chain: 'base',
    vault,
    status: 'delivered',
    posts: [{ verdict: 0, confidence_bps: 9000, risk_bps: 100, resolved: false, adverse: null, reasons: null }],
  });
  expect((await call('order_status', { order_id: 7 })).structuredContent).toMatchObject({
    verdict: 'HOLD',
    posted_tx: null,
    oracle: DEPLOYMENTS.mainnet.oracles.base,
    state_hash: null,
    valid_until: null,
    explorer_url: null,
    grade: null,
  });
});

const CLEARSTAR = '0xE1BcA19baA63894D374578320551633320436523';
const OWNER = '0x00000000000000000000000000000000000000bb';
it('guardian_transactions_returns_unsigned_deposit_steps', async () => {
  const { reader, payer, call } = fixture();
  const result = await call('guardian_transactions', {
    action: 'deposit',
    chain: 'monad',
    vault: CLEARSTAR,
    owner: OWNER,
    amount_usdc: '0.25',
  });
  const data = result.structuredContent as { guardian: string; transactions: { step: string }[] };
  expect(result.isError).toBeUndefined();
  expect(data.transactions.map((t) => t.step)).toEqual(['approve_usdc', 'deposit']);
  expect(data.guardian).toBe(DEPLOYMENTS.mainnet.guardians.monad);
  expect(payer.buy).not.toHaveBeenCalled();
  for (const fn of Object.values(reader)) expect(fn).not.toHaveBeenCalled();
});
it('guardian_transactions_rejects_unknown_vault_and_testnet', async () => {
  const { call } = fixture();
  const testnet = await call('guardian_transactions', { action: 'disarm', chain: 'base-sepolia', vault: CLEARSTAR });
  expect(testnet.isError).toBe(true);
  expect(testnet.structuredContent).not.toHaveProperty('transactions');
  const offMenu = await call('guardian_transactions', {
    action: 'disarm',
    chain: 'monad',
    vault: '0xbeef0786756810478b88982DE00F3CD7fdB8e7c7',
  });
  expect(offMenu.isError).toBe(true);
  expect(offMenu.structuredContent).not.toHaveProperty('transactions');
  expect(offMenu.content[0].text).toBe('vault is not on the monad menu');
});
