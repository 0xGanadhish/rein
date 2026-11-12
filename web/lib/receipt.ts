import { keccak256, toHex } from 'viem';
import type { DeskInfo, OrderDetail } from './desk';
import { reasonLabels } from './format';
import type { DeskChain, DeskOrderStatus } from '../../shared/desk';
import type { Network } from './ledger';

const FLOW: DeskOrderStatus[] = ['open', 'exit_pending', 'signing', 'signed', 'delivered'];
const FAILED: DeskOrderStatus[] = ['rejected', 'refunded', 'post_failed'];

export const STATUS_LABEL: Record<DeskOrderStatus, string> = {
  open: 'Open',
  exit_pending: 'EXIT pending',
  signing: 'Signing',
  signed: 'Signed',
  delivered: 'Delivered',
  rejected: 'Rejected',
  refunded: 'Refunded',
  post_failed: 'Post failed',
};
export const CHAIN_LABEL: Record<DeskChain, string> = {
  base: 'Base',
  monad: 'Monad',
  'monad-testnet': 'Monad testnet',
  'base-sepolia': 'Base Sepolia',
};
const TX_EXPLORER: Record<DeskChain, string> = {
  base: 'https://basescan.org/tx/',
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
  monad: 'https://monadscan.com/tx/',
  'monad-testnet': 'https://testnet.monadscan.com/tx/',
};
export const NEAR_EXPLORER: Record<Network, string> = {
  mainnet: 'https://nearblocks.io/address/',
  testnet: 'https://testnet.nearblocks.io/address/',
};

interface TrackOrder {
  status: DeskOrderStatus;
  judge_calls: unknown[];
  posts: { verdict: string }[];
}

/** An EXIT reading goes through exit_pending; other orders skip it. Extra judge calls can be retries, so they don't count. */
export const isExitOrder = (o: TrackOrder) => o.posts.at(-1)?.verdict === 'EXIT' || o.status === 'exit_pending';

/** The status bar: each step of the happy path, done or not, and where the order is now. A failed order ends in its failure. */
export function statusTrack(o: TrackOrder): { status: DeskOrderStatus; label: string; done: boolean; now: boolean }[] {
  const failed = FAILED.includes(o.status);
  const reached = FLOW.indexOf(o.status);
  const track = FLOW.filter((st) => st !== 'exit_pending' || isExitOrder(o)).map((st) => ({
    status: st,
    label: STATUS_LABEL[st],
    done: !failed && reached >= FLOW.indexOf(st),
    now: st === o.status,
  }));
  return failed ? [...track, { status: o.status, label: STATUS_LABEL[o.status], done: true, now: true }] : track;
}

export interface ProofStep {
  label: string;
  detail: string;
  href?: string;
  check?: 'ok' | 'fail' | null;
}

/** Local checks bind the stored document and current signer list, not the model's judgement or its attestation. */
export function proofChain(
  o: Pick<OrderDetail, 'id' | 'chain' | 'posts' | 'judge_calls' | 'post_tx'>,
  network: Network,
  cfg: { desk: string | null } & {
    signers: DeskInfo['signers'] | null;
    derived_address: string | null;
  },
): ProofStep[] {
  const steps: ProofStep[] = [
    {
      label: 'Order on the NEAR desk',
      detail: `Order #${o.id} · ${cfg.desk ?? 'desk unavailable'}`,
      ...(cfg.desk ? { href: `${NEAR_EXPLORER[network]}${cfg.desk}` } : {}),
    },
  ];
  const post = o.posts.at(-1);
  if (post?.doc != null) {
    steps.push({
      label: 'Reading document',
      detail: post.doc,
      check: keccak256(toHex(post.doc)).toLowerCase() === post.state_hash.toLowerCase() ? 'ok' : 'fail',
    });
  }
  const signer = o.judge_calls.at(-1)?.signing_address;
  if (signer) {
    steps.push({
      label: 'Model signer',
      detail: `${signer} · current desk signer list${cfg.signers === null ? ' unavailable' : ''}`,
      check:
        cfg.signers === null ? null : cfg.signers.some((s) => s.toLowerCase() === signer.toLowerCase()) ? 'ok' : 'fail',
    });
  }
  if (o.post_tx) {
    steps.push({
      label: 'Chain Signatures post',
      detail: `${CHAIN_LABEL[o.chain]} · desk-derived signer ${cfg.derived_address ?? 'unavailable'}`,
      href: `${TX_EXPLORER[o.chain]}${o.post_tx}`,
    });
  }
  if (post?.resolved) {
    const reasons = reasonLabels(post.reasons);
    steps.push({
      label: 'Grade',
      detail: `${post.adverse ? 'Adverse' : 'Clean'}${reasons.length ? ` · ${reasons.join(', ')}` : ''}`,
    });
  }
  return steps;
}
