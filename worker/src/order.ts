import { keccak256, type Hex } from 'viem';
import { buildDoc, type VaultReading } from './doc';
import type { DeskChain } from '../../shared/desk';
import type { DeskClient, DeskOrder, DeskTx } from './deskTypes';
import { JudgeError, type judge as judgeFn, type Judgement } from './judge';

export interface Receipt {
  status: 'success' | 'reverted';
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  /** OP-stack L1 data fee, where the chain charges one. */
  l1Fee?: bigint | null;
}

/** What the order loop needs from an EVM chain. `broadcast.ts` implements it with viem. */
export interface ChainClient {
  balance(address: string): Promise<bigint>;
  /** Next nonce of `address`, counting pending transactions. */
  nonce(address: string): Promise<number>;
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Dry-runs the oracle post the answer leads to, from the desk's derived address. */
  simulate(call: { from: string; order: DeskOrder; doc: string; response: string; validUntil: number }): Promise<{ ok: true } | { ok: false; reason: string }>;
  sendRaw(raw: Hex): Promise<Hex>;
  /** The receipt, or null if not mined. With `wait`, waits a short while for it first. */
  receipt(hash: Hex, opts?: { wait?: boolean }): Promise<Receipt | null>;
}

export interface OrderDeps {
  desk: DeskClient;
  read(chain: DeskChain, vault: string): Promise<VaultReading>;
  flows(chain: DeskChain, vault: string): Promise<{ netOutPct1h: number }>;
  judge: typeof judgeFn;
  chain(c: DeskChain): ChainClient;
  now(): number;
  alert(msg: string): Promise<void>;
}

export type OrderOutcome = 'delivered' | 'rejected' | 'pending';

/** Gas the derived address must hold before the desk signs a post for it (1 MON, 0.0001 ETH). */
export const MIN_GAS_WEI: Record<DeskChain, bigint> = { 'monad-testnet': 10n ** 18n, monad: 10n ** 18n, base: 10n ** 14n, 'base-sepolia': 10n ** 14n };
/** The second EXIT reading must come this long after the first, and no later than EXIT_MAX_S. */
export const EXIT_MIN_S = 30;
export const EXIT_MAX_S = 300;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 120);

/**
 * Advances one order as far as it can go now. Everything it decides on comes from the desk's state, so calling it
 * again on the same order, from any tick, picks up where the last call stopped.
 */
export async function processOrder(order: DeskOrder, deps: OrderDeps): Promise<OrderOutcome> {
  switch (order.status) {
    case 'delivered':
      return 'delivered';
    case 'rejected':
    case 'refunded':
    case 'post_failed':
      return 'rejected';
    case 'signing':
      // Chain Signatures is working. If it fails the desk puts the order back and a later tick retries.
      return 'pending';
    case 'signed':
      return deliver(order, deps, false);
    case 'exit_pending': {
      const since = order.exit_pending_s;
      if (since !== null) {
        const age = deps.now() - since;
        // Past EXIT_MAX_S the desk returns the order to open; until then there is nothing to do.
        if (age < EXIT_MIN_S || age > EXIT_MAX_S) return 'pending';
      }
      return answer(order, deps, 'confirm_exit');
    }
    case 'open':
      return answer(order, deps, 'fulfil');
  }
}

async function reject(order: DeskOrder, deps: OrderDeps, reason: string): Promise<OrderOutcome> {
  await deps.desk.reject(order.id, reason);
  return 'rejected';
}

async function txParams(chain: ChainClient, from: string): Promise<DeskTx> {
  const [nonce, fees] = await Promise.all([chain.nonce(from), chain.fees()]);
  return { nonce, max_fee_per_gas: String(fees.maxFeePerGas), max_priority_fee_per_gas: String(fees.maxPriorityFeePerGas) };
}

/** Reads the vault, gets a signed answer the desk accepts, and hands it to `fulfil` or `confirm_exit`. */
async function answer(order: DeskOrder, deps: OrderDeps, call: 'fulfil' | 'confirm_exit'): Promise<OrderOutcome> {
  const { desk } = deps;
  const chain = deps.chain(order.chain);
  const from = await desk.derived_address();
  if ((await chain.balance(from)) < MIN_GAS_WEI[order.chain]) return reject(order, deps, 'low gas balance');

  let doc: string;
  try {
    const [reading, flows] = await Promise.all([deps.read(order.chain, order.vault), deps.flows(order.chain, order.vault)]);
    doc = buildDoc(order, reading, flows, deps.now());
  } catch (e) {
    return reject(order, deps, `vault read failed: ${short(message(e))}`);
  }

  const prompt = await desk.prompt();
  let j: Judgement | undefined;
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    let candidate: Judgement;
    try {
      candidate = await deps.judge(doc, prompt, {});
    } catch (e) {
      if (e instanceof JudgeError && e.stage === 'signature') return reject(order, deps, 'signature unavailable');
      return reject(order, deps, 'judge unavailable');
    }
    const verdict = await desk.check_reading(order.id, doc, candidate.response, candidate.signature);
    if (verdict === 'ok') j = candidate;
    else if (verdict === 'bad answer' && attempt === 0) continue;
    else {
      if (verdict === 'unknown signer') await deps.alert(`order ${order.id}: unknown signer ${candidate.signingAddress}`);
      return reject(order, deps, verdict);
    }
  }
  if (!j) return reject(order, deps, 'bad answer');

  const { deadline_s } = await desk.policy();
  const validUntil = deps.now() + deadline_s;
  const sim = await chain.simulate({ from, order, doc, response: j.response, validUntil });
  if (!sim.ok) return reject(order, deps, `oracle revert: ${short(sim.reason)}`);

  try {
    await desk[call](order.id, doc, j.response, j.signature, await txParams(chain, from));
  } catch (e) {
    // Usually Chain Signatures failing: the desk keeps the order where it was and the next tick tries again.
    console.warn(`order ${order.id}: ${call} failed: ${message(e)}`);
    return 'pending';
  }
  const after = await desk.get_order(order.id);
  return after?.status === 'signed' ? deliver(after, deps, false) : after ? settled(after) : 'pending';
}

function settled(order: DeskOrder): OrderOutcome {
  if (order.status === 'delivered') return 'delivered';
  if (order.status === 'rejected' || order.status === 'refunded' || order.status === 'post_failed') return 'rejected';
  return 'pending';
}

function errorText(e: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = e; c && parts.length < 5; c = (c as { cause?: unknown }).cause) parts.push(message(c));
  return parts.join(' | ');
}
const isNonceTooLow = (e: unknown) => /nonce too low|nonce has already been used|NonceTooLow/i.test(errorText(e));
const isAlreadyKnown = (e: unknown) => /already known|already imported|known transaction/i.test(errorText(e));

/** Broadcasts the desk's signed post, then atomically records its receipt fee and delivery. */
async function deliver(order: DeskOrder, deps: OrderDeps, resigned: boolean): Promise<OrderOutcome> {
  const { desk } = deps;
  const chain = deps.chain(order.chain);
  const raw = (await desk.get_signed_tx(order.id)) as Hex | null;
  if (!raw) return 'pending';
  const hash = keccak256(raw);

  let receipt = await chain.receipt(hash);
  if (!receipt) {
    try {
      await chain.sendRaw(raw);
    } catch (e) {
      if (isNonceTooLow(e)) {
        // Either this very transaction landed already, or another one used its nonce.
        if (!(await chain.receipt(hash))) {
          if (resigned) return 'pending';
          await desk.resign(order.id, await txParams(chain, await desk.derived_address()));
          const after = await desk.get_order(order.id);
          return after?.status === 'signed' ? deliver(after, deps, true) : 'pending';
        }
      } else if (!isAlreadyKnown(e)) {
        console.warn(`order ${order.id}: broadcast failed: ${errorText(e)}`);
        return 'pending';
      }
    }
    receipt = await chain.receipt(hash, { wait: true });
    if (!receipt) return 'pending';
  }

  if (receipt.status !== 'success') {
    await deps.alert(`order ${order.id}: post ${hash} reverted on ${order.chain}`);
    return reject(order, deps, 'oracle revert');
  }
  await desk.report_delivery(order.id, hash, String(receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n)));
  return 'delivered';
}
