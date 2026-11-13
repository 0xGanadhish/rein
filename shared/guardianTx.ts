import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { DEPLOYMENTS } from './deployments';

/** Unsigned transactions for the Guardian flow. The owner's own wallet signs every one; Rein signs nothing. */

export type GuardianChain = 'base' | 'monad';

export interface UnsignedTx {
  step: 'approve_usdc' | 'deposit' | 'approve_shares' | 'enable' | 'disable';
  chainId: number;
  to: Address;
  data: Hex;
  value: '0';
  summary: string;
}

const CHAIN_IDS: Record<GuardianChain, number> = { base: 8453, monad: 143 };
const abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function enable(address vault, uint16 minConfidenceBps, uint32 maxAge)',
  'function disable(address vault)',
]);

export function parseUsdc(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  const units = m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0')) : 0n;
  if (units <= 0n) throw new Error('amount must be a positive USDC amount with at most 6 decimals');
  return units;
}

function menuVault(chain: GuardianChain, vault: Address): Address {
  const found = DEPLOYMENTS.mainnet.menu[chain]?.find((v) => v.toLowerCase() === vault.toLowerCase());
  if (!found) throw new Error(`vault is not on the ${chain} menu`);
  return found;
}

function guardianOf(chain: GuardianChain): Address {
  const guardian = DEPLOYMENTS.mainnet.guardians[chain];
  if (!guardian) throw new Error(`no Guardian on ${chain}`);
  return guardian;
}

function tx(chain: GuardianChain, step: UnsignedTx['step'], to: Address, data: Hex, summary: string): UnsignedTx {
  return { step, chainId: CHAIN_IDS[chain], to, data, value: '0', summary };
}

export function depositTxs(a: {
  chain: GuardianChain;
  vault: Address;
  owner: Address;
  amount: string;
  allowance?: bigint;
}): UnsignedTx[] {
  const vault = menuVault(a.chain, a.vault);
  const amount = parseUsdc(a.amount);
  const usdc = DEPLOYMENTS.mainnet.usdc[a.chain]!;
  const out: UnsignedTx[] = [];
  if ((a.allowance ?? 0n) < amount)
    out.push(
      tx(
        a.chain,
        'approve_usdc',
        usdc,
        encodeFunctionData({ abi, functionName: 'approve', args: [vault, amount] }),
        `Approve ${a.amount} USDC to the vault`,
      ),
    );
  out.push(
    tx(
      a.chain,
      'deposit',
      vault,
      encodeFunctionData({ abi, functionName: 'deposit', args: [amount, a.owner] }),
      `Deposit ${a.amount} USDC into the vault`,
    ),
  );
  return out;
}

export function armTxs(a: {
  chain: GuardianChain;
  vault: Address;
  shares: bigint;
  minConfidenceBps: number;
  maxAgeS: number;
  shareAllowance?: bigint;
}): UnsignedTx[] {
  const vault = menuVault(a.chain, a.vault);
  const ok = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  if (!ok(a.minConfidenceBps, 8000, 9900) || !ok(a.maxAgeS, 60, 3600)) throw new Error('rule out of range');
  const guardian = guardianOf(a.chain);
  const out: UnsignedTx[] = [];
  if ((a.shareAllowance ?? 0n) < a.shares)
    out.push(
      tx(
        a.chain,
        'approve_shares',
        vault,
        encodeFunctionData({ abi, functionName: 'approve', args: [guardian, a.shares] }),
        'Approve your vault shares to Guardian',
      ),
    );
  out.push(
    tx(
      a.chain,
      'enable',
      guardian,
      encodeFunctionData({ abi, functionName: 'enable', args: [vault, a.minConfidenceBps, a.maxAgeS] }),
      `Arm Guardian at ${a.minConfidenceBps} bps confidence and ${a.maxAgeS} s maximum verdict age`,
    ),
  );
  return out;
}

export function disarmTxs(a: { chain: GuardianChain; vault: Address }): UnsignedTx[] {
  const vault = menuVault(a.chain, a.vault);
  return [
    tx(
      a.chain,
      'disable',
      guardianOf(a.chain),
      encodeFunctionData({ abi, functionName: 'disable', args: [vault] }),
      'Disarm Guardian on this vault',
    ),
  ];
}
