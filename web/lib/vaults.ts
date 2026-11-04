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
