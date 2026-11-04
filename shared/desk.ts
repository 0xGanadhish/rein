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

/** One value per chain, keyed by chain name. */
export type DeskPerChain<T> = Record<DeskChain, T>;

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
  /** Rein oracle per chain, 0x hex; null refuses posts to that chain. */
  oracle: DeskPerChain<string | null>;
  /** Gas limit of a post. */
  gas_limit: DeskPerChain<number>;
  /** Highest max_fee_per_gas the desk signs, wei. */
  max_fee_cap: DeskPerChain<string>;
  /** Chain Signatures contract. */
  signer: string;
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
  /** Model tokens across accepted readings. */
  inference_tokens_in: number;
  inference_tokens_out: number;
  /** EVM gas spent on posts, wei, as reported by the agent. */
  gas_wei: DeskPerChain<string>;
  /** Split credited when NEAR- and USDC-paid orders are signed. */
  paid_treasury: DeskAmounts;
  paid_agent: DeskAmounts;
  /** USDC from failed split transfers, claimable with claim_owed. */
  owed: string;
  /** Watch orders opened. */
  watch_orders: number;
}

/** yoctoNEAR and USDC base units. */
export interface DeskAmounts {
  near: string;
  usdc: string;
}

/** `msg` for an `ft_transfer_call` of `price_usdc` to the desk. */
export interface DeskFtMsg {
  chain: DeskChain;
  vault: string;
}

/** `prompt` view and `set_prompt` arguments. The model request body is `prefix + doc + suffix`. */
export interface DeskPrompt {
  model: string;
  prefix: string;
  suffix: string;
}

/** `signers` view: accepted model signing addresses, 0x-prefixed lowercase hex. */
export type DeskSigners = string[];

/** `check_reading` arguments. `signature` is 65 bytes `r || s || v` in hex, 0x optional. */
export interface DeskCheckReadingArgs {
  order_id: number;
  doc: string;
  response: string;
  signature: string;
}

/** `check_reading` result: `ok`, or why delivery would refuse the reading now. */
export type DeskCheckReading =
  | 'ok'
  | 'no such order'
  | 'bad doc'
  | 'bad signature'
  | 'unknown signer'
  | 'wrong order'
  | 'wrong chain'
  | 'wrong vault'
  | 'stale doc'
  | 'bad answer';

/** Nonce and fees the agent picks for a post; the desk caps max_fee_per_gas per chain. */
export interface DeskTxParams {
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

/** `fulfil` and `confirm_exit` arguments. */
export interface DeskReadingArgs extends DeskCheckReadingArgs {
  tx: DeskTxParams;
}

/** `resign` arguments. */
export interface DeskResignArgs {
  order_id: number;
  tx: DeskTxParams;
}

/** `report_delivery` arguments. `tx_hash` is the EVM transaction hash, 0x + 64 hex. */
export interface DeskReportDeliveryArgs {
  order_id: number;
  tx_hash: string;
}

/** `record_gas` arguments. `gas_wei` is a decimal string. */
export interface DeskRecordGasArgs {
  order_id: number;
  gas_wei: string;
}
