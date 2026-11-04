import type { DeskOrder } from './deskTypes';

/** One read of a vault, at one block. */
export interface VaultReading {
  block: bigint;
  name: string;
  /** Assets per whole share, in asset base units. */
  pps: bigint;
  totalAssets: bigint;
  /** Withdrawable liquidity as a percent of total assets; null when it can't be read. */
  liquidityPct: number | null;
  apyBps: number;
  apyBpsPrev: number;
  utilBps: number;
}

const NAME_MAX = 64;

/** Printable ASCII only, without the characters that would break the JSON string or the field separator. */
function clean(s: string): string {
  return s.replace(/[^\x20-\x7e]|["\\|]/g, '').slice(0, NAME_MAX);
}

/**
 * The reading the model judges. One line of printable ASCII with no `"` or `\`, so the desk's prompt prefix and
 * suffix can wrap it in a JSON string as is. The desk checks every field against the order, so the order matters.
 */
export function buildDoc(order: DeskOrder, reading: VaultReading, flows: { netOutPct1h: number }, now: number): string {
  return [
    'rein-v1',
    `order=${order.id}`,
    `chain=${order.chain}`,
    `vault=${order.vault.toLowerCase()}`,
    `at=${Math.floor(now)}`,
    `block=${reading.block}`,
    `pps=${reading.pps}`,
    `assets=${reading.totalAssets}`,
    `liquidity=${reading.liquidityPct === null ? 'na' : reading.liquidityPct.toFixed(2)}`,
    `apy_bps=${Math.round(reading.apyBps)}`,
    `apy_bps_prev=${Math.round(reading.apyBpsPrev)}`,
    `util_bps=${Math.round(reading.utilBps)}`,
    `net_out_pct_1h=${flows.netOutPct1h.toFixed(2)}`,
    `name=${clean(reading.name)}`,
  ].join('|');
}
