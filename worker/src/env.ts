import type { DeskChain } from '../../shared/desk';

export type NearNetwork = 'testnet' | 'mainnet';

export interface Env {
  DB: D1Database;
  NEAR_NETWORK: NearNetwork;
  DESK_ACCOUNT: string;
  AGENT_ACCOUNT: string;
  /** ed25519:… secret key of a function-call access key on AGENT_ACCOUNT. */
  AGENT_KEY: string;
  NEAR_AI_API_KEY: string;
  RPC_MONAD: string;
  RPC_MONAD_TESTNET: string;
  RPC_BASE: string;
  /** Sends `sample` and `resolve` to the oracles. Posts are signed by the desk through Chain Signatures. */
  EXECUTOR_KEY: string;
  /** Verifies and settles x402 payments. */
  PINGPAY_API_KEY: string;
  /** yoctoNEAR the agent's function-call key was granted; health flags it once under 20% is left. */
  AGENT_KEY_ALLOWANCE?: string;
}

export const NEAR_RPC: Record<NearNetwork, string> = {
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
};

export function rpcFor(env: Env, chain: DeskChain): string {
  const url = { 'monad-testnet': env.RPC_MONAD_TESTNET, monad: env.RPC_MONAD, base: env.RPC_BASE }[chain];
  if (!url) throw new Error(`no RPC configured for ${chain}`);
  return url;
}
