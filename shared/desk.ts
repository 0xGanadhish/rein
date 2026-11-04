/** JSON shapes of the NEAR desk contract's views and arguments. u128 amounts are decimal strings. */

export type DeskChain = 'monad-testnet' | 'monad' | 'base';
export type DeskSource = 'near' | 'usdc' | 'x402' | 'watch';
export type DeskOrderStatus = 'open' | 'exit_pending' | 'signing' | 'signed' | 'delivered' | 'rejected' | 'refunded';

export interface DeskOrder {
  id: number;
  source: DeskSource;
  /** Refund recipient; null for watch and x402 orders, which hold no onchain escrow. */
  payer: string | null;
  chain: DeskChain;
  /** 0x-prefixed lowercase hex. */
  vault: string;
  /** yoctoNEAR for `near`, USDC base units for `usdc` and `x402`, "0" for `watch`. */
  amount: string;
  created_s: number;
  status: DeskOrderStatus;
}

export interface DeskPolicy {
  spacing_s: number;
  per_vault_max: number;
  global_max: number;
  watch_daily_max: number;
  deadline_s: number;
  doc_max_age_s: number;
  exit_confirm_min_s: number;
  exit_confirm_max_s: number;
  max_open_paid: number;
  /** USDC base units (6 decimals). */
  price_usdc: string;
  /** yoctoNEAR. */
  price_near: string;
  split_treasury_bps: number;
  split_agent_bps: number;
  kill: boolean;
  /** Null disables USDC orders. */
  usdc_token: string | null;
  agent: string;
  treasury: string;
}

export interface DeskStats {
  /** yoctoNEAR accepted into escrow, gross of refunds. */
  sales_near: string;
  /** USDC accepted via ft_transfer_call, gross of refunds. */
  sales_usdc: string;
  /** USDC paid offchain over x402, as reported by the agent. */
  sales_x402_usdc: string;
  /** Orders refunded or rejected. */
  refunds: number;
  /** Unfinished paid orders. */
  open_paid: number;
}

/** `msg` for an `ft_transfer_call` of `price_usdc` to the desk. */
export interface DeskFtMsg {
  chain: DeskChain;
  vault: string;
}
