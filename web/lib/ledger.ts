import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeskChain, DeskStats } from '../../shared/desk';
import type { LedgerScore, ScoreVerdict } from '../../shared/score';
import { configFor, publicConfig } from './config';

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
  /** The reading the model judged; null when the Worker didn't keep it. */
  doc: string | null;
  /** The model's signing address for this call's answer; null when it isn't known. */
  signer: string | null;
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
    /** Revenue counts at delivery, from the desk's split totals; it includes transfers still owed. */
    settled_revenue: { near: string; usdc: string; x402_usdc: string; source: string };
    refunds: { authorized_orders: number; mirrored_amounts: { near: string; usdc: string }; paid_amounts: null };
    /**
     * Failed transfers, refunds and splits together, claimable with claim_owed (null before the desk is read), and
     * x402 payments still owed a judgement: unredeemed credits and purchases still being judged.
     */
    unpaid_liabilities: {
      usdc: string | null;
      near: string | null;
      x402_credit_usdc: string;
      x402_pending_usdc: string;
    };
    /** Native gas per chain, in wei; a lower bound. */
    gas_per_chain: Record<string, { cost_wei: string; cost_is_lower_bound: boolean }>;
    inference: { known_cost_usd_micros: number; calls_with_unknown_usage: number };
    margin: { usdc_less_inference_micros: string; near_yocto: string; includes_native_gas: boolean };
    positive_margin: boolean | null;
    margin_unavailable_reason: string;
    x402_unsettled_usdc: string;
  };
  recent: LedgerPost[];
}

export type LedgerResult = { ok: true; ledger: Ledger; sample: boolean } | { ok: false; error: string };

export const isNetwork = (v: unknown): v is Network => v === 'testnet' || v === 'mainnet';

/**
 * The Ledger from that network's Worker, or from fixtures/ when DATA_SOURCE=fixtures. Without a network it's the
 * network the visitor has switched to.
 */
export async function readLedger(network?: Network): Promise<LedgerResult> {
  const cfg = network ? configFor(network) : await publicConfig();
  if (cfg.sample) {
    const dir = process.env.FIXTURES_DIR ?? join(process.cwd(), 'fixtures');
    const ledger = JSON.parse(await readFile(join(dir, `ledger.${cfg.network}.json`), 'utf8')) as Ledger;
    return { ok: true, ledger, sample: true };
  }
  if (!cfg.api) return { ok: false, error: 'No Worker is configured for this network.' };
  const url = new URL('/v1/ledger', cfg.api);
  url.searchParams.set('network', cfg.network);
  try {
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) return { ok: false, error: `The desk answered ${res.status}.` };
    return { ok: true, ledger: (await res.json()) as Ledger, sample: false };
  } catch {
    return { ok: false, error: 'The desk could not be reached.' };
  }
}

/** One point of the Worker's `GET /v1/ledger/brier`: the running score after each resolved call. */
export interface BrierPoint {
  at: number;
  n: number;
  brier: number;
}

/** The running Brier score over every resolved call on the visitor's network. Null when it can't be read. */
export async function readBrier(): Promise<BrierPoint[] | null> {
  const cfg = await publicConfig();
  if (cfg.sample) {
    const dir = process.env.FIXTURES_DIR ?? join(process.cwd(), 'fixtures');
    return (JSON.parse(await readFile(join(dir, `brier.${cfg.network}.json`), 'utf8')) as { points: BrierPoint[] })
      .points;
  }
  if (!cfg.api) return null;
  const url = new URL('/v1/ledger/brier', cfg.api);
  url.searchParams.set('network', cfg.network);
  try {
    const res = await fetch(url, { next: { revalidate: 60 } });
    return res.ok ? ((await res.json()) as { points: BrierPoint[] }).points : null;
  } catch {
    return null;
  }
}
