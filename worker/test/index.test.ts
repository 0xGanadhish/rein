import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { encodeFunctionData, keccak256, serializeTransaction, toBytes } from 'viem';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import type { DeskOrder, DeskPolicy } from '../../shared/desk';
import { oracleAbi } from '../src/abis';
import type { DeskClient } from '../src/deskTypes';
import { tick } from '../src/index';
import { BroadcastJournal } from '../src/journal';
import type { NearNetwork } from '../src/env';
import type { OrderDeps } from '../src/order';

const NOW = 1_793_774_225;
const RAW = serializeTransaction(
  {
    type: 'eip1559',
    chainId: 8453,
    nonce: 5,
    gas: 1_000_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    to: '0x0000000000000000000000000000000000000011',
    data: encodeFunctionData({
      abi: oracleAbi,
      functionName: 'post',
      args: [
        '0x00000000000000000000000000000000000000aa',
        0,
        9000,
        500,
        keccak256(toBytes('rein-v1|order=349|chain=base')),
        BigInt(NOW + 600),
      ],
    }),
  },
  { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, yParity: 0 },
);
function order(id: number, patch: Partial<DeskOrder> = {}): DeskOrder {
  return {
    id,
    source: 'near',
    payer: 'alice.testnet',
    chain: 'base',
    vault: '0x00000000000000000000000000000000000000aa',
    amount: '1',
    created_s: NOW - 60,
    status: 'signed',
    exit_pending_s: null,
    valid_until: NOW + 600,
    ...patch,
  };
}
function setup(orders: DeskOrder[], network: NearNetwork = 'mainnet') {
  const pages: number[] = [];
  const desk = {
    open_orders: async (limit: number) => orders.filter((o) => o.status === 'open').slice(0, limit),
    list_orders: async (from: number, limit: number) => {
      pages.push(from);
      return orders.filter((o) => o.id >= from && o.id < from + limit);
    },
    next_order_id: async () => Math.max(...orders.map((o) => o.id)) + 1,
    policy: async () => ({ exit_confirm_min_s: 30, exit_confirm_max_s: 300 }) as DeskPolicy,
    get_signed_tx: async (id: number) => (id === 349 ? RAW : null),
    derived_address: async () => '0x000000000000000000000000000000000000dead',
    reject: async () => {},
    report_delivery: async () => {},
  } as unknown as DeskClient;
  return {
    pages,
    deps: {
      desk,
      journal: new BroadcastJournal(env.DB, network),
      now: () => NOW,
      chain: () => ({
        balance: async () => 0n,
        receipt: async () => ({ status: 'success', gasUsed: 1n, effectiveGasPrice: 1n }),
      }),
    } as unknown as OrderDeps,
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM cursors').run();
  await env.DB.prepare('DELETE FROM locks').run();
  await env.DB.prepare('DELETE FROM broadcast_attempts').run();
  await env.DB.prepare('DELETE FROM pending_nonces').run();
});

it('stuck_orders_do_not_starve_later_ones', async () => {
  const orders = Array.from({ length: 350 }, (_, id) => order(id));
  orders.unshift(...Array.from({ length: 35 }, (_, i) => order(400 + i, { status: 'open' })));
  const seen = new Set<number>();
  let delivered = false;
  for (let n = 0; n < 50; n++) {
    // Recreating dependencies ensures progress lives in D1, not in a runner instance.
    const fresh = setup(orders);
    const result = await tick(env, 'mainnet', fresh.deps);
    Object.keys(result).forEach((id) => seen.add(Number(id)));
    if (result[349] === 'delivered') delivered = true;
  }
  expect(seen.has(349)).toBe(true);
  expect(seen.has(434)).toBe(true);
  expect(delivered).toBe(true);
  const other = await tick(
    env,
    'testnet',
    setup(
      orders.map((o) => ({ ...o, chain: 'base-sepolia' })),
      'testnet',
    ).deps,
  );
  expect(Object.keys(other).some((id) => Number(id) < 100)).toBe(true);
});

it('no_work_orders_do_not_consume_chain_slots', async () => {
  const orders = Array.from({ length: 30 }, (_, id) =>
    order(id, {
      status: id % 2 ? 'signing' : 'exit_pending',
      exit_pending_s: id % 4 ? null : NOW - 10,
    }),
  );
  orders.push(order(30));
  const result = await tick(env, 'mainnet', setup(orders).deps);
  expect(Object.keys(result)).toEqual(['30']);
});

it('new_order_beyond_scan_window_runs_next_tick', async () => {
  const orders = Array.from({ length: 1_000 }, (_, id) => order(id));
  orders[2].status = 'open';
  orders.push(order(1_001, { chain: 'monad', status: 'open' }), order(1_002, { status: 'open' }));
  const rejected: number[] = [];
  const fresh = setup(orders);
  fresh.deps.desk.reject = async (id) => {
    orders.find((o) => o.id === id)!.status = 'rejected';
    rejected.push(id);
  };
  const first = await tick(env, 'mainnet', fresh.deps);
  expect(first[1_002]).toBe('rejected');
  expect(first[1_001]).toBe('rejected');
  // A fast-path order also found by the rotating scan must advance only once.
  expect(rejected.sort((a, b) => a - b)).toEqual([2, 1_001, 1_002]);
  const scanned = Object.keys(first)
    .map(Number)
    .filter((id) => id < 1_000);
  expect(scanned.length).toBeGreaterThan(0);
  expect(
    Object.keys(first).filter((id) => orders.find((o) => o.id === Number(id))!.chain === 'base').length,
  ).toBeLessThanOrEqual(10);
  const second = await tick(env, 'mainnet', setup(orders).deps);
  const later = Object.keys(second)
    .map(Number)
    .filter((id) => id < 1_000);
  expect(later.length).toBeGreaterThan(0);
  expect(later.every((id) => !scanned.includes(id))).toBe(true);
});
