# Rein

A risk desk on a NEAR contract. A customer pays to have a yield vault judged, a NEAR AI TEE model signs its answer, the contract verifies it, and Chain Signatures signs the post to Monad or Base. Verdicts are graded on a public Ledger.

Work in progress for NEAR HACKATHON.

The first commit vendors code reused from [Tare](https://github.com/0xGanadhish/tare) at `b584c863`, unchanged, under MIT. Everything after it is hackathon work.

## Desk invariants

The desk verifies the model's signed answer against an owner-approved prompt and signer. Documents must belong to
the order, be dated between its creation and the current block time, and fit the policy's freshness window.
`fulfil` and `confirm_exit` stop when the order's signing deadline is reached.

The order flow is:

```text
open → exit_pending (EXIT only) → signing → signed → delivered
open / exit_pending → rejected / refunded
signed → post_failed / refunded
```

HOLD and MOVE go directly from `open` to `signing`. A failed MPC request restores the previous state. The first
signing snapshots its oracle address and gas limit; a policy change while MPC is in flight cannot change the
transaction being signed. Re-signing changes only nonce and fees, preserves the reading's expiry and target, and
is refused under the kill switch or after expiry.

Rein's oracle accepts
`post(address,uint8,uint16,uint16,bytes32,uint64 validUntil)`. A `stateHash` can be posted only once
(`StateAlreadyPosted`); a post past `validUntil` fails with `PostExpired`. The expiry is fixed by the desk for
the signed reading, not chosen by the agent.

### Delivery, refunds and liabilities

- Escrow stays in the desk while an order is `signed`. The 70/30 treasury/agent split happens only on
  `report_delivery(order_id, tx_hash, gas_wei)`. Delivery and its actual receipt fee are recorded atomically;
  a second report is refused and cannot count gas or pay the split twice.
- `fail_post(order_id, tx_hash, gas_wei, reason)` is agent-only and accepts only `signed` orders. It makes
  `post_failed` final, removes the stored signed transaction, frees the vault and authorizes a full refund.
- Anyone can refund an open order after its deadline, or immediately under the kill switch. A signed order
  can be refunded only when `now > valid_until + deadline_s`; the kill switch does not shorten that grace.
  Signing and finished orders cannot be refunded, and `reject` cannot close a signed order.
- Failed order-refund and split transfers remain liabilities: `stats.owed` is USDC and `stats.owed_near` is yoctoNEAR.
  Outstanding transfers remain counted until their callbacks succeed. `claim_owed(account)` retries both
  currencies owed to that account. Changing the USDC token is refused while paid orders are open or USDC is owed.
- Gas reports use the fee actually paid, including any L1 fee, rather than treating the transaction's gas limit
  as its cost on every chain.

**Trust and recovery limits:** the desk trusts the agent's delivery/failure reports and fee amounts; it does not
verify EVM receipt proofs. If a post lands but delivery is not reported before expiry plus grace, the customer
could receive both the post and a refund through the desk's public refund path. Worker recovery cannot prevent
that during an extended outage, and relies on RPC receipt/state visibility rather than receipt proofs.

### Worker recovery

- Deploy a desk exposing `next_order_id()` and apply `worker/migrations/0003_journal.sql` before running this
  Worker version. The migration adds broadcast intent and pending-nonce ownership; it is not applied by startup.
- Every signed attempt is journaled before broadcast. Recovery checks earlier attempts' receipts before
  replacing a nonce or failing a post, and includes L1 fees in the reported receipt cost.
- A reverted post fails through `fail_post`. An expired post with no receipt waits **30 seconds** past
  `valid_until`, then rechecks its receipt and the signed transaction's oracle `statePosted` mapping before failure.
  No new broadcast or re-sign is attempted after the Worker's clock crosses expiry.
- A positively observed posted state is retained durably. If the successful receipt is not yet available,
  the Worker alerts and leaves the order pending rather than refunding a customer who received the post.
  Lost settlement responses are resolved by reading the desk's final status; gas and split settlement occur once.
- EXIT confirmation uses the desk policy's minimum/maximum window. Missing or too-early first readings do not
  trigger a paid model call; lapsed readings resume through the desk's open-order view.
- Per-network/chain cursors rotate bounded scans independently of waiting orders. Pruned gaps are crossed using
  `next_order_id`; unverified gaps remain revisitable. Chain leases renew every third of their TTL during work.
  Each runner merges chain-filtered `open_orders(20)` with its scan, deduplicating orders and prioritizing selected
  active work. A full runner reserves nine slots for scan progress and one for the fast path; spare capacity is shared.
- Mirroring repairs at most 50 late-document post links per chain per pass, preserving existing grading.
- NEAR mutations rebuild only after an explicit `InvalidNonce` rejection, at most five attempts. Mutation
  transport retries are disabled, so an ambiguous lost response is not silently replayed as a new transaction.

### Chains

| NEAR desk network | EVM chain | Chain ID | Default post gas limit |
|---|---|---:|---:|
| Testnet | Monad testnet | 10143 | 400,000 |
| Testnet | Base Sepolia | 84532 | 400,000 |
| Mainnet | Monad | 143 | 1,000,000 |
| Mainnet | Base | 8453 | 1,000,000 |

Both testnets use their own mock USDC and mirror vaults, a one-hour resolution window and no sampling.
Base Sepolia uses the same fee cap as Base. Worker RPC settings include `RPC_BASE_SEPOLIA`; oracle addresses
must be configured after deployment. Adding chain support does not deploy or fund anything.

## Local verification

Build release wasm in each of `near/desk`, `near/mocks/ft` and
`near/mocks/signer` with `cargo near build non-reproducible-wasm`, then run:

```sh
# From near/
cargo test -p desk -- --test-threads=2

# From the repository root
node --experimental-strip-types scripts/desk-vectors.ts
pnpm -C worker test --maxWorkers=2
pnpm -C worker typecheck

# From evm/
forge test --threads 2
forge test --match-contract Fork --fork-url https://mainnet.base.org --threads 2
```

The vectors compare calldata, unsigned and signed EIP-1559 transactions, and signing hashes against viem on
all four chains. Fork checks depend on live vault state, including deposit caps and available liquidity.
The desk's optimized wasm limit is **300,000 bytes**:

```sh
# From near/; output is temporary and not committed
wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
  target/near/desk/desk.wasm -o /tmp/rein-desk.wasm
wc -c /tmp/rein-desk.wasm
```
