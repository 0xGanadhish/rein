import {
  BaseError, ContractFunctionRevertedError, createPublicClient, http, keccak256, parseAbi, toBytes, type Address, type Hex,
} from 'viem';
import { base, monad, monadTestnet } from 'viem/chains';
import type { DeskChain, DeskOrder } from './deskTypes';
import type { ChainClient, Receipt } from './order';

const CHAINS = { 'monad-testnet': monadTestnet, monad, base } as const;

/** Oracle each chain posts verdicts to. Null until it is deployed there; simulation then refuses every post. */
export const ORACLES: Record<DeskChain, Address | null> = { 'monad-testnet': null, monad: null, base: null };

const oracleAbi = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash) returns (uint256)',
  'error NotAttester()', 'error VaultNotRegistered()', 'error BpsOutOfRange()', 'error InsufficientGas()',
]);
/** Answer actions in verdict order: HOLD 0, EXIT 1, MOVE 2. */
const VERDICTS = { hold: 0, exit: 1, rotate: 2 } as const;

/**
 * The oracle `post` arguments a judged answer turns into. The model's message content is
 * `{"action":"hold|exit|rotate","confidence_bps":N,"withdrawal_risk_bps":N}`, and the post commits to the doc by its
 * keccak256.
 */
export function postArgs(order: DeskOrder, doc: string, response: string): readonly [Address, number, number, number, Hex] {
  const content = (JSON.parse(response) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  const a = JSON.parse(content ?? '') as { action?: string; confidence_bps?: number; withdrawal_risk_bps?: number };
  const verdict = Object.hasOwn(VERDICTS, a.action ?? '') ? VERDICTS[a.action as keyof typeof VERDICTS] : undefined;
  if (verdict === undefined || !Number.isInteger(a.confidence_bps) || !Number.isInteger(a.withdrawal_risk_bps)) {
    throw new Error('answer has no verdict');
  }
  return [order.vault, verdict, a.confidence_bps!, a.withdrawal_risk_bps!, keccak256(toBytes(doc))];
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) return `${revert.data.errorName}()`;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/** How long a broadcast waits for its receipt before leaving it to the next tick. */
const RECEIPT_WAIT_MS = 30_000;

export function viemChain(chain: DeskChain, rpc: string): ChainClient {
  const client = createPublicClient({ chain: CHAINS[chain], transport: http(rpc, { retryCount: 2 }) });
  const toReceipt = (r: { status: 'success' | 'reverted'; gasUsed: bigint; effectiveGasPrice: bigint; l1Fee?: bigint | null }): Receipt =>
    ({ status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, l1Fee: r.l1Fee ?? null });
  return {
    balance: (address) => client.getBalance({ address: address as Address }),
    nonce: (address) => client.getTransactionCount({ address: address as Address, blockTag: 'pending' }),
    async fees() {
      const f = await client.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    },
    async simulate({ from, order, doc, response }) {
      const oracle = ORACLES[chain];
      if (!oracle) return { ok: false, reason: `no oracle on ${chain}` };
      let args: ReturnType<typeof postArgs>;
      try { args = postArgs(order, doc, response); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
      try {
        await client.simulateContract({ account: from as Address, address: oracle, abi: oracleAbi, functionName: 'post', args });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: revertReason(e) };
      }
    },
    sendRaw: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    async receipt(hash, opts) {
      try {
        const r = opts?.wait
          ? await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS })
          : await client.getTransactionReceipt({ hash });
        return toReceipt(r);
      } catch (e) {
        const name = e instanceof BaseError ? e.name : '';
        if (name === 'TransactionReceiptNotFoundError' || name === 'WaitForTransactionReceiptTimeoutError') return null;
        throw e;
      }
    },
  };
}
