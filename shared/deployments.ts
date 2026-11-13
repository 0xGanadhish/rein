import type { DeskChain } from './desk';

type Address = `0x${string}`;

export interface Deployment {
  /** The desk contract on NEAR; null until it's deployed on this network. */
  desk: string | null;
  /** The Worker's public API for this network; each network runs its own Worker and database. */
  api: string;
  /** The agent account whose function-call key the Worker uses. */
  agent: string | null;
  /** Rein oracle per chain; null until it's deployed there. */
  oracles: Partial<Record<DeskChain, Address | null>>;
  /** Vaults the desk takes orders on, per chain. */
  menu: Partial<Record<DeskChain, Address[]>>;
  /** Guardian per chain; owners arm it on their own vault position. Null until it's deployed there. */
  guardians: Partial<Record<DeskChain, Address | null>>;
  /** USDC per chain: the asset of that chain's menu vaults. */
  usdc: Partial<Record<DeskChain, Address>>;
}

/**
 * Where Rein is deployed. The Worker posts to these oracles, the web defaults to this desk, and the Worker's health
 * check flags any disagreement with its own config or the live desk policy.
 */
export const DEPLOYMENTS: Record<'mainnet' | 'testnet', Deployment> = {
  testnet: {
    desk: 'rein-desk.testnet',
    api: 'https://api-testnet.reinfi.xyz',
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
    guardians: {},
    usdc: {},
  },
  mainnet: {
    desk: 'rein-desk.near',
    api: 'https://api.reinfi.xyz',
    agent: 'agent.rein-desk.near',
    oracles: {
      monad: '0x6Ef1ca2A0c8B918429b78d8E9C8A8fc5F9970F1F',
      base: '0xd535a4068265b383976d92718e3E650b5183b6Ab',
    },
    menu: {
      // Clearstar Earn USDC (Euler Earn) and August USDC V2 (Morpho V2), with Tare's deployed adapters.
      monad: ['0xE1BcA19baA63894D374578320551633320436523', '0x80017bF0f793EBbE9679Cd61ff0e395B62CAbB59'],
      // The 14 Morpho V2 USDC vaults in shared/addresses.base.json (docs/vaults.md).
      base: [
        '0xbeef0786756810478b88982DE00F3CD7fdB8e7c7',
        '0xbeeff2490FEffa212faC2f6553682C219E6a8845',
        '0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9',
        '0x050cE30b927Da55177A4914EC73480238BAD56f0',
        '0xBeEfF0be997Cca5B1c13A7433c2004637975739e',
        '0x91C056B6d4311a743614FBc03ac32d4E6A2d3a3c',
        '0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100',
        '0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765',
        '0x392B3CCf36C8adB8094F45573346B457414cD752',
        '0x0548A36028FFdc7D5aaA7A182f0d1FE0264F5A5C',
        '0x8B12106a70FE2F8bB255F691f1CF9a9ccfB278AF',
        '0x39E18c066187c83e860801Befe45aE8ecd021575',
        '0x1e9e47583f15D45a10Df48c0b1846E0492c795D7',
        '0x618495ccC4e751178C4914b1E939C0fe0FB07b9b',
      ],
    },
    guardians: {
      monad: '0x9BF96419e891A8509C8D49d5ec92AA730eBCC0FF',
      base: '0xe941433777B80eB559BaA2929C5b332e6E49a7d3',
    },
    usdc: {
      monad: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
      base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  },
};
