import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { watchOnce, type WatchDeps, type WatchReading } from '../src/watch';

const T0 = 1_793_774_400;
const VAULT = '0x00000000000000000000000000000000000000aa';

function setup(first: WatchReading = { apyBps: 500, utilBps: 5000, totalAssets: 1_000_000n }) {
  let reading = first;
  const submits: [string, string][] = [];
  let refusal: string | null = null;
  const deps: WatchDeps = {
    desk: {
      menu: async (chain) => (chain === 'monad-testnet' ? [VAULT] : []),
      submit_watch_request: async (chain, vault) => {
        submits.push([chain, vault]);
        if (refusal) throw new Error(refusal);
        return 40 + submits.length;
      },
    },
    read: async () => reading,
  };
  return {
    deps,
    submits,
    set(r: Partial<WatchReading>) {
      reading = { ...reading, ...r };
    },
    refuse(r: string) {
      refusal = r;
    },
  };
}

const requests = () =>
  env.DB.prepare('SELECT chain, vault, at, reason, order_id, refusal FROM watch_requests ORDER BY at')
    .all()
    .then((r) => r.results);

describe('watchOnce', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });
  beforeEach(async () => {
    await env.DB.batch(
      ['watch_snapshots', 'watch_baselines', 'watch_requests'].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
  });

  it('first_read_only_snapshots', async () => {
    const s = setup();
    expect(await watchOnce(env, 'testnet', T0, s.deps)).toEqual({ snapshots: 1, submitted: 0, refused: 0, failed: 0 });
    expect(s.submits).toEqual([]);
    const snaps = await env.DB.prepare('SELECT chain, vault, at, apy_bps, util_bps, assets FROM watch_snapshots').all();
    expect(snaps.results).toEqual([
      { chain: 'monad-testnet', vault: VAULT, at: T0, apy_bps: 500, util_bps: 5000, assets: '1000000' },
    ]);
    // Inside the 600 s spacing nothing is read again.
    expect((await watchOnce(env, 'testnet', T0 + 599, s.deps)).snapshots).toBe(0);
  });

  it('apy_move_over_50bps_submits', async () => {
    const s = setup();
    await watchOnce(env, 'testnet', T0, s.deps);
    s.set({ apyBps: 551 });
    expect((await watchOnce(env, 'testnet', T0 + 600, s.deps)).submitted).toBe(1);
    expect(s.submits).toEqual([['monad-testnet', VAULT]]);
    expect(await requests()).toEqual([
      { chain: 'monad-testnet', vault: VAULT, at: T0 + 600, reason: 'apy 500->551', order_id: 41, refusal: null },
    ]);
  });

  it('util_move_over_500bps_submits', async () => {
    const s = setup();
    await watchOnce(env, 'testnet', T0, s.deps);
    s.set({ utilBps: 4499 });
    expect((await watchOnce(env, 'testnet', T0 + 600, s.deps)).submitted).toBe(1);
    expect((await requests())[0]).toMatchObject({ reason: 'util 5000->4499', order_id: 41 });
  });

  it('outflow_over_5pct_submits', async () => {
    const s = setup();
    await watchOnce(env, 'testnet', T0, s.deps);
    s.set({ totalAssets: 970_000n });
    expect((await watchOnce(env, 'testnet', T0 + 600, s.deps)).submitted).toBe(0);
    s.set({ totalAssets: 949_999n });
    expect((await watchOnce(env, 'testnet', T0 + 1200, s.deps)).submitted).toBe(1);
    expect((await requests())[0]).toMatchObject({ reason: 'outflow 1000000->949999', order_id: 41 });
  });

  it('small_moves_do_nothing', async () => {
    const s = setup();
    await watchOnce(env, 'testnet', T0, s.deps);
    // Each rule's exact limit, and drift that never passes one, over several snapshots.
    const steps: Partial<WatchReading>[] = [
      { apyBps: 520, utilBps: 5200, totalAssets: 990_000n },
      { apyBps: 550, utilBps: 5500, totalAssets: 960_000n },
      { apyBps: 450, utilBps: 4500, totalAssets: 950_000n },
    ];
    for (const [i, r] of steps.entries()) {
      s.set(r);
      expect(await watchOnce(env, 'testnet', T0 + 600 * (i + 1), s.deps)).toEqual({
        snapshots: 1,
        submitted: 0,
        refused: 0,
        failed: 0,
      });
    }
    expect(s.submits).toEqual([]);
    expect(await requests()).toEqual([]);
  });

  it('desk_refusal_logged_not_retried', async () => {
    const s = setup();
    await watchOnce(env, 'testnet', T0, s.deps);
    s.set({ apyBps: 700 });
    s.refuse('watch_daily_max reached');
    expect(await watchOnce(env, 'testnet', T0 + 600, s.deps)).toEqual({
      snapshots: 1,
      submitted: 0,
      refused: 1,
      failed: 0,
    });
    expect(await requests()).toEqual([
      {
        chain: 'monad-testnet',
        vault: VAULT,
        at: T0 + 600,
        reason: 'apy 500->700',
        order_id: null,
        refusal: 'watch_daily_max reached',
      },
    ]);
    // The same move doesn't ask again.
    expect((await watchOnce(env, 'testnet', T0 + 1200, s.deps)).refused).toBe(0);
    expect(s.submits).toHaveLength(1);
  });
});
