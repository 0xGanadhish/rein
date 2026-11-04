import { encodeFunctionData, parseEventLogs, createPublicClient, http } from 'viem';
import { abis } from '../../shared/contracts';
import { NETWORKS, UNDEPLOYED, type Network } from '../../shared/networks';
import { RESOLVE_WINDOW_S, SAMPLE_WINDOW_S } from './cadence';
import { rpcFor, type Env } from './env';
import { safeError } from './errors';
import { txSender, type Sender } from './txSender';

const RESOLVE_BATCH = 20;

export interface ResolverDeps {
  readResolution(network: Network, id: bigint): Promise<{ resolved: boolean; adverse: boolean; reasons: number }>;
  sender(network: Network): Sender;
  /** Uniform in [0, 1); picks when the second sample is taken. Unpredictable in production. */
  random?: () => number;
}

const secureRandom = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
/** The second sample lands somewhere between 5 minutes after the first and 5 minutes before the window closes. */
const RESAMPLE_MARGIN_S = 5 * 60;

export function realResolverDeps(env: Env): ResolverDeps {
  return {
    async readResolution(network, id) {
      const client = createPublicClient({ chain: NETWORKS[network].chain, transport: http(rpcFor(env, network), { retryCount: 2 }) });
      const r = await client.readContract({ address: NETWORKS[network].oracle, abi: abis.oracle, functionName: 'getResolution', args: [id] });
      return { resolved: r.resolved, adverse: r.adverse, reasons: r.reasons };
    },
    sender: (network) => txSender(env, network, 'executor'),
  };
}

/**
 * Resolver (plan Task 13, spec §2b): grade every post whose windows have ended, oldest first. Where the network has a
 * sampling window, it samples each post twice: as soon as the window opens (so a flash loan around someone else's
 * sample can't flatter the grade), and again at a random moment it doesn't announce (so faking a healthy vault means
 * keeping the money in for the whole window). Anyone may call resolve(), so posts someone else already graded are
 * synced from chain instead of sent again. A post that reaches grading unsampled is logged and counted.
 */
export async function resolveDue(env: Env, network: Network, now: number, deps: ResolverDeps = realResolverDeps(env)): Promise<{ sampled: number; sent: number; synced: number; failed: number; unsampled: number }> {
  const tally = { sampled: 0, sent: 0, synced: 0, failed: 0, unsampled: 0 };
  const random = deps.random ?? secureRandom;
  const opensAfter = RESOLVE_WINDOW_S[network];
  const closesAfter = opensAfter + SAMPLE_WINDOW_S[network];

  if (SAMPLE_WINDOW_S[network] > 0) {
    const { results } = await env.DB.prepare(`SELECT id, posted_at, sampled FROM posts WHERE network = ? AND resolved = 0
        AND (sampled = 0 OR (sampled = 1 AND resample_at <= ?)) AND posted_at + ? <= ? AND posted_at + ? > ? ORDER BY posted_at, id LIMIT ?`)
      .bind(network, now, opensAfter, now, closesAfter, now, RESOLVE_BATCH).all<{ id: number; posted_at: number; sampled: number }>();
    for (const { id, posted_at: postedAt, sampled } of results) {
      try {
        const receipt = await deps.sender(network).send({
          to: NETWORKS[network].oracle, kind: 'sample',
          data: encodeFunctionData({ abi: abis.oracle, functionName: 'sample', args: [BigInt(id)] }),
        });
        if (receipt.status !== 'success') throw new Error(`sample reverted (${receipt.hash})`);
        if (sampled === 0) {
          const earliest = now + RESAMPLE_MARGIN_S;
          const latest = Math.max(earliest, postedAt + closesAfter - RESAMPLE_MARGIN_S);
          const resampleAt = earliest + Math.floor(random() * (latest - earliest));
          await env.DB.prepare('UPDATE posts SET sampled = 1, resample_at = ? WHERE network = ? AND id = ?').bind(resampleAt, network, id).run();
        } else {
          await env.DB.prepare('UPDATE posts SET sampled = 2 WHERE network = ? AND id = ?').bind(network, id).run();
        }
        tally.sampled++;
        console.log(JSON.stringify({ msg: 'verdict_sampled', network, verdictId: id, sample: sampled + 1, txHash: receipt.hash }));
      } catch (err) {
        tally.failed++;
        console.error(JSON.stringify({ msg: 'sample_failed', network, verdictId: id, error: safeError(err) }));
      }
    }
  }

  const { results } = await env.DB.prepare(`SELECT id, sampled FROM posts WHERE network = ? AND resolved = 0 AND posted_at + ? <= ? ORDER BY posted_at, id LIMIT ?`)
    .bind(network, closesAfter, now, RESOLVE_BATCH).all<{ id: number; sampled: number }>();
  const save = (id: number, adverse: boolean, reasons: number) => env.DB.prepare('UPDATE posts SET resolved = 1, adverse = ?, reasons = ? WHERE network = ? AND id = ?')
    .bind(adverse ? 1 : 0, reasons, network, id).run();
  for (const { id, sampled } of results) {
    if (SAMPLE_WINDOW_S[network] > 0 && sampled === 0) {
      // The grading window passed without our sample (executor out of gas, RPC down): the contract falls back to one
      // reading at resolve time, which can be flattered. Loud, so it gets looked at.
      tally.unsampled++;
      console.error(JSON.stringify({ msg: 'resolve_unsampled', network, verdictId: id }));
    }
    try {
      const onchain = await deps.readResolution(network, BigInt(id));
      if (onchain.resolved) {
        await save(id, onchain.adverse, onchain.reasons);
        tally.synced++;
        continue;
      }
      const receipt = await deps.sender(network).send({
        to: NETWORKS[network].oracle, kind: 'resolve',
        data: encodeFunctionData({ abi: abis.oracle, functionName: 'resolve', args: [BigInt(id)] }),
      });
      if (receipt.status !== 'success') throw new Error(`resolve reverted (${receipt.hash})`);
      const event = parseEventLogs({ abi: abis.oracle, eventName: 'VerdictResolved', logs: receipt.logs as never }).find((e) => e.args.id === BigInt(id));
      if (!event) throw new Error(`no VerdictResolved for ${id} in ${receipt.hash}`);
      await save(id, event.args.adverse, event.args.reasons);
      tally.sent++;
      console.log(JSON.stringify({ msg: 'verdict_resolved', network, verdictId: id, adverse: event.args.adverse, reasons: event.args.reasons, txHash: receipt.hash }));
    } catch (err) {
      tally.failed++;
      console.error(JSON.stringify({ msg: 'resolve_failed', network, verdictId: id, error: safeError(err) }));
    }
  }
  return tally;
}
