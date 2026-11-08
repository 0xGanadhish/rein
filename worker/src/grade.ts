import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DeskChain } from '../../shared/desk';
import { oracleAbi } from './abis';
import { CHAINS, ORACLES } from './broadcast';
import { NETWORK_CHAINS } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';
import { resolveDue, type ResolverDeps } from './vendor/resolve';

export interface GradeDeps {
  /** Null while the chain has no oracle. */
  resolver(chain: DeskChain): ResolverDeps | null;
}

export function realGradeDeps(env: Env): GradeDeps {
  return {
    resolver(chain) {
      const oracle = ORACLES[chain];
      if (!oracle) return null;
      const transport = http(rpcFor(env, chain), { retryCount: 2 });
      const client = createPublicClient({ chain: CHAINS[chain], transport });
      const wallet = createWalletClient({ chain: CHAINS[chain], transport, account: privateKeyToAccount(env.EXECUTOR_KEY as Hex) });
      return {
        oracle,
        async readResolution(id) {
          const r = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'getResolution', args: [id] });
          return { resolved: r.resolved, adverse: r.adverse, reasons: r.reasons, resolvedAt: Number(r.resolvedAt) };
        },
        sender: {
          async send({ to, data, kind, verdictId }) {
            const hash = await wallet.sendTransaction({ to, data });
            const r = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
            await env.DB.prepare('INSERT OR IGNORE INTO executor_fees (chain, hash, kind, gas_wei, verdict_id) VALUES (?, ?, ?, ?, ?)')
              .bind(chain, hash, kind, String(r.gasUsed * r.effectiveGasPrice + ('l1Fee' in r ? BigInt(r.l1Fee ?? 0) : 0n)), verdictId).run();
            const block = await client.getBlock({ blockHash: r.blockHash });
            return { status: r.status, hash, logs: r.logs, resolvedAt: Number(block.timestamp) };
          },
        },
      };
    },
  };
}

/** Samples and resolves every due post on the network's chains, with Rein's oracle on each. */
export async function gradeDue(env: Env, network: NearNetwork, now: number, deps: GradeDeps): Promise<Partial<Record<DeskChain, Awaited<ReturnType<typeof resolveDue>>>>> {
  const out: Partial<Record<DeskChain, Awaited<ReturnType<typeof resolveDue>>>> = {};
  for (const chain of NETWORK_CHAINS[network]) {
    const resolver = deps.resolver(chain);
    if (resolver) out[chain] = await resolveDue(env, chain, now, resolver);
  }
  return out;
}
