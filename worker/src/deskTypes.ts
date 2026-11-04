/** Worker-side desk types that shared/desk.ts doesn't have. */
import type { DeskChain, DeskOrder as SharedDeskOrder, DeskPolicy, DeskStats } from '../../shared/desk';
import type { NearNetwork } from './env';

export const CHAIN_IDS: Record<DeskChain, number> = { 'monad-testnet': 10143, monad: 143, base: 8453 };
/** The EVM chains a desk on each NEAR network posts to. */
export const NETWORK_CHAINS: Record<NearNetwork, DeskChain[]> = { testnet: ['monad-testnet'], mainnet: ['monad', 'base'] };

export interface DeskOrder extends SharedDeskOrder {
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

export interface DeskClient {
  open_orders(limit: number): Promise<DeskOrder[]>;
  list_orders(from: number, limit: number): Promise<DeskOrder[]>;
  get_order(id: number): Promise<DeskOrder | null>;
  policy(): Promise<DeskPolicy>;
  /** Vaults on the menu for `chain`, 0x-lowercase. */
  menu(chain: DeskChain): Promise<string[]>;
  stats(): Promise<DeskStats>;
  /** Opens a watch order and returns its id; throws when the desk refuses it. */
  submit_watch_request(chain: DeskChain, vault: string): Promise<number>;
  /** Records an order paid offchain over x402 and returns its id; `amount` is USDC base units. Throws when refused. */
  submit_x402_request(chain: DeskChain, vault: string, payment_ref: string, amount: string): Promise<number>;
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
