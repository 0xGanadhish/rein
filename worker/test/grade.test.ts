import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, type Hex, type Log } from 'viem';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { oracleAbi } from '../src/abis';
import { gradeDue, type GradeDeps } from '../src/grade';
import { RESOLVE_WINDOW_S } from '../src/vendor/cadence';

const ORACLE = '0x0000000000000000000000000000000000000c1e';
const P = 1_793_700_000;
const OPENS = RESOLVE_WINDOW_S.base;

function resolvedLog(id: bigint, adverse: boolean, reasons: number): Log {
  return {
    address: ORACLE,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
    topics: encodeEventTopics({ abi: oracleAbi, eventName: 'VerdictResolved', args: { id } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'uint8' }], [adverse, reasons]),
  };
}

function setup(
  onchain: { resolved: boolean; adverse: boolean; reasons: number } = { resolved: false, adverse: false, reasons: 0 },
) {
  const sent: { fn: string; id: bigint }[] = [];
  const deps: GradeDeps = {
    resolver: (chain) =>
      chain !== 'base'
        ? null
        : {
            oracle: ORACLE,
            random: () => 0,
            readResolution: async () => onchain,
            sender: {
              async send({ to, data }) {
                expect(to).toBe(ORACLE);
                const call = decodeFunctionData({ abi: oracleAbi, data });
                const id = call.args![0] as bigint;
                sent.push({ fn: call.functionName, id });
                return {
                  status: 'success',
                  hash: '0x01',
                  logs: call.functionName === 'resolve' ? [resolvedLog(id, true, 4)] : [],
                };
              },
            },
          },
  };
  return { deps, sent };
}

async function addPost(id: number, patch: { sampled?: number; resample_at?: number } = {}) {
  await env.DB.prepare(
    `INSERT INTO posts (chain, id, vault, verdict, confidence_bps, risk_bps, state_hash, posted_at, pps_at_post, assets_at_post,
      liquidity_at_post, sampled, resample_at) VALUES ('base', ?, '0xaa', 0, 9000, 1000, '0x00', ?, '1000000', '5000000', '2500000', ?, ?)`,
  )
    .bind(id, P, patch.sampled ?? 0, patch.resample_at ?? null)
    .run();
}
const post = (id: number) =>
  env.DB.prepare('SELECT sampled, resample_at, resolved, adverse, reasons FROM posts WHERE chain = ? AND id = ?')
    .bind('base', id)
    .first();

describe('gradeDue', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM posts').run();
  });

  it('samples_when_window_opens', async () => {
    const s = setup();
    await addPost(1);
    expect((await gradeDue(env, 'mainnet', P + OPENS - 1, s.deps)).base).toMatchObject({ sampled: 0, sent: 0 });
    expect(s.sent).toEqual([]);

    expect((await gradeDue(env, 'mainnet', P + OPENS, s.deps)).base).toMatchObject({ sampled: 1, sent: 0, failed: 0 });
    expect(s.sent).toEqual([{ fn: 'sample', id: 1n }]);
    // The second sample is due no sooner than 5 minutes after the first.
    expect(await post(1)).toMatchObject({ sampled: 1, resample_at: P + OPENS + 300, resolved: 0 });

    await gradeDue(env, 'mainnet', P + OPENS + 300, s.deps);
    expect(s.sent).toEqual([
      { fn: 'sample', id: 1n },
      { fn: 'sample', id: 1n },
    ]);
    expect(await post(1)).toMatchObject({ sampled: 2 });
  });

  it('resolves_after_sampling', async () => {
    const s = setup();
    await addPost(2, { sampled: 2 });
    expect((await gradeDue(env, 'mainnet', P + OPENS + 3_599, s.deps)).base).toMatchObject({ sent: 0 });
    expect((await gradeDue(env, 'mainnet', P + OPENS + 3_600, s.deps)).base).toEqual({
      sampled: 0,
      sent: 1,
      synced: 0,
      failed: 0,
      unsampled: 0,
    });
    expect(s.sent).toEqual([{ fn: 'resolve', id: 2n }]);
    expect(await post(2)).toMatchObject({ resolved: 1, adverse: 1, reasons: 4 });
  });

  it('already_resolved_syncs_without_tx', async () => {
    const s = setup({ resolved: true, adverse: false, reasons: 0 });
    await addPost(3, { sampled: 2 });
    expect((await gradeDue(env, 'mainnet', P + OPENS + 3_600, s.deps)).base).toEqual({
      sampled: 0,
      sent: 0,
      synced: 1,
      failed: 0,
      unsampled: 0,
    });
    expect(s.sent).toEqual([]);
    expect(await post(3)).toMatchObject({ resolved: 1, adverse: 0, reasons: 0 });
  });
});
