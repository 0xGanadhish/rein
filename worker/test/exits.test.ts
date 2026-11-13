import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { Address, Hex } from 'viem';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { queueExits, runExits, type ExitDeps, type ExitReceipt, type ExitRule } from '../src/exits';

const VAULT: Address = '0x00000000000000000000000000000000000000aa';
const ALICE: Address = '0x0000000000000000000000000000000000000001';
const BOB: Address = '0x0000000000000000000000000000000000000002';
const CAROL: Address = '0x0000000000000000000000000000000000000003';
const NOW = 1_793_774_225;
const HASH: Hex = `0x${'ab'.repeat(32)}`;

function setup() {
  let now = NOW;
  let remaining = 0n;
  const sent: Hex[] = [];
  const rules: Record<Address, ExitRule> = {
    [ALICE]: { enabled: true, minConfidenceBps: 8500, maxAge: 60, enabledAt: NOW - 10, floor: 6 },
    [BOB]: { enabled: true, minConfidenceBps: 9500, maxAge: 60, enabledAt: NOW - 10, floor: 6 },
    [CAROL]: { enabled: false, minConfidenceBps: 8000, maxAge: 60, enabledAt: NOW - 10, floor: 6 },
  };
  const deps: ExitDeps = {
    now: () => now,
    guardian: () => ({ address: '0x00000000000000000000000000000000000000ee', fromBlock: 1n }),
    head: async () => 1n,
    enables: async () => [ALICE, BOB, CAROL].map((owner) => ({ owner, vault: VAULT })),
    rule: async (job) => rules[job.owner],
    latest: async () => 7,
    simulate: async () => null,
    prepare: async (job) => ({
      raw: job.attempt === 0 ? '0x1234' : '0x5678',
      hash: job.attempt === 0 ? HASH : `0x${'cd'.repeat(32)}`,
    }),
    broadcast: async (_chain, raw) => {
      sent.push(raw);
    },
    receipt: async (job): Promise<ExitReceipt | null> =>
      !sent.includes(job.attempt === 0 ? '0x1234' : '0x5678')
        ? null
        : {
            status: 'success',
            gasWei: 123n,
            shares: 600n,
            assets: 600n,
            remainingShares: remaining,
          },
  };
  return {
    deps,
    sent,
    time: (t: number) => {
      now = t;
    },
    partial: () => {
      remaining = 400n;
    },
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch(
    ['exits', 'exit_attempts', 'exit_verdicts', 'guardian_owners', 'guardian_scans', 'executor_fees', 'posts'].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.prepare(
    `INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at, pps_at_post, assets_at_post, liquidity_at_post)
    VALUES ('base', 7, ?, 1, 9000, 9000, '0xabc', ?, '1', '1000', '500')`,
  )
    .bind(VAULT, NOW)
    .run();
});

const row = () =>
  env.DB.prepare('SELECT status, verdict_id, remaining_shares, next_at, error FROM exits WHERE owner = ?')
    .bind(ALICE)
    .first();

it('exits_only_opted_in_owners_at_their_confidence', async () => {
  const s = setup();
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', s.deps);
  expect(s.sent).toEqual(['0x1234']);
  expect(
    await env.DB.prepare('SELECT owner, status FROM exits ORDER BY owner')
      .all()
      .then((r) => r.results),
  ).toEqual([
    { owner: ALICE, status: 'confirmed' },
    { owner: BOB, status: 'skipped' },
    { owner: CAROL, status: 'skipped' },
  ]);
  expect(await env.DB.prepare('SELECT kind, gas_wei, verdict_id FROM executor_fees').first()).toEqual({
    kind: 'exit',
    gas_wei: '123',
    verdict_id: 7,
  });
});

it('partial_exit_requeues_after_30s', async () => {
  const s = setup();
  s.partial();
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', s.deps);
  expect(await row()).toMatchObject({ status: 'partial', remaining_shares: '400', next_at: NOW + 30 });
  s.time(NOW + 29);
  await runExits(env, 'mainnet', { ...s.deps });
  expect(s.sent).toEqual(['0x1234']);
});

it('follow_up_completes_on_same_verdict', async () => {
  const first = setup();
  first.partial();
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', first.deps);
  // New dependencies, same D1: no in-memory follow-up state survives.
  const restarted = setup();
  restarted.time(NOW + 30);
  await runExits(env, 'mainnet', restarted.deps);
  expect(restarted.sent).toEqual(['0x5678']);
  expect(await row()).toMatchObject({ status: 'confirmed', verdict_id: 7, remaining_shares: '0', next_at: null });
});

it('follow_up_stops_when_stale', async () => {
  const first = setup();
  first.partial();
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', first.deps);
  const restarted = setup();
  restarted.time(NOW + 61);
  await runExits(env, 'mainnet', restarted.deps);
  expect(restarted.sent).toEqual([]);
  expect(await row()).toMatchObject({ status: 'skipped', error: 'StaleVerdict', next_at: null });
});

it('full_exit_does_not_requeue', async () => {
  const s = setup();
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', s.deps);
  s.time(NOW + 30);
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', { ...s.deps });
  expect(s.sent).toEqual(['0x1234']);
  expect(await row()).toMatchObject({ status: 'confirmed', next_at: null });
});

it('pending_exit_receipt_is_not_starved_by_queued_owners', async () => {
  const s = setup();
  const owners = Array.from({ length: 8 }, (_, i): Address => `0x${(i + 1).toString(16).padStart(40, '0')}`);
  const deps: ExitDeps = {
    ...s.deps,
    enables: async () => owners.map((owner) => ({ owner, vault: VAULT })),
    rule: async () => ({ enabled: true, minConfidenceBps: 8500, maxAge: 60, enabledAt: NOW - 10, floor: 6 }),
    broadcast: async (_chain, raw) => {
      s.sent.push(raw);
      throw new Error('lost response');
    },
    prepare: async (job) =>
      job.owner === ALICE ? s.deps.prepare(job) : { raw: '0x9876', hash: `0x${'ef'.repeat(32)}` },
    receipt: async (job, hash) => (job.owner === ALICE ? s.deps.receipt(job, hash) : null),
  };
  await queueExits(env, 'base', 7);
  await runExits(env, 'mainnet', deps);
  expect(await row()).toMatchObject({ status: 'sending' });
  s.time(NOW + 30);
  await runExits(env, 'mainnet', { ...deps });
  expect(await row()).toMatchObject({ status: 'confirmed', next_at: null });
  expect(s.sent.filter((raw) => raw === '0x1234')).toEqual(['0x1234']);
});

it('enabled_scan_pages_within_rpc_range_and_catches_up', async () => {
  const { deps } = setup();
  const ranges: [bigint, bigint][] = [];
  await runExits(env, 'mainnet', {
    ...deps,
    guardian: (chain) => (chain === 'base' ? { address: '0x00000000000000000000000000000000000000ee', fromBlock: 1n } : null),
    head: async () => 95n,
    enables: async (_chain, from, to) => {
      ranges.push([from, to]);
      return [];
    },
  });
  expect(ranges.every(([from, to]) => to - from + 1n <= 10n)).toBe(true);
  expect(ranges.at(-1)?.[1]).toBe(95n);
  expect(await env.DB.prepare("SELECT next_block FROM guardian_scans WHERE chain = 'base'").first()).toEqual({
    next_block: 96,
  });
});
