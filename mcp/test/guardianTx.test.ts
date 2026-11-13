import { decodeFunctionData, getAddress, parseAbi } from 'viem';
import { expect, it } from 'vitest';
import { DEPLOYMENTS } from '../../shared/deployments';
import { armTxs, depositTxs } from '../../shared/guardianTx';

const abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function enable(address vault, uint16 minConfidenceBps, uint32 maxAge)',
]);
const CLEARSTAR = '0xE1BcA19baA63894D374578320551633320436523' as const;
const GROVE = '0xbeef0786756810478b88982DE00F3CD7fdB8e7c7' as const;
const O = '0x00000000000000000000000000000000000000aa' as const;
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const BASE_GUARDIAN = '0xe941433777B80eB559BaA2929C5b332e6E49a7d3';
const decode = (data: `0x${string}`) => decodeFunctionData({ abi, data });

it('deposit_builds_exact_usdc_approve_then_deposit', () => {
  const txs = depositTxs({ chain: 'monad', vault: CLEARSTAR, owner: O, amount: '0.25' });
  expect(txs.map((t) => t.step)).toEqual(['approve_usdc', 'deposit']);
  expect(txs[0].to).toBe(MONAD_USDC);
  expect(DEPLOYMENTS.mainnet.usdc.monad).toBe(MONAD_USDC);
  expect(decode(txs[0].data)).toEqual({ functionName: 'approve', args: [CLEARSTAR, 250000n] });
  expect(txs[1].to).toBe(CLEARSTAR);
  expect(decode(txs[1].data)).toEqual({ functionName: 'deposit', args: [250000n, getAddress(O)] });
  expect(txs.every((t) => t.chainId === 143 && t.value === '0')).toBe(true);
});

it('deposit_skips_usdc_approve_when_allowance_covers', () => {
  const txs = depositTxs({ chain: 'monad', vault: CLEARSTAR, owner: O, amount: '0.25', allowance: 250000n });
  expect(txs.map((t) => t.step)).toEqual(['deposit']);
});

it('rejects_bad_amounts', () => {
  for (const amount of ['0', '-1', '1.0000001', 'abc'])
    expect(() => depositTxs({ chain: 'monad', vault: CLEARSTAR, owner: O, amount })).toThrow(
      'amount must be a positive USDC amount with at most 6 decimals',
    );
});

it('arm_approves_current_shares_not_deposit_amount', () => {
  const shares = 958571300000000000000n;
  const txs = armTxs({ chain: 'base', vault: GROVE, shares, minConfidenceBps: 9000, maxAgeS: 600 });
  expect(txs.map((t) => t.step)).toEqual(['approve_shares', 'enable']);
  expect(txs[0].to).toBe(GROVE);
  expect(decode(txs[0].data)).toEqual({ functionName: 'approve', args: [BASE_GUARDIAN, shares] });
  expect(txs[1].to).toBe(BASE_GUARDIAN);
  expect(decode(txs[1].data)).toEqual({ functionName: 'enable', args: [GROVE, 9000, 600] });
  expect(txs.every((t) => t.chainId === 8453)).toBe(true);
});

it('arm_rejects_rule_out_of_range', () => {
  const base = { chain: 'base' as const, vault: GROVE, shares: 1n, minConfidenceBps: 9000, maxAgeS: 600 };
  for (const bad of [{ minConfidenceBps: 7999 }, { minConfidenceBps: 9901 }, { maxAgeS: 59 }, { maxAgeS: 3601 }])
    expect(() => armTxs({ ...base, ...bad })).toThrow('rule out of range');
});

it('rejects_vault_off_menu', () => {
  expect(() => depositTxs({ chain: 'monad', vault: GROVE, owner: O, amount: '1' })).toThrow(
    'vault is not on the monad menu',
  );
});
