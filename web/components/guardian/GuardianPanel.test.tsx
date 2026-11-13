// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { DEPLOYMENTS } from '../../../shared/deployments';
import { change, click, mount, type Mounted } from '../../test/dom';

const OWNER = '0x00000000000000000000000000000000000000aa';
const CLEARSTAR = '0xe1bca19baa63894d374578320551633320436523';
const MONAD_GUARDIAN = DEPLOYMENTS.mainnet.guardians.monad!;
const MONAD_USDC = DEPLOYMENTS.mainnet.usdc.monad!;

// Vault and Guardian reads; every call is recorded so a test can see the position re-read.
const reads: { address: string; functionName: string }[] = [];
vi.mock('viem', async (orig) => ({
  ...(await orig<typeof import('viem')>()),
  createPublicClient: () => ({
    async readContract({ address, functionName }: { address: string; functionName: string }) {
      reads.push({ address: address.toLowerCase(), functionName });
      if (functionName === 'decimals') return 18;
      if (functionName === 'approvedVault') return true;
      if (functionName === 'rules') return [false, 0, 0, 0n];
      if (functionName === 'balanceOf') return address.toLowerCase() === CLEARSTAR ? 0n : 1_000_000n;
      return 0n;
    },
    async waitForTransactionReceipt() {
      return { status: 'success' };
    },
  }),
}));
const { GuardianPanel } = await import('./GuardianPanel');

/** A browser wallet that records every request and starts on `chainId`. */
function wallet(chainId: number) {
  const requests: { method: string; params?: unknown }[] = [];
  let current = chainId;
  const eth = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      requests.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [OWNER];
      if (method === 'eth_chainId') return `0x${current.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        current = parseInt((params![0] as { chainId: string }).chainId, 16);
        return null;
      }
      if (method === 'eth_sendTransaction') return `0x${String(requests.length).padStart(64, '0')}`;
      return null;
    },
  };
  vi.stubGlobal('ethereum', eth);
  return { requests, sent: () => requests.filter((r) => r.method === 'eth_sendTransaction') };
}

let m: Mounted | undefined;
afterEach(() => {
  m?.unmount();
  reads.length = 0;
});
const panel = async () =>
  (m = await mount(
    GuardianPanel,
    {
      chain: 'monad',
      vaults: [{ vault: CLEARSTAR, name: 'Clearstar Earn USDC', short: '0xE1Bc…6523', withdrawable: null, exits: [] }],
      initial: CLEARSTAR,
      guardian: MONAD_GUARDIAN,
      rpc: 'https://rpc.test',
      sample: false,
      exitWorker: false,
      api: null,
    },
    {},
  ));

it('panel_switches_wallet_to_selected_chain', async () => {
  const w = wallet(8453);
  const { el } = await panel();
  await click(el, 'Connect wallet on Monad');
  expect(w.requests).toContainEqual({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x8f' }] });
});

it('deposit_sends_approve_then_deposit_and_reloads', async () => {
  const w = wallet(143);
  const { el } = await panel();
  await click(el, 'Connect wallet on Monad');
  const before = reads.filter((r) => r.address === CLEARSTAR && r.functionName === 'balanceOf').length;
  await change(el, 'Deposit USDC into this vault', '0.25');
  await click(el, 'Deposit');
  const to = w.sent().map((r) => ((r.params as { to: string }[])[0].to ?? '').toLowerCase());
  expect(to).toEqual([MONAD_USDC.toLowerCase(), CLEARSTAR]);
  const after = reads.filter((r) => r.address === CLEARSTAR && r.functionName === 'balanceOf').length;
  expect(after).toBeGreaterThan(before);
});

it('nothing_sent_without_a_click', async () => {
  const w = wallet(143);
  const { el } = await panel();
  await click(el, 'Connect wallet on Monad');
  expect(w.sent()).toEqual([]);
});
