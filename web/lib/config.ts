import { DEPLOYMENTS } from '../../shared/deployments';
import type { Network } from './ledger';

/** What the browser needs to know about this deployment. Read on the server, passed down as props. */
export interface PublicConfig {
  network: Network;
  /** The desk contract on NEAR; null until it's deployed on this network. */
  desk: string | null;
  /** GuardianV2 on Base; null until it's deployed. */
  guardian: `0x${string}` | null;
  /** Base RPC the browser reads Guardian and vault state from. */
  baseRpc: string;
  /** Sample data from fixtures/ instead of the desk and the Worker. */
  sample: boolean;
  /** The Worker, for agents' x402 requests. */
  api: string | null;
  /** Rein's exit worker is running against the deployed Guardian, so an EXIT is acted on without the owner. */
  exitWorker: boolean;
}

const DEFAULT_DESK: Record<Network, string | null> = {
  testnet: DEPLOYMENTS.testnet.desk,
  mainnet: DEPLOYMENTS.mainnet.desk,
};

export function publicConfig(): PublicConfig {
  const sample = process.env.DATA_SOURCE === 'fixtures';
  // Sample data shows mainnet (Base and Monad) unless NEAR_NETWORK says otherwise; a live app defaults to testnet, like the Worker.
  const network: Network =
    process.env.NEAR_NETWORK === 'mainnet' || process.env.NEAR_NETWORK === 'testnet'
      ? process.env.NEAR_NETWORK
      : sample
        ? 'mainnet'
        : 'testnet';
  const guardian = process.env.GUARDIAN_BASE;
  return {
    network,
    desk: process.env.DESK_ACCOUNT || DEFAULT_DESK[network],
    guardian: guardian && /^0x[0-9a-fA-F]{40}$/.test(guardian) ? (guardian as `0x${string}`) : null,
    baseRpc: process.env.BASE_RPC || 'https://mainnet.base.org',
    sample,
    api: process.env.REIN_API_URL || null,
    exitWorker: process.env.EXIT_WORKER_LIVE === 'true',
  };
}
