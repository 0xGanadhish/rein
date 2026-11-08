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
  replacing a nonce or failing a post. Settlement sums all observed mined attempts, including reverted
  replacements and L1 fees, once per transaction hash.
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

### Ledger, inputs and operational health

Apply migrations through `worker/migrations/0004_ledger_health.sql` before deploying this Worker.
Startup does not apply migrations. The schema adds call outcomes/token usage, receipt fees, grading times,
quote limits and persistent incidents. A subsequent migration must use the next free number.

**Model cost:** NEAR AI's public [models endpoint](https://cloud-api.near.ai/v1/models) lists
`z-ai/glm-5.3-flash` at **$0.08 per million input tokens** and **$0.50 per million output tokens**.
A 244-input/34-output-token completion is about $0.00003652, rounded to 37 USD micros in the call journal.
Signature failures and desk-refused answers retain the completion's token cost and failing stage.
Account credits and cash charges are not reported by token usage: unknown credits/cash cost remain `null`,
not zero. Calls with missing usage are counted explicitly; the known-cost subtotal is not a complete bill.

`GET /v1/stats` and `/v1/ledger.business` retain their existing fields and add:

- `settled_revenue`: NEAR/USDC split totals from the desk, credited only at delivery; this is earned revenue,
  not proof that payout transfers succeeded. `x402_usdc` is zero until a settlement journal exists.
- `opened_orders`: mirrored count/amounts and authoritative gross accepted escrow in `desk_gross`.
- `refunds`: authorized order count and mirrored refund amounts, separate from `paid_amounts: null`.
  The desk exposes aggregate owed balances, not a refund-versus-split payout breakdown.
- `unpaid_liabilities`: USDC and yoctoNEAR still owed, including in-flight and failed transfers.
- `gas_per_chain`: `desk_wei`, journal `observed_wei`, `executor_wei`, `reverted_wei`, `cost_wei`,
  and `cost_is_lower_bound`. Post fees overlap desk totals, so their maximum, not their sum, is used;
  executor sample/resolve fees are added separately. Historic/unobserved receipts can make this a lower bound.
- `inference`: `underlying_cost_usd_micros`, `known_cost_usd_micros`, `credits_usd_micros`,
  `cash_cost_usd_micros`, and `calls_with_unknown_usage`.
- `margin`: partial `usdc_less_inference_micros`, separate `near_yocto`, and `includes_native_gas: false`.
  `positive_margin` is `null`, with `margin_unavailable_reason`: native-token USD valuations and measured
  NEAR transaction fees are unavailable. No native fee is silently valued at zero.
- `self_funding: false` and `self_funding_reason`: USDC/NEAR receipts do not automatically replenish
  EVM native gas, even when a partial currency margin is positive.
- `x402_unsettled_usdc`: the desk's reported x402 amount, excluded from earned revenue.
- `per_order_margin`: `order_id`, `chain`, `status`, delivery-only `revenue`, `judge_cost_usd_micros`,
  measured `gas_wei`, the currency-vector `margin` (`usdc_less_inference_micros`, `near_yocto`,
  `native_gas_wei`, `near_gas_yocto: null`), `positive_margin`, `margin_unavailable_reason`, and `x402_settled`.
  Linked sample/resolve fees are included; unlinked executor fees remain in chain totals.

Ledger `recent` entries add `grading_quality`, `grade_due_s`, `resolved_at`, and `grading_time_unknown`.
Quality labels are independent: `unresolved` means due but not resolved; `late` means the chain resolution
timestamp is more than one cron interval (60 seconds) after due; `degraded` means fewer than two locally
observed samples on a sampling chain when due. No-sampling testnets are not degraded for lacking samples.
Old grades without a recorded chain timestamp have `grading_time_unknown: true`, not an invented timestamp.
Samples taken by other callers are not reconstructed by the local sample counter.

Vault RPC reads are pinned to one block number per reading, including the vault name and mirror APY/utilization.
In `rein-v1` docs, `apy_bps` and `apy_bps_prev` accept an integer or `na`; `na` means unavailable, never zero.
A missing previous snapshot also stays unavailable. The input checker accepts `na` without claiming that
APY was checked against the oracle: only price, assets and liquidity have oracle snapshots.
The desk's document validator parses order/chain/vault/time, not APY, so this needs no contract parser change.
Before the next deployment, install the exact `JUDGE_PROMPT` bytes from `shared/judgePrompt.ts` with the owner's
`set_prompt` call. Its added instruction forbids interpreting unavailable APY as zero or an APY change.
The Worker continues to fetch the onchain prompt; nothing here deploys or changes it remotely.

**Abuse controls:** `POST /v1/kick` requires `Authorization: Bearer <KICK_TOKEN>`; an unset secret disables
all kicks. Set `KICK_TOKEN` as a Worker secret, never in committed configuration. `/v1/quote` allows ten
requests per trusted `CF-Connecting-IP` per fixed minute in D1; it returns 429 with `Retry-After: 60` before
initializing payment dependencies. Missing IP headers share one bucket. Stored IP identifiers are SHA-256
hashes, not raw addresses. Each tick still advances at most ten orders per chain with the existing rotating
scan/active-order merge; cron mirrors and grades before processing orders so a paid-order backlog cannot
delay that invocation's grading.

`GET /v1/health` retains balances/allowance/flags and adds:

- `last_cron_s`: completion of the last successful scheduled pass, not a manual kick. Missing or older
  than 180 seconds is `stale_cron` (one-minute cadence, two missed intervals tolerated).
- `last_delivery_s`: latest first-mirrored delivered-order observation; it can lag delivery until mirroring.
- `oldest_stuck_order`: oldest `signing` order past `created_s + deadline_s`, or `signed` order past
  `valid_until + deadline_s`. These use the desk's signing deadline and public signed-refund grace.
- `pending_refunds`: count/amounts currently eligible for public refunds, not proof of unpaid authorized
  transfers. Open/EXIT-pending orders obey deadline/kill; signed orders always wait expiry plus grace.
  Signing orders are flagged as stuck but are not publicly refundable.
- `key_permissions`: actual key receiver, methods and full-access status. Health checks the desk receiver,
  allowance and every Worker mutation method, including `fail_post`; full access and unrestricted method lists
  are flagged instead of silently treated as correctly scoped keys.
- `incidents`: the latest 100 persisted episodes, each with `id`, `network`, `flag`, `first_seen`, `last_seen`,
  `occurrences`, and `resolved_at`. Repeated observations update the active episode. A readable healthy
  evaluation closes absent conditions, retaining history; recurrence starts a new episode. Unreadable
  evaluations do not declare previous conditions recovered. Cron and health requests both evaluate incidents.


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
