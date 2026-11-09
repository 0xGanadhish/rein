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
const NEAR_EXPLORER: Record<Network, string> = {
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

/** Where to check the order yourself: the desk contract on NEAR, and the oracle post's transaction once it landed. */
export function proofLinks(
  o: { chain: DeskChain; post_tx?: string | null },
  network: Network,
  desk: string | null,
): { label: string; href: string }[] {
  const links: { label: string; href: string }[] = [];
  if (desk) links.push({ label: 'Order on the NEAR desk', href: `${NEAR_EXPLORER[network]}${desk}` });
  if (o.post_tx)
    links.push({ label: `Oracle post on ${CHAIN_LABEL[o.chain]}`, href: `${TX_EXPLORER[o.chain]}${o.post_tx}` });
  return links;
}
