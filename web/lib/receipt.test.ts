import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { DeskOrderStatus } from '../../shared/desk';
import { isExitOrder, proofChain, statusTrack } from './receipt';
import type { OrderPost } from './desk';

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

const cfg = {
  desk: 'rein-desk.testnet',
  signers: ['0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'],
  derived_address: '0x1234567890123456789012345678901234567890',
};
const doc = 'rein-v1|chain=monad-testnet|apy_bps=na';
const post: OrderPost = {
  chain: 'monad-testnet',
  id: 1,
  verdict: 'HOLD',
  confidence_bps: 8000,
  risk_bps: 2000,
  state_hash: keccak256(toHex(doc)),
  posted_at: 1,
  input_check: 'match',
  resolved: 0,
  adverse: null,
  reasons: null,
  doc,
};

describe('receipt', () => {
  it('proof_chain_verifies_doc_hash', () => {
    const o = { ...order('delivered'), posts: [post] };
    expect(proofChain(o, 'testnet', cfg)[1].check).toBe('ok');
    expect(proofChain({ ...o, posts: [{ ...post, doc: doc + 'x' }] }, 'testnet', cfg)[1].check).toBe('fail');
  });

  it('proof_chain_checks_signer_list', () => {
    const o = {
      ...order('delivered'),
      posts: [post],
      judge_calls: [{ at: 1, signing_address: cfg.signers[0].toUpperCase() }],
    };
    expect(proofChain(o, 'testnet', cfg).find((s) => s.label === 'Model signer')?.check).toBe('ok');
    expect(proofChain(o, 'testnet', { ...cfg, signers: [] }).find((s) => s.label === 'Model signer')?.check).toBe(
      'fail',
    );
    expect(
      proofChain(o, 'testnet', { ...cfg, signers: null }).find((s) => s.label === 'Model signer')?.check,
    ).toBeNull();
  });

  it('chain_partial_before_post', () => {
    for (const status of ['open', 'signing'] as const) {
      const chain = proofChain(order(status), 'testnet', cfg);
      expect(chain).toEqual([
        {
          label: 'Order on the NEAR desk',
          detail: 'Order #7 · rein-desk.testnet',
          href: 'https://testnet.nearblocks.io/address/rein-desk.testnet',
        },
      ]);
      expect(chain.some((s) => s.check === 'ok')).toBe(false);
    }
  });

  it('grade_step_absent_until_resolved', () => {
    const o = { ...order('delivered', '0xabc'), posts: [post] };
    expect(proofChain(o, 'testnet', cfg).some((s) => s.label === 'Grade')).toBe(false);
    const chain = proofChain({ ...o, posts: [{ ...post, resolved: 1, adverse: 1, reasons: 5 }] }, 'testnet', cfg);
    expect(chain.find((s) => s.label === 'Grade')?.detail).toContain('Adverse · share price fell, liquidity under 5%');
    expect(chain.find((s) => s.label === 'Chain Signatures post')).toEqual({
      label: 'Chain Signatures post',
      detail: `Monad testnet · desk-derived signer ${cfg.derived_address}`,
      href: 'https://testnet.monadscan.com/tx/0xabc',
    });
  });

  it('order_status_walks_open_to_delivered_with_links', () => {
    expect(statusTrack(order('open')).map((s) => s.status)).toEqual(['open', 'signing', 'signed', 'delivered']);
    expect(done('open')).toEqual(['open']);
    expect(done('signing')).toEqual(['open', 'signing']);
    expect(done('signed')).toEqual(['open', 'signing', 'signed']);
    expect(done('delivered')).toEqual(['open', 'signing', 'signed', 'delivered']);
    expect(statusTrack(order('signed')).find((s) => s.now)?.status).toBe('signed');
  });

  it('retried_judge_calls_do_not_make_a_hold_an_exit', () => {
    const retried = { ...order('delivered'), judge_calls: [{}, {}, {}], posts: [{ verdict: 'HOLD' }] };
    expect(isExitOrder(retried)).toBe(false);
    expect(statusTrack(retried).map((s) => s.status)).not.toContain('exit_pending');
    expect(isExitOrder({ ...retried, posts: [{ verdict: 'EXIT' }] })).toBe(true);
  });
});
