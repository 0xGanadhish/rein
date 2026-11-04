import { createPublicClient, http, maxUint256, type Address, type PublicClient } from 'viem';
import { abis } from '../../shared/contracts';
import { NETWORKS, UNDEPLOYED, type Network, type VaultConfig } from '../../shared/networks';
import { rpcFor, type Env } from './env';
import type { VaultReading } from './watcher';

/** Withdrawable liquidity as a percent of total assets, two decimals; null when there is no way to read it. */
export function liquidityPct(available: bigint | null, totalAssets: bigint): number | null {
  if (available === null) return null;
  if (totalAssets === 0n) return 100;
  const bps = (available * 10_000n) / totalAssets;
  return Number(bps > 10_000n ? 10_000n : bps) / 100;
}

export type ReadClient = Pick<PublicClient, 'readContract'>;

/**
 * Reads one vault. Share price, total assets and liquidity come from oracle.metricsOf once the oracle is
 * deployed (the same reads the oracle grades with), else from the vault directly. Mirrors report APY and
 * utilization themselves; real vaults take APY from the latest pool scan and derive utilization from
 * adapter liquidity, so the same re-judge thresholds apply.
 */
export async function readVault(
  env: Env, network: Network, vault: VaultConfig,
  opts: { client?: ReadClient; oracle?: Address | null } = {},
): Promise<VaultReading> {
  const client = opts.client ?? createPublicClient({ chain: NETWORKS[network].chain, transport: http(rpcFor(env, network), { retryCount: 2 }) });
  const oracle = opts.oracle !== undefined ? opts.oracle : NETWORKS[network].oracle === UNDEPLOYED ? null : NETWORKS[network].oracle;
  const address = vault.address as Address;
  const isMirror = vault.protocol === 'mirror';

  let pps: bigint, totalAssets: bigint, available: bigint | null;
  if (oracle) {
    const [p, a, liq] = await client.readContract({ address: oracle, abi: abis.oracle, functionName: 'metricsOf', args: [address] });
    [pps, totalAssets, available] = [p, a, liq === maxUint256 ? null : liq]; // max means "no adapter"
  } else {
    const [assets, decimals] = await Promise.all([
      client.readContract({ address, abi: abis.erc4626, functionName: 'totalAssets' }),
      client.readContract({ address, abi: abis.erc4626, functionName: 'decimals' }),
    ]);
    totalAssets = assets;
    pps = await client.readContract({ address, abi: abis.erc4626, functionName: 'convertToAssets', args: [10n ** BigInt(decimals)] });
    available = isMirror
      ? await client.readContract({ address, abi: abis.mirrorVault, functionName: 'availableLiquidity' })
      : vault.adapter
        ? await client.readContract({ address: vault.adapter as Address, abi: abis.liquidityAdapter, functionName: 'availableLiquidity', args: [address] })
        : null;
  }
  const liq = liquidityPct(available, totalAssets);

  if (isMirror) {
    const [apyBps, utilBps] = await Promise.all([
      client.readContract({ address, abi: abis.mirrorVault, functionName: 'apyBps' }),
      client.readContract({ address, abi: abis.mirrorVault, functionName: 'utilizationBps' }),
    ]);
    return { stats: { apyBps, utilBps, liquidityPct: liq }, totalAssets, pps };
  }
  const pool = vault.poolId
    ? await env.DB.prepare(`SELECT json FROM pools WHERE network = 'mainnet' AND id = ?`).bind(vault.poolId).first<{ json: string }>()
    : null;
  const apyBps = pool ? Math.round((JSON.parse(pool.json) as { apy: number }).apy * 100) : 0;
  return { stats: { apyBps, utilBps: liq === null ? 0 : Math.round((100 - liq) * 100), liquidityPct: liq }, totalAssets, pps };
}
