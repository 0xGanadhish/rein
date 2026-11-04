import type { DeskChain } from '../../shared/desk';
import { NETWORK_CHAINS, type DeskClient } from './deskTypes';
import type { Env, NearNetwork } from './env';
import { readVault } from './vendor/vaultReader';

/** One snapshot per menu vault this often (the desk's `spacing_s`). */
export const WATCH_EVERY_S = 600;
/** A move from the baseline past any of these asks the desk for a watch order. */
export const APY_MOVE_BPS = 50;
export const UTIL_MOVE_BPS = 500;
export const OUTFLOW_PCT = 5;
const OUTFLOW_WINDOW_S = 3600;
/** Snapshots older than this are dropped. */
const KEEP_S = 3 * 3600;

export interface WatchReading {
  /** Null when the vault has no APY source; the APY rule then doesn't apply. */
  apyBps: number | null;
  utilBps: number;
  totalAssets: bigint;
}

export interface WatchDeps {
  desk: Pick<DeskClient, 'menu' | 'submit_watch_request'>;
  read(chain: DeskChain, vault: string): Promise<WatchReading>;
}

export interface WatchTally {
  snapshots: number;
  submitted: number;
  refused: number;
  failed: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200);

export function realWatchDeps(env: Env, desk: DeskClient): WatchDeps {
  return {
    desk,
    // The testnet feed is made of MirrorVaults, which report their own APY and utilization.
    read: (chain, vault) => readVault(env, chain, { address: vault, mirror: chain === 'monad-testnet' }),
  };
}

/**
 * Net outflow over the last hour as a percent of assets, from the watch snapshots: the oldest one in the hour against
 * the newest. 0 with fewer than two.
 */
export async function netOutPct1h(db: D1Database, chain: DeskChain, vault: string, now: number): Promise<number> {
  const { results } = await db.prepare(`SELECT assets FROM watch_snapshots WHERE chain = ? AND vault = ? AND at >= ? ORDER BY at`)
    .bind(chain, vault.toLowerCase(), now - OUTFLOW_WINDOW_S).all<{ assets: string }>();
  if (results.length < 2) return 0;
  const [first, last] = [BigInt(results[0].assets), BigInt(results.at(-1)!.assets)];
  return first === 0n ? 0 : Number(((first - last) * 10_000n) / first) / 100;
}

interface Baseline { at: number; apy_bps: number | null; util_bps: number }

/** Why this reading should be judged again, or null. */
function trigger(base: Baseline, now: WatchReading, assetsBefore: bigint | null): string | null {
  if (base.apy_bps !== null && now.apyBps !== null && Math.abs(now.apyBps - base.apy_bps) > APY_MOVE_BPS) {
    return `apy ${base.apy_bps}->${now.apyBps}`;
  }
  if (Math.abs(now.utilBps - base.util_bps) > UTIL_MOVE_BPS) return `util ${base.util_bps}->${now.utilBps}`;
  if (assetsBefore !== null && assetsBefore > 0n && (assetsBefore - now.totalAssets) * 100n > assetsBefore * BigInt(OUTFLOW_PCT)) {
    return `outflow ${assetsBefore}->${now.totalAssets}`;
  }
  return null;
}

/**
 * The watch feed: a snapshot of every menu vault each WATCH_EVERY_S, and a watch order when one has moved since its
 * baseline. The baseline moves to the reading that asked for the order, whether or not the desk took it, so a refusal
 * is logged once and not retried on the same move.
 */
export async function watchOnce(env: Env, network: NearNetwork, now: number, deps: WatchDeps): Promise<WatchTally> {
  const tally: WatchTally = { snapshots: 0, submitted: 0, refused: 0, failed: 0 };
  const db = env.DB;
  for (const chain of NETWORK_CHAINS[network]) {
    let menu: string[];
    try {
      menu = await deps.desk.menu(chain);
    } catch (e) {
      tally.failed++;
      console.error(JSON.stringify({ msg: 'watch_menu_failed', chain, error: message(e) }));
      continue;
    }
    for (const raw of menu) {
      const vault = raw.toLowerCase();
      const last = await db.prepare('SELECT MAX(at) AS at FROM watch_snapshots WHERE chain = ? AND vault = ?').bind(chain, vault).first<number | null>('at');
      if (last !== null && now - last < WATCH_EVERY_S) continue;

      let reading: WatchReading;
      try {
        reading = await deps.read(chain, vault);
      } catch (e) {
        tally.failed++;
        console.error(JSON.stringify({ msg: 'watch_read_failed', chain, vault, error: message(e) }));
        continue;
      }
      await db.prepare('INSERT OR IGNORE INTO watch_snapshots (chain, vault, at, apy_bps, util_bps, assets) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(chain, vault, now, reading.apyBps, reading.utilBps, String(reading.totalAssets)).run();
      tally.snapshots++;

      const setBaseline = db.prepare(`INSERT INTO watch_baselines (chain, vault, at, apy_bps, util_bps) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT (chain, vault) DO UPDATE SET at = ?3, apy_bps = ?4, util_bps = ?5`)
        .bind(chain, vault, now, reading.apyBps, reading.utilBps);
      const base = await db.prepare('SELECT at, apy_bps, util_bps FROM watch_baselines WHERE chain = ? AND vault = ?').bind(chain, vault).first<Baseline>();
      if (!base) {
        await setBaseline.run();
        continue;
      }
      // Outflow is measured from the oldest snapshot in the last hour, but never from before the baseline.
      const before = await db.prepare(`SELECT assets FROM watch_snapshots WHERE chain = ? AND vault = ? AND at >= ? AND at < ? ORDER BY at LIMIT 1`)
        .bind(chain, vault, Math.max(now - OUTFLOW_WINDOW_S, base.at), now).first<string>('assets');
      const reason = trigger(base, reading, before === null ? null : BigInt(before));
      if (!reason) continue;

      await setBaseline.run();
      try {
        const orderId = await deps.desk.submit_watch_request(chain, vault);
        await db.prepare('INSERT INTO watch_requests (chain, vault, at, reason, order_id) VALUES (?, ?, ?, ?, ?)').bind(chain, vault, now, reason, orderId).run();
        tally.submitted++;
        console.log(JSON.stringify({ msg: 'watch_submitted', chain, vault, reason, orderId }));
      } catch (e) {
        const refusal = message(e);
        await db.prepare('INSERT INTO watch_requests (chain, vault, at, reason, refusal) VALUES (?, ?, ?, ?, ?)').bind(chain, vault, now, reason, refusal).run();
        tally.refused++;
        console.warn(JSON.stringify({ msg: 'watch_refused', chain, vault, reason, refusal }));
      }
    }
  }
  await db.prepare('DELETE FROM watch_snapshots WHERE at < ?').bind(now - KEEP_S).run();
  return tally;
}
