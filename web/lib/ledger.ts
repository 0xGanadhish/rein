import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeskChain, DeskStats } from '../../shared/desk';
import type { LedgerScore, ScoreVerdict } from '../../shared/score';

export type Network = 'testnet' | 'mainnet';
export const NETWORKS: Network[] = ['mainnet', 'testnet'];

/** One post in the Worker's `/v1/ledger` `recent` list, newest first. */
export interface LedgerPost {
  chain: DeskChain;
  /** Oracle verdict id on that chain. */
  id: number;
  vault: string;
  verdict: ScoreVerdict;
  confidence_bps: number;
  risk_bps: number;
  posted_at: number;
  order_id: number | null;
  input_check: 'match' | 'mismatch' | 'unknown';
  resolved: boolean;
  adverse: boolean | null;
  /** Oracle reason bits; null until resolved. */
  reasons: number | null;
  /** Repeats the post before it on the same vault, so it isn't scored. */
  repeat: boolean;
}

/** The Worker's `GET /v1/ledger` body. */
export interface Ledger {
  network: Network;
  score: LedgerScore;
  posts: number;
  calls: number;
  input_checks: { match: number; mismatch: number; unknown: number };
  business: {
    desk: (DeskStats & { as_of: number }) | null;
    judge_calls: number;
    judge_cost_usd_micros: number;
    orders: { source: string; status: string; n: number }[];
    watch: { asked: number; opened: number };
  };
  recent: LedgerPost[];
}

export type LedgerResult =
  | { ok: true; ledger: Ledger; sample: boolean }
  | { ok: false; error: string };

export const isNetwork = (v: unknown): v is Network => v === 'testnet' || v === 'mainnet';

/**
 * The Ledger from the Worker at REIN_API_URL, or from fixtures/ when DATA_SOURCE=fixtures. Without a network the
 * Worker answers for the NEAR network it runs on; fixtures default to mainnet.
 */
export async function readLedger(network?: Network): Promise<LedgerResult> {
  if (process.env.DATA_SOURCE === 'fixtures') {
    const dir = process.env.FIXTURES_DIR ?? join(process.cwd(), 'fixtures');
    const ledger = JSON.parse(await readFile(join(dir, `ledger.${network ?? 'mainnet'}.json`), 'utf8')) as Ledger;
    return { ok: true, ledger, sample: true };
  }
  const base = process.env.REIN_API_URL;
  if (!base) return { ok: false, error: 'REIN_API_URL is not set.' };
  const url = new URL('/v1/ledger', base);
  if (network) url.searchParams.set('network', network);
  try {
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) return { ok: false, error: `The desk answered ${res.status}.` };
    return { ok: true, ledger: (await res.json()) as Ledger, sample: false };
  } catch {
    return { ok: false, error: 'The desk could not be reached.' };
  }
}
