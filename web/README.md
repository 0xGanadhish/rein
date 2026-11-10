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

## MOVE and cross-chain top-up

Both flows request a deposit address only after **Get deposit address** is clicked. They never sign,
send, or approve funds. Send the quoted amount on the selected origin chain yourself before the displayed
expiry. Editing the quote inputs discards the displayed address.

Guardian serves Base mainnet. MOVE appears when the connected owner's on-chain rule remains enabled
and their vault shares are zero, including after a reload and reconnect. The amount is the owner's **current Base USDC balance**, not an exact exit receipt; it can
include other funds. Base and Monad are the supported MOVE destinations. Partial exits with remaining
shares do not show MOVE.

The Judge page offers mainnet top-up for the connected NEAR account, with USDC origins on Base, Monad,
Ethereum, Arbitrum, and Solana. Amounts support up to six decimals without rounding. After showing the
deposit address and expiry, it explains that the user must wait for USDC to arrive on NEAR and then
separately pay the desk with `ft_transfer_call`. Top-up is not an order payment. Sample data disables
quotes, and testnet pages explain that top-up uses mainnet funds only.

The browser calls the selected network's Worker `/v1/quote` directly (it allows any origin and carries no
credentials), so the Worker's per-IP rate limit applies to each visitor. Asset IDs are pinned in
`lib/oneclick.ts` from the public 1Click token catalog; no testnet IDs are substituted.

### Worker quote contract

`POST /v1/quote` takes `originAsset` and a positive integer `amount` in the origin asset's smallest units.
Without `destinationAsset`, the existing body is unchanged: `recipientNear` must be a NEAR account,
the destination is native USDC on NEAR, and failed swaps refund to that account with `refundType: INTENTS`.

With `destinationAsset`, `recipient` and `refundTo` must be non-empty strings; `recipientNear` is not
required. The request passes the caller's asset and addresses to 1Click with `depositType: ORIGIN_CHAIN`,
`recipientType: DESTINATION_CHAIN`, and `refundType: ORIGIN_CHAIN`. Missing or invalid destination fields
return HTTP 400 JSON `{ "error": "<field> required" }` before contacting 1Click. Both paths retain
`EXACT_INPUT`, 100 bps slippage, and the one-hour quote deadline.

### Component tests

The MOVE and top-up tests render the components in happy-dom with a stubbed `fetch`; they need no browser,
server or network.
