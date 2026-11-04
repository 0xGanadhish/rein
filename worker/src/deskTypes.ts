/** JSON shapes of the desk contract on NEAR. Kept here until the shared desk types land; swap the import then. */

export type DeskChain = 'monad-testnet' | 'monad' | 'base';
export const CHAIN_IDS: Record<DeskChain, number> = { 'monad-testnet': 10143, monad: 143, base: 8453 };

export type OrderSource = 'near' | 'usdc' | 'x402' | 'watch';
export type OrderStatus = 'open' | 'exit_pending' | 'signing' | 'signed' | 'delivered' | 'rejected' | 'refunded';

export interface DeskOrder {
  id: number;
  source: OrderSource;
  payer: string;
  chain: DeskChain;
  /** 0x-prefixed, lowercase. */
  vault: `0x${string}`;
  /** U128 as a decimal string. */
  amount: string;
  created_s: number;
  status: OrderStatus;
  /**
   * When the order entered `exit_pending`, if the contract exposes it. Without it the Worker tries `confirm_exit`
   * on every tick and leaves the 30 s to 5 min window to the contract.
   */
  exit_pending_s?: number;
}

export interface DeskPrompt {
  model: string;
  prefix: string;
  suffix: string;
}

/** Fee and nonce the desk signs the post with. U128 values are decimal strings. */
export interface DeskTx {
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
}

export type RefusalReason =
  | 'bad doc' | 'bad signature' | 'unknown signer' | 'wrong order' | 'wrong chain' | 'wrong vault' | 'stale doc' | 'bad answer';

export interface DeskClient {
  open_orders(limit: number): Promise<DeskOrder[]>;
  list_orders(from: number, limit: number): Promise<DeskOrder[]>;
  get_order(id: number): Promise<DeskOrder | null>;
  policy(): Promise<Record<string, unknown>>;
  prompt(): Promise<DeskPrompt>;
  signers(): Promise<string[]>;
  get_signed_tx(order_id: number): Promise<string | null>;
  derived_address(): Promise<string>;
  /** `ok`, or a refusal reason. */
  check_reading(order_id: number, doc: string, response: string, signature: string): Promise<string>;
  fulfil(order_id: number, doc: string, response: string, signature: string, tx: DeskTx): Promise<void>;
  confirm_exit(order_id: number, doc: string, response: string, signature: string, tx: DeskTx): Promise<void>;
  resign(order_id: number, tx: DeskTx): Promise<void>;
  report_delivery(order_id: number, tx_hash: string): Promise<void>;
  /** U128 as a decimal string. */
  record_gas(order_id: number, gas_wei: string): Promise<void>;
  reject(order_id: number, reason: string): Promise<void>;
}
