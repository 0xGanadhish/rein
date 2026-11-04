/** Display names of the Base vaults on the menu (shared/addresses.base.json, docs/vaults.md), by lowercase address. */
const BASE: Record<string, string> = {
  '0xbeef0786756810478b88982de00f3cd7fdb8e7c7': 'Grove x Steakhouse USDC',
  '0xbeeff2490feffa212fac2f6553682c219e6a8845': 'Steakhouse High Yield USDC Edition',
  '0xbeef0e0834849acc03f0089f01f4f1eeb06873c9': 'Steakhouse Prime USDC',
  '0x050ce30b927da55177a4914ec73480238bad56f0': 'Gauntlet USDC Prime',
  '0xbeeff0be997cca5b1c13a7433c2004637975739e': 'Ethena x Steakhouse USDC',
  '0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c': 'Clearstar cbAssets Vault',
  '0xbeeff7ae5e00aae3db302e4b0d8c883810a58100': 'Steakhouse High Yield USDC',
  '0x1deefabee758aabdc29a542b24ca3b75afd56765': 'Gauntlet USDC Frontier',
  '0x392b3ccf36c8adb8094f45573346b457414cd752': 'KPK USDC Yield',
  '0x0548a36028ffdc7d5aaa7a182f0d1fe0264f5a5c': 'K3 cbMaxxxing USDC',
  '0x8b12106a70fe2f8bb255f691f1cf9a9ccfb278af': 'Noon Ecosystem Vault',
  '0x39e18c066187c83e860801befe45ae8ecd021575': 'Bitso USDC Prime',
  '0x1e9e47583f15d45a10df48c0b1846e0492c795d7': 'Galaxy USDC Quality',
  '0x618495ccc4e751178c4914b1e939c0fe0fb07b9b': 'Re7 USDC',
};

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** A vault's name when it's on the Base menu, else its short address. */
export function vaultName(chain: string, vault: string): string {
  return (chain === 'base' && BASE[vault.toLowerCase()]) || shortAddress(vault);
}

/** TVL and withdrawable share of each Base menu vault, read at Base block ~53,498,800 (docs/vaults.md). */
export const SNAPSHOT_BLOCK = '53,498,800';
export const SNAPSHOT: Record<string, { tvlUsd: number; withdrawablePct: number }> = {
  '0xbeef0786756810478b88982de00f3cd7fdb8e7c7': { tvlUsd: 541_829_876, withdrawablePct: 33.3 },
  '0xbeeff2490feffa212fac2f6553682c219e6a8845': { tvlUsd: 457_959_928, withdrawablePct: 10.1 },
  '0xbeef0e0834849acc03f0089f01f4f1eeb06873c9': { tvlUsd: 150_030_992, withdrawablePct: 90.9 },
  '0x050ce30b927da55177a4914ec73480238bad56f0': { tvlUsd: 99_282_116, withdrawablePct: 92.5 },
  '0xbeeff0be997cca5b1c13a7433c2004637975739e': { tvlUsd: 50_853_191, withdrawablePct: 91.4 },
  '0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c': { tvlUsd: 32_567_833, withdrawablePct: 19.9 },
  '0xbeeff7ae5e00aae3db302e4b0d8c883810a58100': { tvlUsd: 28_278_989, withdrawablePct: 23.0 },
  '0x1deefabee758aabdc29a542b24ca3b75afd56765': { tvlUsd: 4_776_922, withdrawablePct: 20.4 },
  '0x392b3ccf36c8adb8094f45573346b457414cd752': { tvlUsd: 4_571_975, withdrawablePct: 19.4 },
  '0x0548a36028ffdc7d5aaa7a182f0d1fe0264f5a5c': { tvlUsd: 3_855_237, withdrawablePct: 50.9 },
  '0x8b12106a70fe2f8bb255f691f1cf9a9ccfb278af': { tvlUsd: 3_627_788, withdrawablePct: 10.2 },
  '0x39e18c066187c83e860801befe45ae8ecd021575': { tvlUsd: 2_166_714, withdrawablePct: 52.0 },
  '0x1e9e47583f15d45a10df48c0b1846e0492c795d7': { tvlUsd: 2_033_927, withdrawablePct: 100.0 },
  '0x618495ccc4e751178c4914b1e939c0fe0fb07b9b': { tvlUsd: 1_249_714, withdrawablePct: 100.0 },
};

/** The Base menu as of that read, for when the desk's own menu can't be read. */
export const BASE_MENU = Object.keys(SNAPSHOT);

export function usdShort(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
