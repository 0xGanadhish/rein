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
| `DESK_ACCOUNT`         | The desk contract. Defaults to `desk.rein.testnet` on testnet.                                                 |
| `GUARDIAN_BASE`        | GuardianV2 on Base. Without it, Guardian shows the rule but can't arm.                                         |
| `BASE_RPC`             | Base RPC for the browser's Guardian reads. Defaults to `https://mainnet.base.org`.                             |

NEAR wallets connect through NEAR Connect. Guardian uses the browser's injected EVM wallet on Base.
