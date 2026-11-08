import type { DeskChain } from './desk';

type Address = `0x${string}`;

export interface Deployment {
  /** The desk contract on NEAR; null until it's deployed on this network. */
  desk: string | null;
  /** The agent account whose function-call key the Worker uses. */
  agent: string | null;
  /** Rein oracle per chain; null until it's deployed there. */
  oracles: Partial<Record<DeskChain, Address | null>>;
}

/**
 * Where Rein is deployed. The Worker posts to these oracles, the web defaults to this desk, and the Worker's health
 * check flags any disagreement with its own config or the live desk policy.
 */
export const DEPLOYMENTS: Record<'mainnet' | 'testnet', Deployment> = {
  testnet: {
    desk: 'rein-desk.testnet',
    agent: 'agent.rein-desk.testnet',
    oracles: { 'monad-testnet': null, 'base-sepolia': null },
  },
  mainnet: {
    desk: null,
    agent: null,
    oracles: { monad: null, base: null },
  },
};
