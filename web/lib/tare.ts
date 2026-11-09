import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LedgerScore } from '../../shared/score';
import { publicConfig } from './config';

export const TARE_SCORE_URL = 'https://api.tarefi.xyz/v1/ledger/score?network=mainnet';
export const TARE_SITE = 'https://tarefi.xyz';

const isScore = (v: unknown): v is LedgerScore => {
  const s = v as LedgerScore;
  return !!s && typeof s.n === 'number' && (s.brier === null || typeof s.brier === 'number') && Array.isArray(s.bands);
};

/** Tare's mainnet score from its public API, for comparison only. Null when it can't be read, so the page hides it. */
export async function readTareScore(): Promise<LedgerScore | null> {
  try {
    if ((await publicConfig()).sample) {
      const dir = process.env.FIXTURES_DIR ?? join(process.cwd(), 'fixtures');
      return JSON.parse(await readFile(join(dir, 'tare.score.json'), 'utf8')) as LedgerScore;
    }
    const res = await fetch(TARE_SCORE_URL, { next: { revalidate: 300 }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isScore(body) ? body : null;
  } catch {
    return null;
  }
}
