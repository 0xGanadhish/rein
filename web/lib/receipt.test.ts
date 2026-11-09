import { describe, expect, it } from 'vitest';
import type { DeskOrderStatus } from '../../shared/desk';
import { isExitOrder, proofLinks, statusTrack } from './receipt';

const order = (status: DeskOrderStatus, post_tx: string | null = null) => ({
  id: 7,
  chain: 'monad-testnet' as const,
  status,
  judge_calls: [],
  posts: [],
  post_tx,
});
const done = (status: DeskOrderStatus) =>
  statusTrack(order(status))
    .filter((s) => s.done)
    .map((s) => s.status);

describe('receipt', () => {
  it('order_status_walks_open_to_delivered_with_links', () => {
    expect(statusTrack(order('open')).map((s) => s.status)).toEqual(['open', 'signing', 'signed', 'delivered']);
    expect(done('open')).toEqual(['open']);
    expect(done('signing')).toEqual(['open', 'signing']);
    expect(done('signed')).toEqual(['open', 'signing', 'signed']);
    expect(done('delivered')).toEqual(['open', 'signing', 'signed', 'delivered']);
    expect(statusTrack(order('signed')).find((s) => s.now)?.status).toBe('signed');

    expect(proofLinks(order('open'), 'testnet', 'rein-desk.testnet')).toEqual([
      { label: 'Order on the NEAR desk', href: 'https://testnet.nearblocks.io/address/rein-desk.testnet' },
    ]);
    expect(proofLinks(order('delivered', '0xabc'), 'testnet', 'rein-desk.testnet')).toEqual([
      { label: 'Order on the NEAR desk', href: 'https://testnet.nearblocks.io/address/rein-desk.testnet' },
      { label: 'Oracle post on Monad testnet', href: 'https://testnet.monadscan.com/tx/0xabc' },
    ]);
  });

  it('retried_judge_calls_do_not_make_a_hold_an_exit', () => {
    const retried = { ...order('delivered'), judge_calls: [{}, {}, {}], posts: [{ verdict: 'HOLD' }] };
    expect(isExitOrder(retried)).toBe(false);
    expect(statusTrack(retried).map((s) => s.status)).not.toContain('exit_pending');
    expect(isExitOrder({ ...retried, posts: [{ verdict: 'EXIT' }] })).toBe(true);
  });
});
