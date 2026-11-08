import type { DeskChain } from '../../shared/desk';

export interface PayPolicy {
  priceNear: string;
  priceUsdc: string;
  usdcToken: string | null;
}

export interface WalletCall {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  deposit: string;
}

const utcTime = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);

/**
 * Adds each vault's latest verdict and, while the desk's spacing rule still blocks it, when the next paid order is allowed.
 * The desk refuses a post on a vault judged less than `spacingS` ago, so the next one opens `spacingS` after the latest.
 */
export function buildMenu<T extends { chain: DeskChain; vault: string }>({
  entries,
  recent,
  spacingS,
  nowS,
}: {
  entries: T[];
  recent: { chain: DeskChain; vault: string; verdict: string; posted_at: number }[];
  spacingS: number;
  nowS: number;
}): (T & { last: string | null; nextAt: number | null })[] {
  const latest = new Map<string, { verdict: string; posted_at: number }>();
  for (const p of recent) {
    const k = `${p.chain}:${p.vault.toLowerCase()}`;
    const seen = latest.get(k);
    if (!seen || p.posted_at > seen.posted_at) latest.set(k, p);
  }
  return entries.map((e) => {
    const p = latest.get(`${e.chain}:${e.vault.toLowerCase()}`);
    const next = p ? p.posted_at + spacingS : null;
    return { ...e, last: p?.verdict ?? null, nextAt: next !== null && next > nowS ? next : null };
  });
}

export function menuNote(v: { last: string | null; nextAt: number | null }): string | null {
  if (!v.last) return null;
  return v.nextAt ? `last call ${v.last} · next from ${utcTime(v.nextAt)} UTC` : `last call ${v.last}`;
}

/** The wallet call that pays for a judgement: NEAR goes to `request_judgement`, USDC through `ft_transfer_call`. */
export function paymentCall(
  rail: 'near' | 'usdc',
  sel: { chain: DeskChain; vault: string },
  policy: PayPolicy,
  desk: string,
): WalletCall {
  const args = { chain: sel.chain, vault: sel.vault.toLowerCase() };
  if (rail === 'near') return { receiverId: desk, methodName: 'request_judgement', args, deposit: policy.priceNear };
  if (!policy.usdcToken) throw new Error('USDC orders are off.');
  return {
    receiverId: policy.usdcToken,
    methodName: 'ft_transfer_call',
    deposit: '1',
    args: { receiver_id: desk, amount: policy.priceUsdc, msg: JSON.stringify(args) },
  };
}
