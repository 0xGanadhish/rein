import { createPublicClient, http, maxUint256, type Address, type PublicClient } from 'viem';
import type { DeskChain } from '../../../shared/desk';
import { erc4626Abi, liquidityAdapterAbi, mirrorVaultAbi, oracleAbi } from '../abis';
import { CHAINS, ORACLES } from '../broadcast';
import { rpcFor, type Env } from '../env';

/** Withdrawable liquidity as a percent of total assets, two decimals; null when there is no way to read it. */
export function liquidityPct(available: bigint | null, totalAssets: bigint): number | null {
  if (available === null) return null;
  if (totalAssets === 0n) return 100;
  const bps = (available * 10_000n) / totalAssets;
  return Number(bps > 10_000n ? 10_000n : bps) / 100;
}

export type ReadClient = Pick<PublicClient, 'readContract' | 'getBlockNumber'>;

export interface VaultConfig {
  address: string;
  /** A MirrorVault (evm/src/MirrorVault.sol), which reports its own APY and utilization. */
  mirror: boolean;
  /** Liquidity adapter, read when there is no oracle. */
  adapter?: string | null;
}

export interface VaultStats {
  pps: bigint;
  totalAssets: bigint;
  liquidityPct: number | null;
  /** Null when the vault has no APY source. */
  apyBps: number | null;
  utilBps: number;
}

/**
 * Reads one vault. Share price, total assets and liquidity come from oracle.metricsOf once the oracle is deployed
 * (the same reads the oracle grades with), else from the vault directly. Mirrors report APY and utilization
 * themselves; other vaults derive utilization from adapter liquidity and have no APY source yet.
 */
export async function readVault(
  env: Env, chain: DeskChain, vault: VaultConfig,
  opts: { client?: ReadClient; oracle?: Address | null; blockNumber?: bigint } = {},
): Promise<VaultStats> {
  const client = opts.client ?? createPublicClient({ chain: CHAINS[chain], transport: http(rpcFor(env, chain), { retryCount: 2 }) });
  const blockNumber = opts.blockNumber ?? await client.getBlockNumber();
  const oracle = opts.oracle !== undefined ? opts.oracle : ORACLES[chain];
  const address = vault.address as Address;

  let pps: bigint, totalAssets: bigint, available: bigint | null;
  if (oracle) {
    const [p, a, liq] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'metricsOf', args: [address], blockNumber });
    [pps, totalAssets, available] = [p, a, liq === maxUint256 ? null : liq]; // max means "no adapter"
  } else {
    const [assets, decimals] = await Promise.all([
      client.readContract({ address, abi: erc4626Abi, functionName: 'totalAssets', blockNumber }),
      client.readContract({ address, abi: erc4626Abi, functionName: 'decimals', blockNumber }),
    ]);
    totalAssets = assets;
    pps = await client.readContract({ address, abi: erc4626Abi, functionName: 'convertToAssets', args: [10n ** BigInt(decimals)], blockNumber });
    available = vault.mirror
      ? await client.readContract({ address, abi: mirrorVaultAbi, functionName: 'availableLiquidity', blockNumber })
      : vault.adapter
        ? await client.readContract({ address: vault.adapter as Address, abi: liquidityAdapterAbi, functionName: 'availableLiquidity', args: [address], blockNumber })
        : null;
  }
  const liq = liquidityPct(available, totalAssets);

  if (vault.mirror) {
    const [apyBps, utilBps] = await Promise.all([
      client.readContract({ address, abi: mirrorVaultAbi, functionName: 'apyBps', blockNumber }),
      client.readContract({ address, abi: mirrorVaultAbi, functionName: 'utilizationBps', blockNumber }),
    ]);
    return { pps, totalAssets, liquidityPct: liq, apyBps, utilBps };
  }
  return { pps, totalAssets, liquidityPct: liq, apyBps: null, utilBps: liq === null ? 0 : Math.round((100 - liq) * 100) };
}
