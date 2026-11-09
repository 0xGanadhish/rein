import type { DeskChain } from './desk';

type Address = `0x${string}`;

export interface Deployment {
  /** The desk contract on NEAR; null until it's deployed on this network. */
  desk: string | null;
  /** The agent account whose function-call key the Worker uses. */
  agent: string | null;
  /** Rein oracle per chain; null until it's deployed there. */
  oracles: Partial<Record<DeskChain, Address | null>>;
  /** Vaults the desk takes orders on, per chain. */
  menu: Partial<Record<DeskChain, Address[]>>;
}

/**
 * Where Rein is deployed. The Worker posts to these oracles, the web defaults to this desk, and the Worker's health
 * check flags any disagreement with its own config or the live desk policy.
 */
export const DEPLOYMENTS: Record<'mainnet' | 'testnet', Deployment> = {
  testnet: {
    desk: 'rein-desk.testnet',
    agent: 'agent.rein-desk.testnet',
    oracles: {
      'monad-testnet': '0x16b998475d3c2b7FB5b794406701167039fD841A',
      'base-sepolia': '0xd535a4068265b383976d92718e3E650b5183b6Ab',
    },
    menu: {
      // Rein's mirror vaults on mock USDC: rmSTEAK, rmCSCB, rmSIRLOIN.
      'monad-testnet': [
        '0xA32cF682DA4A62c056fD631eE91dfE3C713EF1DB',
        '0x4a03c331a2fFFB7Df05609749319940247ea3843',
        '0xA05df79d9fb5195C621Bc655fE345d6166fb2E07',
      ],
      'base-sepolia': [
        '0x7B1D9003983c0B55B8b15aA37e7E188Ce6AabdC8',
        '0x0B673bFAC6383bFd6E31170d94d5A9D4F8cf5c44',
        '0x9a410Af861d07545A1E7a53aCF86e570A6F32FA8',
      ],
    },
  },
  mainnet: {
    desk: 'rein-desk.near',
    agent: 'agent.rein-desk.near',
    oracles: { monad: null, base: null },
    menu: {
      // Clearstar Earn USDC (Euler Earn) and August USDC V2 (Morpho V2), with Tare's deployed adapters.
      monad: ['0xE1BcA19baA63894D374578320551633320436523', '0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59'],
      base: [],
    },
  },
};
