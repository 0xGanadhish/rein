# Base vaults

Which USDC vaults on Base (chain 8453) Rein can grade, and why.

## Method

1. Candidates: every pool in `https://yields.llama.fi/pools` with `chain = Base`, a single underlying token equal to
   Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`), project `euler-v2` or `morpho-blue`, and
   `tvlUsd >= 1,000,000`. Vault addresses come from `https://yields.llama.fi/poolsEnriched?pool=<id>` (`url`, `pool_old`).
2. Every candidate was then checked with read calls against `https://mainnet.base.org` at block ~53,498,800
   (2026-11-04 10:15 UTC):
   - `asset()` returns Base USDC.
   - Type: `isVaultV2(vault)` on the Morpho `VaultV2Factory` (`0x4501125508079A99ebBebCE205DeC9593C2b5857`), and
     `isMetaMorpho(vault)` on both MetaMorpho factories (`0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101`,
     `0xFf62A7c278C62eD665133147129245053Bbf5918`).
   - TVL: `totalAssets()`, in USDC.
   - Adapter read: `evm/src/adapters/MorphoV2Adapter.sol`'s `availableLiquidity(vault)`, run as an `eth_call` with the
     compiled adapter code overridden at a scratch address. Withdrawable % is that read over `totalAssets()`.

## Rules

1. Asset is USDC.
2. Type is Euler Earn or Morpho Vault V2.
3. TVL of at least $1M.
4. Guardian fully exits 1,000 USDC on a fork. Not tested yet, so no vault is marked as passing all five: vaults that
   pass the other four are marked `pending (Guardian)`.
5. The adapter reads above 0 and at most TVL.

## Result

No Euler Earn vault qualifies: Euler's only Base USDC pools in the feed are EVK vaults (not Euler Earn), the largest at
$402k (`eUSDC-91`), so none reaches $1M.

24 Morpho candidates: 8 are MetaMorpho (Vault V1) and fail rule 2. Of the 16 Vault V2s, 14 pass rules 1, 2, 3 and 5;
2 fail rule 5. The 14 are listed in `shared/addresses.base.json` and covered by `evm/test/ForkBase.t.sol`.

| name | address | type | TVL | withdrawable % | passes 5 rules | reason |
|---|---|---|---|---|---|---|
| Grove x Steakhouse USDC | `0xbeef0786756810478b88982DE00F3CD7fdB8e7c7` | Morpho Vault V2 | $541,829,876 | 33.3% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Spark USDC Vault | `0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A` | MetaMorpho (Vault V1) | $495,251,564 | n/a | no | Vault V1, not V2 (rule 2) |
| Steakhouse High Yield USDC Edition | `0xbeeff2490FEffa212faC2f6553682C219E6a8845` | Morpho Vault V2 | $457,959,928 | 10.1% | pending (Guardian) | Rules 1, 2, 3, 5 pass. Read is capped by the cash of a liquidity market shared with Ethena x Steakhouse USDC |
| Gauntlet USDC Prime | `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` | MetaMorpho (Vault V1) | $401,805,955 | n/a | no | Vault V1, not V2 (rule 2) |
| Steakhouse Prime USDC | `0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9` | Morpho Vault V2 | $150,030,992 | 90.9% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Steakhouse USDC | `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` | MetaMorpho (Vault V1) | $111,440,717 | n/a | no | Vault V1, not V2 (rule 2) |
| Gauntlet USDC Prime | `0x050cE30b927Da55177A4914EC73480238BAD56f0` | Morpho Vault V2 | $99,282,116 | 92.5% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Ethena x Steakhouse USDC | `0xBeEfF0be997Cca5B1c13A7433c2004637975739e` | Morpho Vault V2 | $50,853,191 | 91.4% | pending (Guardian) | Rules 1, 2, 3, 5 pass. Read is capped by the cash of a liquidity market shared with Steakhouse High Yield USDC Edition |
| Clearstar cbAssets Vault | `0x91C056B6d4311a743614FBc03ac32d4E6A2d3a3c` | Morpho Vault V2 | $32,567,833 | 19.9% | pending (Guardian) | Rules 1, 2, 3, 5 pass. Read is capped by the cash of a liquidity market shared with Steakhouse High Yield USDC |
| Steakhouse High Yield USDC | `0xbeeff7aE5E00Aae3Db302e4B0d8C883810a58100` | Morpho Vault V2 | $28,278,989 | 23.0% | pending (Guardian) | Rules 1, 2, 3, 5 pass. Read is capped by the cash of a liquidity market shared with Clearstar cbAssets Vault |
| Steakhouse Prime USDC | `0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2` | MetaMorpho (Vault V1) | $11,800,501 | n/a | no | Vault V1, not V2 (rule 2) |
| Pangolins USDC | `0x1401d1271C47648AC70cBcdfA3776D4A87CE006B` | MetaMorpho (Vault V1) | $7,312,385 | n/a | no | Vault V1, not V2 (rule 2) |
| Gauntlet USDC Frontier | `0x1deEfABEe758AAbdC29a542B24ca3b75aFD56765` | Morpho Vault V2 | $4,776,922 | 20.4% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| KPK USDC Yield | `0x392B3CCf36C8adB8094F45573346B457414cD752` | Morpho Vault V2 | $4,571,975 | 19.4% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| К3 cbMaxxxing USDC | `0x0548A36028FFdc7D5aaA7A182f0d1FE0264F5A5C` | Morpho Vault V2 | $3,855,237 | 50.9% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Noon Ecosystem Vault | `0x8B12106a70FE2F8bB255F691f1CF9a9ccfB278AF` | Morpho Vault V2 | $3,627,788 | 10.2% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| SoSoValue x Unified Labs USDC | `0xb88A0269C0b7E665F15DE46F634e02cE81E361c9` | Morpho Vault V2 | $3,463,108 | 100.0% | no | Adapter reads 3463108465861 > totalAssets 3463108455260 (by 0.010601 USDC; the vault books interest more slowly than its liquidity market) (rule 5) |
| Moonwell Flagship USDC | `0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca` | MetaMorpho (Vault V1) | $2,513,977 | n/a | no | Vault V1, not V2 (rule 2) |
| Bitso USDC Prime | `0x39E18c066187c83e860801Befe45aE8ecd021575` | Morpho Vault V2 | $2,166,714 | 52.0% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Galaxy USDC Quality | `0x1e9e47583f15D45a10Df48c0b1846E0492c795D7` | Morpho Vault V2 | $2,033,927 | 100.0% | pending (Guardian) | Rules 1, 2, 3, 5 pass |
| Yearn OG USDC | `0xef417a2512C5a41f69AE4e021648b69a7CdE5D03` | MetaMorpho (Vault V1) | $2,030,250 | n/a | no | Vault V1, not V2 (rule 2) |
| Gauntlet USDC Core | `0xc0c5689e6f4D256E861F65465b691aeEcC0dEb12` | MetaMorpho (Vault V1) | $1,957,817 | n/a | no | Vault V1, not V2 (rule 2) |
| ARCHITECT Global Value | `0x8effa741061aaA2d8A5012a9B09A2d31d8B628d7` | Morpho Vault V2 | $1,263,025 | 0.0% | no | Liquidity adapter is a Morpho Vault V1 adapter (supplies to `0xBEEFE94c8aD530842bfE7d8B397938fFc1cb83b2`); `MorphoV2Adapter` reads 0 (rule 5) |
| Re7 USDC | `0x618495ccC4e751178C4914b1E939C0fe0FB07b9b` | Morpho Vault V2 | $1,249,714 | 100.0% | pending (Guardian) | Rules 1, 2, 3, 5 pass |

## Notes

- Values move: TVL and withdrawable % are one reading. `ForkBase.t.sol` re-checks rules 3 and 5 against the live chain.
- The Morpho V2 adapter counts idle USDC plus what the vault's `liquidityAdapter` can pull from its Morpho Blue market,
  capped by that market's cash. Vaults that share a liquidity market report the same cash, so their withdrawable %
  is not additive.
- ARCHITECT Global Value routes withdrawals through a Morpho Vault V1 (`MorphoVaultV1Adapter`). No adapter in
  `evm/src/adapters` reads that path; grading it would need a new adapter.
