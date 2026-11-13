import { cookies } from 'next/headers';
import { DEPLOYMENTS } from '../../shared/deployments';
import type { GuardianChain } from '../../shared/guardianTx';
import { isNetwork, type Network } from './ledger';

/** What the browser needs to know about this deployment. Read on the server, passed down as props. */
export interface PublicConfig {
  network: Network;
  /** The desk contract on NEAR; null until it's deployed on this network. */
  desk: string | null;
  /** GuardianV2 per chain, from GUARDIAN_BASE and GUARDIAN_MONAD; null when unset or not an address. */
  guardians: Record<GuardianChain, `0x${string}` | null>;
  /** RPC per chain the browser reads Guardian and vault state from. */
  rpcs: Record<GuardianChain, string>;
  /** Sample data from fixtures/ instead of the desk and the Worker. */
  sample: boolean;
  /** This network's Worker: the Ledger, receipts, orders and agents' x402 requests. */
  api: string | null;
  /** Rein's exit worker is running against the deployed Guardian, so an EXIT is acted on without the owner. */
  exitWorker: boolean;
}

/** The cookie the header's network switch sets. */
export const NETWORK_COOKIE = 'rein-network';

/** The network a visitor sees before choosing one: NEAR_NETWORK, else mainnet for sample data and testnet live. */
export function defaultNetwork(env: NodeJS.ProcessEnv = process.env): Network {
  if (isNetwork(env.NEAR_NETWORK)) return env.NEAR_NETWORK;
  return env.DATA_SOURCE === 'fixtures' ? 'mainnet' : 'testnet';
}

/**
 * The settings for one network. Each network has its own desk and its own Worker, from shared/deployments.ts;
 * DESK_ACCOUNT_<NETWORK> and REIN_API_URL_<NETWORK> override them.
 */
export function configFor(network: Network, env: NodeJS.ProcessEnv = process.env): PublicConfig {
  const NET = network.toUpperCase();
  const address = (v: string | undefined) => (v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null);
  return {
    network,
    desk: env[`DESK_ACCOUNT_${NET}`] || DEPLOYMENTS[network].desk,
    guardians: { base: address(env.GUARDIAN_BASE), monad: address(env.GUARDIAN_MONAD) },
    rpcs: { base: env.BASE_RPC || 'https://mainnet.base.org', monad: env.MONAD_RPC || 'https://rpc.monad.xyz' },
    sample: env.DATA_SOURCE === 'fixtures',
    api: env[`REIN_API_URL_${NET}`] || DEPLOYMENTS[network].api || null,
    exitWorker: env.EXIT_WORKER_LIVE === 'true',
  };
}

/** This request's settings: the network from the switch's cookie, else the default. */
export async function publicConfig(): Promise<PublicConfig> {
  const chosen = (await cookies()).get(NETWORK_COOKIE)?.value;
  return configFor(isNetwork(chosen) ? chosen : defaultNetwork());
}
