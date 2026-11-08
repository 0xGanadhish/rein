import { encodeFunctionData, parseEventLogs, type Address, type Hex, type Log } from 'viem';
import type { DeskChain } from '../../../shared/desk';
import { oracleAbi } from '../abis';
import { RESOLVE_WINDOW_S, SAMPLE_WINDOW_S } from './cadence';

const RESOLVE_BATCH = 20;

/** Sends one transaction and waits for its receipt. */
export interface Sender {
  send(tx: { to: Address; data: Hex; kind: 'sample' | 'resolve'; verdictId: number }): Promise<{ status: 'success' | 'reverted'; hash: Hex; logs: Log[]; resolvedAt?: number }>;
}

export interface ResolverDeps {
  /** The chain's oracle. */
  oracle: Address;
  readResolution(id: bigint): Promise<{ resolved: boolean; adverse: boolean; reasons: number; resolvedAt?: number }>;
  sender: Sender;
  /** Uniform in [0, 1); picks when the second sample is taken. Unpredictable in production. */
  random?: () => number;
}

const secureRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
/** The second sample lands somewhere between 5 minutes after the first and 5 minutes before the window closes. */
const RESAMPLE_MARGIN_S = 5 * 60;

/** Error text for logs, with URLs cut out so an RPC key in one never reaches them. */
const safeError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300);

/**
 * Grades every post on `chain` whose windows have ended, oldest first. Where the chain has a sampling window, it
 * samples each post twice: as soon as the window opens (so a flash loan around someone else's sample can't flatter
 * the grade), and again at a random moment it doesn't announce (so faking a healthy vault means keeping the money in
 * for the whole window). Anyone may call resolve(), so posts someone else already graded are synced from chain
 * instead of sent again. A post that reaches grading unsampled is logged and counted.
 */
export async function resolveDue(env: { DB: D1Database }, chain: DeskChain, now: number, deps: ResolverDeps): Promise<{ sampled: number; sent: number; synced: number; failed: number; unsampled: number }> {
  const tally = { sampled: 0, sent: 0, synced: 0, failed: 0, unsampled: 0 };
  const random = deps.random ?? secureRandom;
  const opensAfter = RESOLVE_WINDOW_S[chain];
  const closesAfter = opensAfter + SAMPLE_WINDOW_S[chain];

  if (SAMPLE_WINDOW_S[chain] > 0) {
    const { results } = await env.DB.prepare(`SELECT id, posted_at, sampled FROM posts WHERE chain = ? AND resolved = 0
        AND (sampled = 0 OR (sampled = 1 AND resample_at <= ?)) AND posted_at + ? <= ? AND posted_at + ? > ? ORDER BY posted_at, id LIMIT ?`)
      .bind(chain, now, opensAfter, now, closesAfter, now, RESOLVE_BATCH).all<{ id: number; posted_at: number; sampled: number }>();
    for (const { id, posted_at: postedAt, sampled } of results) {
      try {
        const receipt = await deps.sender.send({
          to: deps.oracle, kind: 'sample', verdictId: id,
          data: encodeFunctionData({ abi: oracleAbi, functionName: 'sample', args: [BigInt(id)] }),
        });
        if (receipt.status !== 'success') throw new Error(`sample reverted (${receipt.hash})`);
        if (sampled === 0) {
          const earliest = now + RESAMPLE_MARGIN_S;
          const latest = Math.max(earliest, postedAt + closesAfter - RESAMPLE_MARGIN_S);
          const resampleAt = earliest + Math.floor(random() * (latest - earliest));
          await env.DB.prepare('UPDATE posts SET sampled = 1, resample_at = ? WHERE chain = ? AND id = ?').bind(resampleAt, chain, id).run();
        } else {
          await env.DB.prepare('UPDATE posts SET sampled = 2 WHERE chain = ? AND id = ?').bind(chain, id).run();
        }
        tally.sampled++;
        console.log(JSON.stringify({ msg: 'verdict_sampled', chain, verdictId: id, sample: sampled + 1, txHash: receipt.hash }));
      } catch (err) {
        tally.failed++;
        console.error(JSON.stringify({ msg: 'sample_failed', chain, verdictId: id, error: safeError(err) }));
      }
    }
  }

  const { results } = await env.DB.prepare(`SELECT id, sampled FROM posts WHERE chain = ? AND resolved = 0 AND posted_at + ? <= ? ORDER BY posted_at, id LIMIT ?`)
    .bind(chain, closesAfter, now, RESOLVE_BATCH).all<{ id: number; sampled: number }>();
  const save = (id: number, adverse: boolean, reasons: number, resolvedAt?: number) => env.DB.prepare('UPDATE posts SET resolved = 1, adverse = ?, reasons = ?, resolved_at = ? WHERE chain = ? AND id = ?')
    .bind(adverse ? 1 : 0, reasons, resolvedAt ?? null, chain, id).run();
  for (const { id, sampled } of results) {
    if (SAMPLE_WINDOW_S[chain] > 0 && sampled === 0) {
      // The grading window passed without our sample (executor out of gas, RPC down): the contract falls back to one
      // reading at resolve time, which can be flattered. Loud, so it gets looked at.
      tally.unsampled++;
      console.error(JSON.stringify({ msg: 'resolve_unsampled', chain, verdictId: id }));
    }
    try {
      const onchain = await deps.readResolution(BigInt(id));
      if (onchain.resolved) {
        await save(id, onchain.adverse, onchain.reasons, onchain.resolvedAt);
        tally.synced++;
        continue;
      }
      const receipt = await deps.sender.send({
        to: deps.oracle, kind: 'resolve', verdictId: id,
        data: encodeFunctionData({ abi: oracleAbi, functionName: 'resolve', args: [BigInt(id)] }),
      });
      if (receipt.status !== 'success') throw new Error(`resolve reverted (${receipt.hash})`);
      const event = parseEventLogs({ abi: oracleAbi, eventName: 'VerdictResolved', logs: receipt.logs }).find((e) => e.args.id === BigInt(id));
      if (!event) throw new Error(`no VerdictResolved for ${id} in ${receipt.hash}`);
      await save(id, event.args.adverse, event.args.reasons, receipt.resolvedAt);
      tally.sent++;
      console.log(JSON.stringify({ msg: 'verdict_resolved', chain, verdictId: id, adverse: event.args.adverse, reasons: event.args.reasons, txHash: receipt.hash }));
    } catch (err) {
      tally.failed++;
      console.error(JSON.stringify({ msg: 'resolve_failed', chain, verdictId: id, error: safeError(err) }));
    }
  }
  return tally;
}
