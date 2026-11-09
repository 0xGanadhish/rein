/** Ledger scoring, shared by the Worker's /v1/ledger and the web app. */

export type ScoreVerdict = 'HOLD' | 'EXIT' | 'MOVE';
export type ConfidenceBand = '<80' | '80-89' | '90-94' | '95-100';

export interface ScoreRow {
  verdict: ScoreVerdict;
  confidenceBps: number;
  riskBps: number;
  resolved: boolean;
  /** Null until resolved. */
  adverse: boolean | null;
}

export interface LedgerScore {
  /** Resolved posts counted. */
  n: number;
  /** Mean of (riskBps/10000 − adverse)²; null with no resolved posts. Lower is better. */
  brier: number | null;
  /** Fewer than EARLY_BELOW resolved posts: shown as "early data". */
  early: boolean;
  bands: { band: ConfidenceBand; n: number; hitRate: number | null }[];
}

export const EARLY_BELOW = 30;
export const BANDS: ConfidenceBand[] = ['<80', '80-89', '90-94', '95-100'];

export function bandOf(confidenceBps: number): ConfidenceBand {
  if (confidenceBps >= 9500) return '95-100';
  if (confidenceBps >= 9000) return '90-94';
  if (confidenceBps >= 8000) return '80-89';
  return '<80';
}

/** A hit is an EXIT followed by an adverse outcome, or a HOLD/MOVE followed by none. */
export const isHit = (r: Pick<ScoreRow, 'verdict' | 'adverse'>): boolean =>
  r.verdict === 'EXIT' ? r.adverse === true : r.adverse === false;

export function scoreLedger(rows: ScoreRow[]): LedgerScore {
  const resolved = rows.filter((r) => r.resolved && r.adverse !== null);
  const n = resolved.length;
  const brier =
    n === 0 ? null : resolved.reduce((sum, r) => sum + (r.riskBps / 10000 - (r.adverse ? 1 : 0)) ** 2, 0) / n;
  const bands = BANDS.map((band) => {
    const inBand = resolved.filter((r) => bandOf(r.confidenceBps) === band);
    return {
      band,
      n: inBand.length,
      hitRate: inBand.length === 0 ? null : inBand.filter(isHit).length / inBand.length,
    };
  });
  return { n, brier, early: n < EARLY_BELOW, bands };
}

/** A post repeating the previous post on its vault, within this many seconds, is the same call. */
export const REPEAT_WINDOW_S = 3600;

export interface CallRow {
  /** Posts on different chains are different vaults even at the same address. */
  chain?: string;
  vault: string;
  verdict: ScoreVerdict;
  postedAt: number;
}

/**
 * Count-once: the posts that are new calls, in input order. A post is a repeat when the previous post on the same
 * vault has the same verdict and came less than REPEAT_WINDOW_S before it, so a burst of identical verdicts is
 * scored once however long it runs.
 */
export function newCalls<T extends CallRow>(rows: T[]): T[] {
  const key = (r: CallRow) => `${r.chain ?? ''}:${r.vault.toLowerCase()}`;
  const byTime = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.postedAt - b.r.postedAt || a.i - b.i);
  const last = new Map<string, CallRow>();
  const keep = new Set<number>();
  for (const { r, i } of byTime) {
    const prev = last.get(key(r));
    if (!prev || prev.verdict !== r.verdict || r.postedAt - prev.postedAt >= REPEAT_WINDOW_S) keep.add(i);
    last.set(key(r), r);
  }
  return rows.filter((_, i) => keep.has(i));
}

export interface BrierPoint {
  /** When this call resolved. */
  at: number;
  /** Resolved calls so far, this one included. */
  n: number;
  /** Brier score over those calls, as scoreLedger computes it. */
  brier: number;
}

/** The running Brier score: one point per resolved call, in the order they resolved. Pass calls, not repeats. */
export function brierSeries(rows: (ScoreRow & { resolvedAt: number | null })[]): BrierPoint[] {
  const resolved = rows
    .filter((r) => r.resolved && r.adverse !== null && r.resolvedAt !== null)
    .sort((a, b) => a.resolvedAt! - b.resolvedAt!);
  let sum = 0;
  return resolved.map((r, i) => {
    sum += (r.riskBps / 10000 - (r.adverse ? 1 : 0)) ** 2;
    return { at: r.resolvedAt!, n: i + 1, brier: sum / (i + 1) };
  });
}
