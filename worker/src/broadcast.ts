import { DEPLOYMENTS } from '../../shared/deployments';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeFunctionData,
  http,
  keccak256,
  parseTransaction,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { base, baseSepolia, monad, monadTestnet } from 'viem/chains';
import type { DeskChain } from '../../shared/desk';
import type { DeskOrder } from './deskTypes';
import type { ChainClient, Receipt } from './order';
import { oracleAbi } from './abis';

export const CHAINS = { 'monad-testnet': monadTestnet, monad, base, 'base-sepolia': baseSepolia } as const;

/** Oracle each chain posts verdicts to, from the deployment manifest. Null until it is deployed there; simulation then refuses every post. */
export const ORACLES: Record<DeskChain, Address | null> = {
  'monad-testnet': DEPLOYMENTS.testnet.oracles['monad-testnet'] ?? null,
  monad: DEPLOYMENTS.mainnet.oracles.monad ?? null,
  base: DEPLOYMENTS.mainnet.oracles.base ?? null,
  'base-sepolia': DEPLOYMENTS.testnet.oracles['base-sepolia'] ?? null,
};

/** Answer actions in verdict order: HOLD 0, EXIT 1, MOVE 2. */
const VERDICTS = { hold: 0, exit: 1, rotate: 2 } as const;

/**
 * The oracle `post` arguments a judged answer turns into. The model's message content is
 * `{"action":"hold|exit|rotate","confidence_bps":N,"withdrawal_risk_bps":N}`, and the post commits to the doc by its
 * keccak256.
 */
export function postArgs(
  order: DeskOrder,
  doc: string,
  response: string,
  validUntil: number,
): readonly [Address, number, number, number, Hex, bigint] {
  const content = (JSON.parse(response) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
    ?.content;
  const a = JSON.parse(content ?? '') as { action?: string; confidence_bps?: number; withdrawal_risk_bps?: number };
  const verdict = Object.hasOwn(VERDICTS, a.action ?? '') ? VERDICTS[a.action as keyof typeof VERDICTS] : undefined;
  if (verdict === undefined || !Number.isInteger(a.confidence_bps) || !Number.isInteger(a.withdrawal_risk_bps)) {
    throw new Error('answer has no verdict');
  }
  return [
    order.vault as Address,
    verdict,
    a.confidence_bps!,
    a.withdrawal_risk_bps!,
    keccak256(toBytes(doc)),
    BigInt(validUntil),
  ];
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
  const toReceipt = (r: {
    status: 'success' | 'reverted';
    gasUsed: bigint;
    effectiveGasPrice: bigint;
    l1Fee?: bigint | null;
  }): Receipt => ({
    status: r.status,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    l1Fee: r.l1Fee ?? null,
  });
  return {
    balance: (address) => client.getBalance({ address: address as Address }),
    nonce: (address, blockTag = 'pending') => client.getTransactionCount({ address: address as Address, blockTag }),
    async fees() {
      const f = await client.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
    },
    async simulate({ from, order, doc, response, validUntil }) {
      const oracle = ORACLES[chain];
      if (!oracle) return { ok: false, reason: `no oracle on ${chain}` };
      let args: ReturnType<typeof postArgs>;
      try {
        args = postArgs(order, doc, response, validUntil);
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
      try {
        await client.simulateContract({
          account: from as Address,
          address: oracle,
          abi: oracleAbi,
          functionName: 'post',
          args,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: revertReason(e) };
      }
    },
    sendRaw: (raw) => client.sendRawTransaction({ serializedTransaction: raw }),
    async statePosted(raw) {
      const tx = parseTransaction(raw);
      if (!tx.to || !tx.data) throw new Error('signed post has no oracle calldata');
      const call = decodeFunctionData({ abi: oracleAbi, data: tx.data });
      if (call.functionName !== 'post') throw new Error('signed transaction is not a post');
      return client.readContract({ address: tx.to, abi: oracleAbi, functionName: 'statePosted', args: [call.args[4]] });
    },
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
