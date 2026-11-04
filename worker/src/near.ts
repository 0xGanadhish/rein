import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import type { KeyPairString } from '@near-js/crypto';
import type { DeskClient, DeskOrder, DeskPrompt, DeskTx } from './deskTypes';
import { NEAR_RPC, type Env } from './env';

/** Calls that ask Chain Signatures for a signature need the most gas a transaction can carry. */
const SIGN_GAS = 300_000_000_000_000n;
const CALL_GAS = 30_000_000_000_000n;

/** The desk contract, viewed through NEAR RPC and called as the agent account. */
export function nearDesk(env: Env): DeskClient {
  const provider = new JsonRpcProvider({ url: NEAR_RPC[env.NEAR_NETWORK] });
  let agent: Account | undefined;
  const signer = () => (agent ??= new Account(env.AGENT_ACCOUNT, provider, KeyPairSigner.fromSecretKey(env.AGENT_KEY as KeyPairString)));

  async function view<T>(methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await provider.callFunction(env.DESK_ACCOUNT, methodName, args)) as T;
  }
  async function call(methodName: string, args: Record<string, unknown>, gas = CALL_GAS): Promise<void> {
    await signer().callFunction({ contractId: env.DESK_ACCOUNT, methodName, args, gas });
  }
  const reading = (order_id: number, doc: string, response: string, signature: string) => ({ order_id, doc, response, signature });

  return {
    open_orders: (limit) => view<DeskOrder[]>('open_orders', { limit }),
    list_orders: (from, limit) => view<DeskOrder[]>('list_orders', { from, limit }),
    get_order: async (id) => (await view<DeskOrder | null>('get_order', { id })) ?? null,
    policy: () => view<Record<string, unknown>>('policy'),
    prompt: () => view<DeskPrompt>('prompt'),
    signers: () => view<string[]>('signers'),
    get_signed_tx: async (order_id) => (await view<string | null>('get_signed_tx', { order_id })) ?? null,
    derived_address: () => view<string>('derived_address'),
    check_reading: (order_id, doc, response, signature) => view<string>('check_reading', reading(order_id, doc, response, signature)),
    fulfil: (order_id, doc, response, signature, tx: DeskTx) => call('fulfil', { ...reading(order_id, doc, response, signature), tx }, SIGN_GAS),
    confirm_exit: (order_id, doc, response, signature, tx: DeskTx) => call('confirm_exit', { ...reading(order_id, doc, response, signature), tx }, SIGN_GAS),
    resign: (order_id, tx) => call('resign', { order_id, tx }, SIGN_GAS),
    report_delivery: (order_id, tx_hash) => call('report_delivery', { order_id, tx_hash }),
    record_gas: (order_id, gas_wei) => call('record_gas', { order_id, gas_wei }),
    reject: (order_id, reason) => call('reject', { order_id, reason }),
  };
}
