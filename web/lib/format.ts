const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "Nov 04 14:02" in UTC, the same on server and client. */
export function utcStamp(unixS: number): string {
  const d = new Date(unixS * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const bpsPct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
export const pct = (x: number | null, digits = 1) => (x === null ? '–' : `${(x * 100).toFixed(digits)}%`);

/** A decimal string of base units as a whole-unit amount, at most `shown` decimals, with thousands separators. */
export function units(raw: string, decimals: number, shown = 2): string {
  const signed = BigInt(raw || '0');
  const v = signed < 0n ? -signed : signed;
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = (v % scale).toString().padStart(decimals, '0').slice(0, shown);
  return `${signed < 0n ? '-' : ''}${whole.toLocaleString('en-US')}${shown > 0 ? `.${frac}` : ''}`;
}

/** A base-unit amount without trailing zeros: "5", "2.5". */
export function amount(raw: string, decimals: number): string {
  if (BigInt(raw || '0') === 0n) return '0';
  return units(raw, decimals, decimals).replace(/\.?0+$/, '');
}

/** "30 minutes", "1 hour", "45 seconds". */
export function duration(s: number): string {
  if (s % 3600 === 0) return s === 3600 ? '1 hour' : `${s / 3600} hours`;
  if (s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`;
  return `${s} seconds`;
}

/** The oracle's reason bits for an adverse resolution (TareRiskOracle REASON_*). */
export function reasonLabels(reasons: number | null): string[] {
  if (!reasons) return [];
  const out: string[] = [];
  if (reasons & 1) out.push('share price fell');
  if (reasons & 2) out.push('assets fell');
  if (reasons & 4) out.push('liquidity under 5%');
  if (reasons & 8) out.push('vault reads failed');
  return out;
}
