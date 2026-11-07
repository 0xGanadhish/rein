import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { encodeFunctionData, keccak256, serializeTransaction, type Hex } from 'viem';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { oracleAbi } from '../src/abis';
import type { DeskClient, DeskOrder } from '../src/deskTypes';
import { BroadcastJournal } from '../src/journal';
import { processOrder, type ChainClient, type OrderDeps, type Receipt } from '../src/order';

const NOW = 1_793_774_225;
const ORACLE = '0x0000000000000000000000000000000000000011';
const VAULT = '0x0000000000000000000000000000000000000022';
function raw(nonce: number, orderId = 7): Hex {
  return serializeTransaction({ type: 'eip1559', chainId: 8453, nonce, gas: 1_000_000n,
    maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: ORACLE,
    data: encodeFunctionData({ abi: oracleAbi, functionName: 'post', args: [VAULT, 0, 9000, 1000, keccak256(new TextEncoder().encode(`rein-v1|order=${orderId}|chain=base`)), BigInt(NOW + 100)] }),
  }, { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, yParity: 0 });
}
function setup() {
  const order: DeskOrder = { id: 7, source: 'near', payer: 'alice.testnet', chain: 'base', vault: VAULT,
    amount: '1', created_s: NOW - 10, status: 'signed', exit_pending_s: null, valid_until: NOW + 100 };
  let signed = raw(5);
  let now = NOW;
  let posted = false;
  let sends = 0;
  let resigns = 0;
  let refunds = 0;
  let gas = 0n;
  let reported: string | null = null;
  const receipts = new Map<Hex, Receipt>();
  const desk = {
    get_signed_tx: async () => signed,
    get_order: async () => ({ ...order }),
    report_delivery: async (_id: number, hash: string, fee: string) => {
      if (order.status !== 'signed') throw new Error('order is not signed');
      order.status = 'delivered'; gas += BigInt(fee); reported = hash;
    },
    fail_post: async (_id: number, _hash: string | null, fee: string) => { order.status = 'post_failed'; gas += BigInt(fee); refunds++; },
    resign: async () => { resigns++; },
    derived_address: async () => VAULT,
  } as unknown as DeskClient;
  const chain = {
    statePosted: async () => posted,
    receipt: async (hash: Hex) => receipts.get(hash) ?? null,
    nonce: async (_address: string, blockTag?: string) => blockTag === 'latest' ? 5 : 7,
    fees: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    sendRaw: async (tx: Hex) => { sends++; throw new Error('nonce too low'); },
  } as unknown as ChainClient;
  const deps: OrderDeps = { desk, chain: () => chain, now: () => now, alert: async () => {},
    read: async () => { throw new Error('signed recovery must not read the vault'); },
    flows: async () => { throw new Error('signed recovery must not fetch flows'); },
    judge: async () => { throw new Error('signed recovery must not call the model'); },
    journal: new BroadcastJournal(env.DB, 'mainnet') };
  return { order, deps, chain, receipts,
    setSigned(tx: Hex) { signed = tx; }, setNow(value: number) { now = value; }, setPosted() { posted = true; },
    state: () => ({ sends, resigns, refunds, gas, reported }),
  };
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM broadcast_attempts').run();
  await env.DB.prepare('DELETE FROM pending_nonces').run();
});

it('broadcast_crash_recovers_the_landed_attempt_without_refunding', async () => {
  const s = setup();
  let sends = 0;
  s.chain.sendRaw = async (tx) => {
    sends++;
    const attempt = await env.DB.prepare('SELECT hash FROM broadcast_attempts WHERE order_id = 7').first<{ hash: string }>();
    expect(attempt?.hash).toBe(keccak256(tx));
    s.receipts.set(keccak256(tx), { status: 'success', gasUsed: 10n, effectiveGasPrice: 3n, l1Fee: 4n });
    throw new Error('broadcast response lost');
  };
  expect(await processOrder(s.order, s.deps)).toBe('pending');
  s.setSigned(raw(6));
  s.setPosted();
  s.receipts.set(keccak256(raw(6)), { status: 'reverted', gasUsed: 2n, effectiveGasPrice: 3n });
  const recovered = { ...s.deps, journal: new BroadcastJournal(env.DB, 'mainnet') };
  expect(await processOrder(s.order, recovered)).toBe('delivered');
  expect(await processOrder(s.order, recovered)).toBe('delivered');
  expect(s.state()).toMatchObject({ refunds: 0, gas: 34n, reported: keccak256(raw(5)) });
  expect(sends).toBe(1);
  expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM pending_nonces').first<number>('n')).toBe(0);
});

it('pending_nonce_ownership_prevents_stranding_an_earlier_attempt', async () => {
  const s = setup();
  await s.deps.journal.record(s.order, raw(5), NOW, s.deps.desk);
  s.setSigned(raw(6));
  expect(await processOrder(s.order, s.deps)).toBe('pending');
  expect(s.state()).toMatchObject({ resigns: 0, refunds: 0 });
  const other = { ...s.order, id: 8 };
  s.setSigned(raw(5));
  const sentBefore = s.state().sends;
  expect(await processOrder(other, s.deps)).toBe('pending');
  expect(s.state().sends).toBe(sentBefore);
  s.setSigned(raw(6));
  s.receipts.set(keccak256(raw(6)), { status: 'reverted', gasUsed: 2n, effectiveGasPrice: 3n });
  expect(await processOrder(s.order, s.deps)).toBe('pending');
  expect(s.state().refunds).toBe(0);
  s.setNow(NOW + 131);
  expect(await processOrder(s.order, s.deps)).toBe('rejected');
  expect(s.state()).toMatchObject({ resigns: 0, refunds: 1, gas: 6n });
});

it('terminal_nonce_owners_are_reclaimed_after_cleanup_failure', async () => {
  const s = setup();
  s.setNow(NOW + 131);
  s.deps.journal.release = async () => { throw new Error('D1 cleanup unavailable'); };
  await expect(processOrder(s.order, s.deps)).rejects.toThrow('D1 cleanup unavailable');
  expect(s.state().refunds).toBe(1);
  // The expired transaction never mined; nonce 5 is still the chain's next usable nonce.
  const restarted = new BroadcastJournal(env.DB, 'mainnet');
  expect(await restarted.nextNonce('base', 5, s.deps.desk)).toBe(5);
  // An already-signed contender must also recover without allocating/signing another transaction first.
  await restarted.record(s.order, raw(5), NOW, s.deps.desk);
  const contender: DeskOrder = { ...s.order, id: 8, status: 'signed', valid_until: NOW + 200 };
  const contenderRaw = raw(5, 8);
  let reportedFee = '';
  const desk = { ...s.deps.desk,
    get_signed_tx: async () => contenderRaw,
    get_order: async (id: number) => id === 7 ? { ...s.order } : { ...contender },
    report_delivery: async (_id: number, _hash: string, fee: string) => { contender.status = 'delivered'; reportedFee = fee; },
  };
  s.chain.sendRaw = async (tx) => {
    const hash = keccak256(tx);
    s.receipts.set(hash, { status: 'success', gasUsed: 10n, effectiveGasPrice: 3n });
    return hash;
  };
  expect(await processOrder(contender, { ...s.deps, desk, journal: restarted })).toBe('delivered');
  expect(reportedFee).toBe('30');
});
