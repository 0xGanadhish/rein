import type { DeskChain } from '../../shared/desk';

/** USDC asset IDs from https://1click.chaindefuser.com/v0/tokens (GET, 2026-11-11). No testnet assets. */
export const ASSETS: Partial<Record<DeskChain, string>> = {
  base: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  monad: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
};

/** Six-decimal USDC origins from the same public token catalog. */
export const USDC_ORIGINS = [
  { chain: 'base', name: 'Base', asset: ASSETS.base! },
  { chain: 'monad', name: 'Monad', asset: ASSETS.monad! },
  { chain: 'eth', name: 'Ethereum', asset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near' },
  { chain: 'arb', name: 'Arbitrum', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near' },
  { chain: 'sol', name: 'Solana', asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near' },
];

export interface DepositQuote {
  depositAddress: string;
  expiresAt: string;
}

/** Quote only: the caller must send the deposit themselves. */
export async function depositQuote(api: string, body: Record<string, string>): Promise<DepositQuote> {
  const res = await fetch(`${api}/v1/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const quote = await res.json();
  if (!res.ok) throw new Error(quote.error ?? 'Quote unavailable.');
  if (!quote.depositAddress || !quote.expiresAt) throw new Error('Quote is missing its deposit address or expiry.');
  return quote;
}
