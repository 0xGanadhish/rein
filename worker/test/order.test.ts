import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { keccak256, serializeTransaction, type Hex } from 'viem';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskPolicy, DeskStats } from '../../shared/desk';
import type { DeskClient, DeskOrder, DeskPrompt, DeskTx } from '../src/deskTypes';
import type { VaultReading } from '../src/doc';
import { postArgs } from '../src/broadcast';
import { JudgeError, type judge as realJudge } from '../src/judge';
import { withLock } from '../src/lock';
import { BroadcastJournal } from '../src/journal';
import { processOrder, type ChainClient, type OrderDeps, type Receipt } from '../src/order';

const DERIVED = '0x000000000000000000000000000000000000dead';
const T0 = 1_793_774_225;

function raw(nonce: number): Hex {
  return serializeTransaction({ type: 'eip1559', chainId: 8453, nonce, gas: 1_000_000n, maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n, to: DERIVED, data: '0x' },
  { r: `0x${'01'.repeat(32)}`, s: `0x${'02'.repeat(32)}`, yParity: 0 });
}

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM broadcast_attempts').run();
  await env.DB.prepare('DELETE FROM pending_nonces').run();
});

type Call = [string, ...unknown[]];

class FakeDesk implements DeskClient {
  calls: Call[] = [];
  orders = new Map<number, DeskOrder>();
  signedTx = new Map<number, string>();
  checks: string[] = [];
  fulfilError: Error | null = null;
  signedCount = 0;
  gas = 0n;
  reportLost = false;
  failureLost = false;
  exitMin = 45;
  exitMax = 240;
  constructor(public clock: { now: number }) {}

  add(o: Partial<DeskOrder> = {}): DeskOrder {
    const order: DeskOrder = {
      id: 7, source: 'near', payer: 'alice.testnet', chain: 'base',
      vault: '0x00000000000000000000000000000000000000aa', amount: '1000000', created_s: T0 - 60, status: 'open', exit_pending_s: null, valid_until: null, ...o,
    };
    this.orders.set(order.id, order);
    return { ...order };
  }
  private set(id: number, patch: Partial<DeskOrder>) { this.orders.set(id, { ...this.orders.get(id)!, ...patch }); }
  private sign(id: number) { this.signedTx.set(id, raw(++this.signedCount)); this.set(id, { status: 'signed' }); }
  named(name: string) { return this.calls.filter((c) => c[0] === name); }

  async open_orders() { return [...this.orders.values()].filter((o) => o.status === 'open'); }
  async list_orders() { return [...this.orders.values()]; }
  async next_order_id() { return Math.max(0, ...this.orders.keys()) + 1; }
  async get_order(id: number) {
    const o = this.orders.get(id);
    if (!o) return null;
    return o.status === 'exit_pending' && o.exit_pending_s !== null && this.clock.now > o.exit_pending_s + this.exitMax
      ? { ...o, status: 'open' as const, exit_pending_s: null }
      : { ...o };
  }
  async policy() { return { deadline_s: 1800, exit_confirm_min_s: this.exitMin, exit_confirm_max_s: this.exitMax } as DeskPolicy; }
  async menu() { return []; }
  async stats() { return {} as DeskStats; }
  async submit_watch_request(): Promise<number> { throw new Error('not used'); }
  async submit_x402_request(): Promise<number> { throw new Error('not used'); }
  async prompt(): Promise<DeskPrompt> { return { model: 'm', prefix: 'P[', suffix: ']S' }; }
  async signers() { return ['0xsigner']; }
  async get_signed_tx(id: number) { return this.signedTx.get(id) ?? null; }
  async derived_address() { return DERIVED; }
  async check_reading(...a: [number, string, string, string]) { this.calls.push(['check_reading', ...a]); return this.checks.shift() ?? 'ok'; }
  async fulfil(id: number, doc: string, response: string, signature: string, tx: DeskTx) {
    this.calls.push(['fulfil', id, doc, response, signature, tx]);
    if (this.fulfilError) throw this.fulfilError;
    if (response.includes('EXIT')) this.set(id, { status: 'exit_pending', exit_pending_s: this.clock.now });
    else this.sign(id);
  }
  async confirm_exit(id: number, doc: string, response: string, signature: string, tx: DeskTx) {
    this.calls.push(['confirm_exit', id, doc, response, signature, tx]);
    this.sign(id);
  }
  async resign(id: number, tx: DeskTx) { this.calls.push(['resign', id, tx]); this.sign(id); }
  async report_delivery(id: number, hash: string, gas: string) {
    if (this.orders.get(id)?.status !== 'signed') throw new Error('order is not signed');
    this.calls.push(['report_delivery', id, hash, gas]);
    this.gas += BigInt(gas);
    this.set(id, { status: 'delivered' });
    if (this.reportLost) throw new Error('response lost');
  }
  async fail_post(id: number, hash: string | null, gas: string, reason: string) {
    if (this.orders.get(id)?.status !== 'signed') throw new Error('order is not signed');
    this.calls.push(['fail_post', id, hash, gas, reason]);
    this.gas += BigInt(gas);
    this.set(id, { status: 'post_failed' });
    if (this.failureLost) throw new Error('response lost');
  }
  async reject(id: number, reason: string) { this.calls.push(['reject', id, reason]); this.set(id, { status: 'rejected' }); }
}

class FakeChain implements ChainClient {
  calls: Call[] = [];
  balanceWei = 10n ** 18n;
  simulation: { ok: true } | { ok: false; reason: string } = { ok: true };
  sendErrors: Error[] = [];
  receipts = new Map<string, Receipt>();
  posted = false;
  async statePosted() { return this.posted; }
  async balance(a: string) { this.calls.push(['balance', a]); return this.balanceWei; }
  async nonce() { return 5; }
  async fees() { return { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }; }
  async simulate(c: Parameters<ChainClient['simulate']>[0]) { this.calls.push(['simulate', c]); return this.simulation; }
  async sendRaw(raw: `0x${string}`) {
    this.calls.push(['sendRaw', raw]);
    const e = this.sendErrors.shift();
    if (e) throw e;
    const hash = keccak256(raw);
    this.receipts.set(hash, { status: 'success', gasUsed: 50_000n, effectiveGasPrice: 1_500_000_000n });
    return hash;
  }
  async receipt(hash: `0x${string}`) { return this.receipts.get(hash) ?? null; }
}

const answer = (verdict: string) => `{"id":"c1","choices":[{"message":{"content":"{\\"verdict\\":\\"${verdict}\\"}"}}]}`;

function setup(opts: { verdict?: string; readings?: VaultReading[] } = {}) {
  const clock = { now: T0 };
  const desk = new FakeDesk(clock);
  const chain = new FakeChain();
  const alerts: string[] = [];
  const judgeCalls: string[] = [];
  const reads: string[] = [];
  let judgeImpl = async (doc: string) => ({
    request: `P[${doc}]S`, response: answer(opts.verdict ?? 'HOLD'), signature: '0xsig', signingAddress: '0xsigner', costUsdMicros: 3,
  });
  let readImpl = async (): Promise<VaultReading> => {
    const r = opts.readings?.[reads.length - 1];
    return r ?? { block: BigInt(100 + reads.length), name: 'V', pps: 1_000_000n, totalAssets: 5n, liquidityPct: 50, apyBps: 500, apyBpsPrev: 500, utilBps: 5000 };
  };
  const deps: OrderDeps = {
    desk,
    journal: new BroadcastJournal(env.DB, 'mainnet'),
    read: async (c, v) => { reads.push(`${c}:${v}`); return readImpl(); },
    flows: async () => ({ netOutPct1h: 0.5 }),
    judge: (async (doc: string) => { judgeCalls.push(doc); return judgeImpl(doc); }) as typeof realJudge,
    chain: () => chain,
    now: () => clock.now,
    alert: async (m) => { alerts.push(m); },
  };
  return {
    clock, desk, chain, alerts, judgeCalls, reads, deps,
    setJudge(f: typeof judgeImpl) { judgeImpl = f; },
    setRead(f: typeof readImpl) { readImpl = f; },
  };
}

describe('processOrder', () => {
  it('hold_order_fulfils_broadcasts_reports', async () => {
    const s = setup();
    const order = s.desk.add();
    expect(await processOrder(order, s.deps)).toBe('delivered');
    const [fulfil] = s.desk.named('fulfil');
    expect(fulfil[1]).toBe(7);
    expect(fulfil[2]).toMatch(/^rein-v1\|order=7\|chain=base\|/);
    expect(fulfil[3]).toBe(answer('HOLD'));
    expect(fulfil[5]).toEqual({ nonce: 5, max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000' });
    expect(s.chain.calls.filter((c) => c[0] === 'sendRaw')).toEqual([['sendRaw', raw(1)]]);
    expect(s.desk.named('report_delivery')).toEqual([['report_delivery', 7, keccak256(raw(1)), '75000000000000']]);
    expect(s.chain.calls.find((c) => c[0] === 'simulate')?.[1]).toMatchObject({ validUntil: T0 + 1800 });
    expect(s.desk.orders.get(7)!.status).toBe('delivered');
  });

  it('exit_order_confirms_after_30s_with_new_reading', async () => {
    const s = setup({ verdict: 'EXIT' });
    expect(await processOrder(s.desk.add(), s.deps)).toBe('pending');
    expect(s.desk.orders.get(7)!.status).toBe('exit_pending');
    expect(s.chain.calls.some((c) => c[0] === 'sendRaw')).toBe(false);

    s.clock.now = T0 + 10;
    expect(await processOrder(await s.desk.get_order(7) as DeskOrder, s.deps)).toBe('pending');
    expect(s.desk.named('confirm_exit')).toHaveLength(0);

    s.clock.now = T0 + 46;
    expect(await processOrder(await s.desk.get_order(7) as DeskOrder, s.deps)).toBe('delivered');
    expect(s.reads).toHaveLength(2);
    const [confirm] = s.desk.named('confirm_exit');
    const firstDoc = s.desk.named('fulfil')[0][2] as string;
    expect(confirm[2]).not.toBe(firstDoc);
    expect(confirm[2]).toMatch(/\|at=1793774271\|block=102\|/);
    expect(s.desk.named('fulfil')).toHaveLength(1);
    expect(s.desk.named('report_delivery')).toHaveLength(1);
  });

  it('vault_read_failure_rejects_with_reason', async () => {
    const s = setup();
    s.setRead(async () => { throw new Error('execution reverted'); });
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'vault read failed: execution reverted']]);
    expect(s.judgeCalls).toHaveLength(0);
  });

  it('judge_unavailable_rejects', async () => {
    const s = setup();
    s.setJudge(async () => { throw new JudgeError('completion', 'HTTP 503'); });
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'judge unavailable']]);
    expect(s.desk.named('fulfil')).toHaveLength(0);
  });

  it('signature_unavailable_rejects', async () => {
    const s = setup();
    s.setJudge(async () => { throw new JudgeError('signature', 'HTTP 404'); });
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'signature unavailable']]);
  });

  it('malformed_answer_retries_once_then_rejects', async () => {
    const s = setup();
    s.desk.checks = ['bad answer', 'bad answer'];
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.judgeCalls).toHaveLength(2);
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'bad answer']]);
    expect(s.desk.named('fulfil')).toHaveLength(0);

    const t = setup();
    t.desk.checks = ['bad answer'];
    expect(await processOrder(t.desk.add(), t.deps)).toBe('delivered');
    expect(t.judgeCalls).toHaveLength(2);
  });

  it('unknown_signer_rejects_and_alerts', async () => {
    const s = setup();
    s.desk.checks = ['unknown signer'];
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.judgeCalls).toHaveLength(1);
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'unknown signer']]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatch(/unknown signer 0xsigner/);
  });

  it('low_gas_balance_rejects', async () => {
    const s = setup();
    s.chain.balanceWei = 10n ** 14n - 1n; // just under 0.0001 ETH on Base
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    expect(s.chain.calls[0]).toEqual(['balance', DERIVED]);
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'low gas balance']]);
    expect(s.desk.named('fulfil')).toHaveLength(0);

    const m = setup();
    m.chain.balanceWei = 10n ** 18n - 1n; // just under 1 MON
    expect(await processOrder(m.desk.add({ chain: 'monad' }), m.deps)).toBe('rejected');
    expect(m.desk.named('reject')).toEqual([['reject', 7, 'low gas balance']]);
  });

  it('oracle_revert_on_simulation_rejects', async () => {
    const s = setup();
    s.chain.simulation = { ok: false, reason: 'VaultNotRegistered()' };
    expect(await processOrder(s.desk.add(), s.deps)).toBe('rejected');
    const [sim] = s.chain.calls.filter((c) => c[0] === 'simulate');
    expect(sim[1]).toMatchObject({ from: DERIVED, response: answer('HOLD') });
    expect(s.desk.named('reject')).toEqual([['reject', 7, 'oracle revert: VaultNotRegistered()']]);
    expect(s.desk.named('fulfil')).toHaveLength(0);
  });

  it('broadcast_nonce_too_low_calls_resign_once', async () => {
    const s = setup();
    s.chain.sendErrors = [new Error('nonce too low: next nonce 6, tx nonce 5'), new Error('nonce too low: next nonce 6, tx nonce 5')];
    expect(await processOrder(s.desk.add(), s.deps)).toBe('pending');
    expect(s.desk.named('resign')).toHaveLength(1);
    expect(s.desk.named('fulfil')).toHaveLength(1);

    const t = setup();
    t.chain.sendErrors = [new Error('nonce too low')];
    expect(await processOrder(t.desk.add(), t.deps)).toBe('delivered');
    expect(t.desk.named('resign')).toEqual([['resign', 7, { nonce: 5, max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000' }]]);
    expect(t.desk.named('report_delivery')).toEqual([['report_delivery', 7, keccak256(raw(2)), '75000000000000']]);
  });

  it('resumes_signed_without_new_fulfil', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed' });
    s.desk.signedTx.set(7, raw(9));
    expect(await processOrder(order, s.deps)).toBe('delivered');
    expect(s.desk.named('fulfil')).toHaveLength(0);
    expect(s.judgeCalls).toHaveLength(0);
    expect(s.desk.named('report_delivery')).toEqual([['report_delivery', 7, keccak256(raw(9)), '75000000000000']]);
  });

  it('resumes_exit_pending_confirms', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'exit_pending', exit_pending_s: T0 - 50 });
    expect(await processOrder(order, s.deps)).toBe('delivered');
    expect(s.desk.named('fulfil')).toHaveLength(0);
    expect(s.desk.named('confirm_exit')).toHaveLength(1);
  });

  it('signing_state_waits', async () => {
    const s = setup();
    expect(await processOrder(s.desk.add({ status: 'signing' }), s.deps)).toBe('pending');
    expect(s.desk.calls).toHaveLength(0);
    expect(s.chain.calls).toHaveLength(0);
    expect(s.judgeCalls).toHaveLength(0);
  });

  it('gas_recorded_from_receipt', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed' });
    s.desk.signedTx.set(7, raw(9));
    s.chain.receipts.set(keccak256(raw(9)), { status: 'success', gasUsed: 50_000n, effectiveGasPrice: 1_500_000_000n, l1Fee: 123n });
    expect(await processOrder(order, s.deps)).toBe('delivered');
    expect(s.desk.named('report_delivery')).toEqual([['report_delivery', 7, keccak256(raw(9)), String(50_000n * 1_500_000_000n + 123n)]]);
  });

  it('reverted_post_fails_once_and_counts_gas_once', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed', valid_until: T0 + 100 });
    s.desk.signedTx.set(7, raw(9));
    s.chain.receipts.set(keccak256(raw(9)), { status: 'reverted', gasUsed: 50n, effectiveGasPrice: 3n, l1Fee: 7n });
    s.desk.failureLost = true;
    expect(await processOrder(order, s.deps)).toBe('rejected');
    expect(await processOrder((await s.desk.get_order(7))!, s.deps)).toBe('rejected');
    expect(s.desk.named('fail_post')).toEqual([['fail_post', 7, keccak256(raw(9)), '157', 'oracle revert']]);
    expect(s.desk.gas).toBe(157n);
    expect(s.desk.named('reject')).toEqual([]);
  });

  it('expired_post_fails_without_resign', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed', valid_until: T0 - 60 });
    s.desk.signedTx.set(7, raw(9));
    s.chain.sendErrors = [new Error('nonce too low')];
    expect(await processOrder(order, s.deps)).toBe('rejected');
    expect(s.desk.named('fail_post')).toEqual([['fail_post', 7, null, '0', 'post expired']]);
    expect(s.desk.named('resign')).toEqual([]);
    expect(s.chain.calls.filter((c) => c[0] === 'sendRaw')).toEqual([]);
  });

  it('delivery_report_retry_is_idempotent', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed' });
    s.desk.signedTx.set(7, raw(9));
    s.desk.reportLost = true;
    expect(await processOrder(order, s.deps)).toBe('delivered');
    expect(await processOrder((await s.desk.get_order(7))!, s.deps)).toBe('delivered');
    expect(s.desk.named('report_delivery')).toEqual([['report_delivery', 7, keccak256(raw(9)), '75000000000000']]);
    expect(s.desk.gas).toBe(75000000000000n);
  });

  it('exit_guard_waits_for_first_at', async () => {
    for (const first of [null, T0, T0 - 44]) {
      const s = setup();
      expect(await processOrder(s.desk.add({ status: 'exit_pending', exit_pending_s: first }), s.deps)).toBe('pending');
      expect(s.judgeCalls).toEqual([]);
      expect(s.desk.named('confirm_exit')).toEqual([]);
    }
    const s = setup();
    expect(await processOrder(s.desk.add({ status: 'exit_pending', exit_pending_s: T0 - 45 }), s.deps)).toBe('delivered');
    expect(s.desk.named('confirm_exit')).toHaveLength(1);
    const lapsed = setup();
    const stale = lapsed.desk.add({ status: 'exit_pending', exit_pending_s: T0 - 241 });
    expect(await processOrder(stale, lapsed.deps)).toBe('delivered');
    expect(lapsed.desk.named('confirm_exit')).toEqual([]);
    expect(lapsed.desk.named('fulfil')).toHaveLength(1);
  });

  it('already_posted_state_never_refunds_a_reverted_replacement', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed' });
    s.desk.signedTx.set(7, raw(9));
    s.chain.posted = true;
    s.chain.receipts.set(keccak256(raw(9)), { status: 'reverted', gasUsed: 50n, effectiveGasPrice: 3n });
    expect(await processOrder(order, s.deps)).toBe('pending');
    expect(s.desk.named('fail_post')).toEqual([]);
    expect(s.desk.named('reject')).toEqual([]);
    expect(s.alerts.some((a) => a.includes('already posted'))).toBe(true);
  });

  it('expiry_margin_and_last_receipt_check_prevent_false_refund', async () => {
    const s = setup();
    const order = s.desk.add({ status: 'signed', valid_until: T0 - 1 });
    s.desk.signedTx.set(7, raw(9));
    expect(await processOrder(order, s.deps)).toBe('pending');
    expect(s.chain.calls.filter((c) => c[0] === 'sendRaw')).toEqual([]);
    expect(s.desk.named('fail_post')).toEqual([]);
    s.clock.now += 60;
    let checks = 0;
    s.chain.receipt = async () => ++checks === 1 ? null : { status: 'success', gasUsed: 2n, effectiveGasPrice: 3n };
    expect(await processOrder(order, s.deps)).toBe('delivered');
    expect(s.desk.named('fail_post')).toEqual([]);
    expect(s.desk.gas).toBe(6n);
  });
});

describe('withLock', () => {

  it('lock_prevents_second_runner', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const first = withLock(env.DB, 'chain:base', 60, async () => { await held; return 'first'; });
    await new Promise((r) => setTimeout(r, 50));
    let ranSecond = false;
    expect(await withLock(env.DB, 'chain:base', 60, async () => { ranSecond = true; })).toEqual({ ran: false });
    expect(ranSecond).toBe(false);
    expect(await withLock(env.DB, 'chain:monad', 60, async () => 'other')).toEqual({ ran: true, value: 'other' });
    release();
    expect(await first).toEqual({ ran: true, value: 'first' });
    expect(await withLock(env.DB, 'chain:base', 60, async () => 'again')).toEqual({ ran: true, value: 'again' });
  });

  it('long_running_holder_renews_its_lease', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const first = withLock(env.DB, 'renewal:base', 2, async () => { started.resolve(); await held.promise; return 'first'; });
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(2_200);
      expect(await withLock(env.DB, 'renewal:base', 2, async () => 'second')).toEqual({ ran: false });
    } finally {
      held.resolve();
      expect(await first).toEqual({ ran: true, value: 'first' });
      vi.useRealTimers();
    }
    expect(await withLock(env.DB, 'renewal:base', 2, async () => 'next')).toEqual({ ran: true, value: 'next' });
  });
});

describe('postArgs', () => {
  const order: DeskOrder = {
    id: 7, source: 'near', payer: 'alice.testnet', chain: 'base',
    vault: '0x00000000000000000000000000000000000000aa', amount: '1000000', created_s: T0, status: 'open', exit_pending_s: null, valid_until: null,
  };
  const answer = (content: string) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] });

  it('post_args_map_action_and_withdrawal_risk', () => {
    const doc = 'rein-v1|order=7';
    for (const [action, verdict] of [['hold', 0], ['exit', 1], ['rotate', 2]] as const) {
      const content = `{"action":"${action}","confidence_bps":8100,"withdrawal_risk_bps":2500}`;
      expect(postArgs(order, doc, answer(content), T0 + 1800)).toEqual([order.vault, verdict, 8100, 2500, keccak256(new TextEncoder().encode(doc)), BigInt(T0 + 1800)]);
    }
    expect(() => postArgs(order, doc, answer('{"verdict":"HOLD","confidence_bps":1,"risk_bps":1}'), T0 + 1800)).toThrow();
  });
});

it('positive_posted_evidence_survives_a_stale_negative_view', async () => {
  const s = setup();
  const order = s.desk.add({ status: 'signed', valid_until: T0 + 100 });
  s.desk.signedTx.set(7, raw(9));
  s.chain.sendErrors = [new Error('nonce too low')];
  let reads = 0;
  s.chain.statePosted = async () => ++reads === 1;
  expect(await processOrder(order, s.deps)).toBe('pending');
  expect(s.desk.orders.get(7)?.status).toBe('signed');
  expect(s.desk.named('fail_post')).toEqual([]);
  s.clock.now = T0 + 200;
  expect(await processOrder(order, { ...s.deps, journal: new BroadcastJournal(env.DB, 'mainnet') })).toBe('pending');
  expect(s.desk.named('fail_post')).toEqual([]);
});
