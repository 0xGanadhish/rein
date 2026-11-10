// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { button, change, click, mount, text, type Mounted } from '../../test/dom';
import { MoveAfterExit } from './MoveAfterExit';

const API = 'https://worker.test';
const BASE = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const MONAD = 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx';
const OWNER = '0x00000000000000000000000000000000000000aa';
const QUOTE = { depositAddress: '0xdeposit', expiresAt: '2026-11-11T13:00:00.000Z' };

let m: Mounted | undefined;
afterEach(() => m?.unmount());
const panel = async () =>
  (m = await mount(MoveAfterExit, { api: API, chain: 'base', amount: 2345678n, owner: OWNER }, QUOTE));

it('shows_after_a_confirmed_exit_with_the_exited_amount', async () => {
  const { el } = await panel();
  expect(text(el)).toContain('2.345678 USDC');
});

it('quote_uses_vault_chain_as_origin_and_user_pick_as_destination', async () => {
  const { el, calls } = await panel();
  await change(el, 'Destination chain', 'monad');
  await change(el, 'Destination address', OWNER);
  await click(el, 'Get deposit address');
  expect(calls).toEqual([
    {
      url: `${API}/v1/quote`,
      body: { originAsset: BASE, amount: '2345678', destinationAsset: MONAD, recipient: OWNER, refundTo: OWNER },
    },
  ]);
  expect(text(el)).toContain('0xdeposit');
  expect(text(el)).toContain('2026-11-11T13:00:00.000Z');
  // Editing the destination drops the stale deposit address.
  await change(el, 'Destination address', '0xchanged');
  expect(text(el)).not.toContain('0xdeposit');
});

it('nothing_sent_without_a_click', async () => {
  const { el, calls } = await panel();
  await change(el, 'Destination chain', 'monad');
  await change(el, 'Destination address', OWNER);
  expect(button(el, 'Get deposit address').disabled).toBe(false);
  expect(calls).toEqual([]);
  expect('ethereum' in window).toBe(false);
});
