# Rein web

The Rein site and app: landing page, public Ledger, Judge a vault, My orders with signed receipts, and Guardian.

```bash
DATA_SOURCE=fixtures pnpm -C web dev
```

| Variable               | What it does                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DATA_SOURCE=fixtures` | Read `fixtures/` instead of the desk and the Worker. Pages say "Sample data", and payments and arming are off. |
| `REIN_API_URL`         | The Worker's base URL, for `/v1/ledger` and `/v1/orders`.                                                      |
| `NEAR_NETWORK`         | `testnet` or `mainnet`. Defaults to `testnet`, or `mainnet` with fixtures.                                     |
| `DESK_ACCOUNT`         | The desk contract. Defaults to `rein-desk.testnet` on testnet.                                                 |
| `GUARDIAN_BASE`        | GuardianV2 on Base. Without it, Guardian shows the rule but can't arm.                                         |
| `BASE_RPC`             | Base RPC for the browser's Guardian reads. Defaults to `https://mainnet.base.org`.                             |

NEAR wallets connect through NEAR Connect. Guardian uses the browser's injected EVM wallet on Base.

## Vault names and balances

Judge names the Base and Monad menu vaults, and labels the Monad testnet and Base Sepolia mirrors with
`(mirror)` and a `Testnet mirror` badge. TVL snapshots are Base-only; other mainnet vaults retain an unknown TVL.

The Ledger's margin before gas keeps all six USDC decimals when needed. A margin of `-37` micros appears
as `-0.000037 USDC`; zero appears as `0 USDC`.

## Receipt verification

Each receipt has a numbered **Verify this order** chain: the NEAR desk, the exact stored reading document,
the latest model signer, the Chain Signatures transaction and its desk-derived signer address, and the grade
once resolved. Before readings or a transaction exist, only the available steps appear.

The document check compares Keccak-256 of its UTF-8 bytes against the stored state hash. The signer check
compares against the desk's current `signers()` list, case-insensitively; an unavailable list is not a match.
These checks do not verify the model signature or TEE attestation, nor prove historical signer membership
or that the judgement is correct. Explorer links remain available for independent inspection.
