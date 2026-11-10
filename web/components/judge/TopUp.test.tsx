// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { button, change, click, mount, text, type Mounted } from '../../test/dom';
import { TopUp } from './TopUp';

const API = 'https://worker.test';
let m: Mounted | undefined;
afterEach(() => m?.unmount());

it('pay_from_any_chain_shows_deposit_address_then_asks_for_ft_transfer_call', async () => {
  m = await mount(
    TopUp,
    { api: API, recipientNear: 'alice.near' },
    { depositAddress: '0xtopup', expiresAt: '2026-11-11T13:00:00.000Z' },
  );
  const { el, calls } = m;
  await change(el, 'Pay from', 'monad');
  await change(el, 'Amount (USDC)', '3.250001');
  expect(button(el, 'Get deposit address').disabled).toBe(false);
  expect(calls).toEqual([]);

  await click(el, 'Get deposit address');
  expect(calls).toEqual([
    {
      url: `${API}/v1/quote`,
      body: {
        originAsset: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
        amount: '3250001',
        recipientNear: 'alice.near',
      },
    },
  ]);
  expect(text(el)).toContain('0xtopup');
  expect(text(el)).toContain('2026-11-11T13:00:00.000Z');
  expect(text(el)).toMatch(/Once USDC lands in alice\.near.*ft_transfer_call/);
  expect('ethereum' in window).toBe(false);

  await change(el, 'Amount (USDC)', '0');
  expect(button(el, 'Get deposit address').disabled).toBe(true);
  expect(text(el)).not.toContain('0xtopup');
  await change(el, 'Amount (USDC)', '0.0000001');
  expect(button(el, 'Get deposit address').disabled).toBe(true);
});
