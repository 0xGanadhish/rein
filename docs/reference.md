# Rein reference

Detailed behaviour of the desk, the Worker, the API and the x402 path. The [README](../README.md) has the overview and the steps to try Rein.

## Use Rein from an agent

The private `rein-mcp` workspace package exposes five tools with structured results and a one-line summary:
`list_vaults` (menus, prices and spacing), `latest_verdict` (latest public vault verdict),
`get_verdict` (buy and wait), `order_status` (resume an order), and `ledger` (graded posts and scores).
Free tools never submit a payment. Before buying, `get_verdict` checks the menu, kill switch and visible post
spacing. Desk admission remains authoritative if the public Ledger is behind.

An order wait is capped at four minutes; `{ pending: true, order_id, status }` resumes with `order_status`.
While an x402 payment is still settling, `{ pending: true, payment_ref, order_id: null }` means call
`get_verdict` again with the same payment; that payment is not charged twice.
Verdict records contain the chain, vault, HOLD/EXIT/MOVE answer, confidence/risk, available proof links and grade.
Proof fields that the receipt does not expose remain `null`.

Local stdio runs from a clone with `pnpm --silent --filter rein-mcp start` (`--silent` keeps pnpm's banner off stdout, which carries the MCP stream). Configure `REIN_NETWORK`
(`testnet` or `mainnet`), `REIN_NEAR_ACCOUNT`, and `REIN_NEAR_KEY` in the MCP client's environment;
never send the key in a tool argument. `REIN_API_URL` optionally overrides the network's public API.
The network selects the desk and unsigned NEAR RPC endpoint. Signing is lazy: browsing never parses or uses
the key. A paid call attaches the current `price_near` to one `request_judgement` call.
Keys and original signing exceptions are excluded from reported errors.

`POST /v1/orders/:id/nudge` advances one order under the cron's chain lease and returns `{ status }`.
Unknown orders return JSON 404; terminal orders do not call the model. The public route shares the quote
per-IP limit (JSON 429 with `Retry-After: 60`); only POST is allowed.

Remote MCP uses the Worker's `/mcp` endpoint with stateless streamable HTTP. Each POST gets a fresh server;
there is no session ID. It shares the nudge/quote per-IP limit and rejects other methods with JSON 405.
It is live on the testnet Worker at `https://api-testnet.reinfi.xyz/mcp`.

In remote mode, `get_verdict` without `payment` returns the existing x402 `accepts` requirements. Pass the
encoded x402 payment as `payment` to use the same in-process payment handler as `/v1/x402/judge`.
Once an order ID exists, the tool nudges it and polls the desk, sending progress notifications on status changes
when the MCP client supplies a progress token. Delivery returns the same verdict record as local mode.
Remote mode never accepts a NEAR signing key. x402 payments retain the existing upfront-payment and one-use
retry-credit policy; they are not NEAR escrow refunds.

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

### Guardian exit worker

Automatic exits are **disabled by default** (`GUARDIANS = "{}"`). Deploy GuardianV2 on Rein's oracle,
approve the menu vaults, and apply migrations through `worker/migrations/0007_exits.sql` before enabling them.
Set the Worker's `GUARDIANS` JSON by EVM chain, for example
`{"base":{"address":"<deployed Guardian address>","fromBlock":"<deployment block>"}}`.
Use decimal strings for deployment blocks. The existing `EXECUTOR_KEY` signs exits as well as grading
transactions; fund it with native gas on every enabled chain and configure that chain's RPC and oracle.
No Cloudflare Queue binding or additional secret is needed.

- Each newly mirrored EXIT durably queues its chain and verdict ID before the mirror cursor advances.
  Guardian `Enabled` logs discover owners from the deployment block; current onchain rules, confidence,
  freshness, enable time, verdict floor and latest verdict are checked before simulation and signing.
  Disabled owners and unmet thresholds never send an exit. Guardian always pays the owner.
- Each cron pass (also an authenticated kick) runs exits **after** grading, orders and watch work.
  Per chain it scans at most 2,000 blocks, fans out at most four verdicts × 20 owners, and processes at most
  four due jobs. Initial log indexing must catch up before verdict fan-out starts.
- Signed bytes and their transaction hash are committed before broadcast. A lost response or restart
  checks the same receipt or rebroadcasts identical bytes, never a replacement exit. Pending signed exits
  reserve that chain's executor nonce; grading on that chain waits for settlement. An indefinitely
  unmined transaction therefore requires operator attention rather than unsafe nonce replacement.
- Receipt fees, including reverted attempts and reported L1 fees, are inserted once into `executor_fees`
  with `kind = 'exit'`. Existing Ledger gas and margin fields retain their meaning.
- A partial receipt atomically stores `remaining_shares` and a follow-up due **30 seconds later**.
  The one-minute cron processes it on the next eligible tick, not necessarily at exactly 30 seconds.
  Follow-ups reuse the same verdict and recheck authorization; stale or superseded verdicts stop them.
  A full exit does not requeue. Each signed attempt remains in `exit_attempts`; `exits.assets` is the latest
  receipt's assets, not a cumulative total.
- Simulation cannot pin the verdict at mining: Guardian uses the latest verdict. If a newer verdict wins
  that race, the Worker counts the transaction fee but does not report it as confirmation of the old verdict.

Before turning on the web's `EXIT_WORKER_LIVE` flag, the matching deployed contracts, vault approvals,
funded executor, configuration and migration must be live, log indexing must be caught up, and the running
cron must have demonstrated an opted-in exit with funds reaching the owner and receipt/gas records in D1.
Code availability alone is not automatic protection; partial exits can leave funds locked.


### Ledger, inputs and operational health

Apply migrations through `worker/migrations/0007_exits.sql` before deploying this Worker.
Startup does not apply migrations. The schema includes call outcomes/token usage, receipt fees, grading
times, persistent incidents, and the x402 operation/result journal.

**Model cost:** NEAR AI's public [models endpoint](https://cloud-api.near.ai/v1/models) lists
`Qwen/Qwen3.6-35B-A3B-FP8` at **$0.17 per million input tokens** and **$1.10 per million output tokens**.
A 244-input/34-output-token completion is about $0.00007888, rounded to 79 USD micros in the call journal.
Signature failures and desk-refused answers retain the completion's token cost and failing stage.
Account credits and cash charges are not reported by token usage: unknown credits/cash cost remain `null`,
not zero. Calls with missing usage are counted explicitly; the known-cost subtotal is not a complete bill.

`GET /v1/stats` and `/v1/ledger.business` retain their existing fields and add:

- `settled_revenue`: NEAR/USDC split totals from the desk, credited only at delivery; this is earned revenue,
  not proof that payout transfers succeeded. Separate `x402_usdc` counts each settled payment once,
  only after its original or replacement judgement is delivered.
- `opened_orders`: mirrored count/amounts and authoritative gross accepted escrow in `desk_gross`.
- `refunds`: authorized order count and mirrored refund amounts, separate from `paid_amounts: null`.
  The desk exposes aggregate owed balances, not a refund-versus-split payout breakdown.
- `unpaid_liabilities`: USDC and yoctoNEAR still owed, including in-flight and failed transfers.
  `x402_credit_usdc` is the face value of unredeemed one-use judgement credits; it is not a cash refund.
  `x402_pending_usdc` covers settled purchases whose judgement is still pending.
- `gas_per_chain`: `desk_wei`, journal `observed_wei`, `executor_wei`, `reverted_wei`, `cost_wei`,
  and `cost_is_lower_bound`. Post fees overlap desk totals, so their maximum, not their sum, is used;
  executor sample/resolve/exit fees are added separately. Historic/unobserved receipts can make this a lower bound.
- `inference`: `underlying_cost_usd_micros`, `known_cost_usd_micros`, `credits_usd_micros`,
  `cash_cost_usd_micros`, and `calls_with_unknown_usage`.
- `margin`: partial `usdc_less_inference_micros`, separate `near_yocto`, and `includes_native_gas: false`.
  `positive_margin` is `null`, with `margin_unavailable_reason`: native-token USD valuations and measured
  NEAR transaction fees are unavailable. No native fee is silently valued at zero.
- `self_funding: false` and `self_funding_reason`: USDC/NEAR receipts do not automatically replenish
  EVM native gas, even when a partial currency margin is positive.
- `x402_unsettled_usdc`: desk-reported x402 amounts without a confirmed payment-journal settlement,
  excluded from earned revenue. A settled but undelivered purchase is deferred, not earned revenue.
- `per_order_margin`: `order_id`, `chain`, `status`, delivery-only `revenue`, `judge_cost_usd_micros`,
  measured `gas_wei`, the currency-vector `margin` (`usdc_less_inference_micros`, `near_yocto`,
  `native_gas_wei`, `near_gas_yocto: null`), `positive_margin`, `margin_unavailable_reason`, and `x402_settled`.
  Linked sample/resolve/exit fees are included; unlinked executor fees remain in chain totals.
  Only the newest 200 orders (descending order ID) are returned; `per_order_margin_truncated` reports
  whether older orders were omitted. All totals still cover every order.

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

Each tick still advances at most ten orders per chain with the existing rotating
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

## API

Routing uses Hono. Errors return `{"error":"<message>"}` with `content-type: application/json`,
including 404 and 405; 405 retains `Allow`. Unexpected exceptions are logged with the request path
and return 500 `{"error":"internal error"}`, never a stack trace. The x402 payment endpoint retains
its protocol-specific response bodies and headers. Failed quote/status upstream responses use the
same error shape; successful status responses still pass through.

- `POST /v1/kick`: bearer-token middleware requires `Authorization: Bearer <KICK_TOKEN>`; missing or
  incorrect tokens return 401, and an unset secret disables kicks.
- `POST /v1/quote`: rate-limit middleware runs before parsing or initializing payment dependencies.
  The Workers Rate Limiting binding allows 10 requests per 60 seconds, keyed on `CF-Connecting-IP`;
  missing headers share the `unknown` bucket. Limits are approximate and local to each Cloudflare
  location, not a strict global quota. Denials return 429 with `Retry-After: 60`.
- `POST /v1/x402/judge`: x402 v2 quote/deposit flow, described below. Quote creation uses the same rate-limit
  binding with a separate `x402:<IP>` bucket; replay and credit redemption do not request a new quote.
- `GET /v1/ledger`, `/v1/orders/:id` (numeric ID), `/v1/quote/status`, `/v1/stats`, and `/v1/health`:
  public reads without those guards. HEAD remains unsupported.

Apply migrations through `worker/migrations/0007_exits.sql` before deploying. Migration `0005` removes
the obsolete D1 limiter table; `0006` adds payment operations and judgement attempts; `0007` adds durable exits.
The binding is configured in `worker/wrangler.toml`, with observability enabled.

### x402 judgement purchases

This path is **mainnet only** (Monad or Base judgements). It implements PingPay's
[x402 integration](https://pingpay.gitbook.io/docs/pingpay-api/agent-pay-facilitator/x402-integration)
and the [near-intents proposal](https://github.com/x402-foundation/x402/pull/3370):
`scheme: "exact"`, `extra.assetTransferMethod: "near-intents"`, `extra.paymentFlow: "upfront"`.
The facilitator is `https://pay.pingpay.io/agentpay/x402`, authenticated by the Worker secret
`PINGPAY_API_KEY` in `X-Api-Key`. Configure the PingPay organization's destination to match
the desk policy's `treasury` and `usdc_token`; the Worker rejects offers with a different destination.
No additional treasury variable is needed. In protocol terms, unquoted `payTo` is empty and quoted
`payTo` is the 1Click deposit address; **the treasury is `extra.destination.recipient`, never the agent**.

1. `POST /v1/x402/judge` with `{"chain":"monad","vault":"0x..."}` returns 402 with an unquoted
   `accepts[]` and the same body encoded in `PAYMENT-REQUIRED`. Each purchase's `resource.url`
   includes its chain and lowercase vault as query parameters.
2. Retry with `PAYMENT-SIGNATURE` containing base64 x402 v2 JSON: `resource`, the chosen unquoted
   `accepted` entry, and `payload: {"type":"quote","refundTo":"<origin-chain address>"}`.
   Optional `slippageTolerance` is in basis points. Before quoting, the Worker calls the desk's
   read-only `check_x402_request`: menu, active order, spacing, caps and kill switch use the same
   admission code as order creation. Refused requests return 422 and burn no claim.
3. `/verify` commits no funds. The second 402 carries quoted `payTo`, `amount`, `operationToken`,
   `refundDeadline`, and a `depositMemo` where required. Persist these privately before depositing.
   Send funds on the advertised origin network; this starts the swap automatically.
4. Retry with the **original unquoted** `accepted` entry and `payload: {"type":"deposit",
   "operationToken":"...","depositAddress":"...","txHash":"..."}`; include `depositMemo` if quoted.
   The Worker calls `/settle` with its recorded terms, then starts the judgement only after success.
   Pending operations return 202; retry the same payment, do not fund a new quote.
   A rejected deposit proof does not burn the operation: correct the proof and retry with the same token.
   Terminal swap-failure/refund receipts are stored and replayed unchanged.
5. Delivery returns 200 with `orderId`, `signedTx`, and `verdict`. If an external broadcaster supplied
   the transaction, `signedTx` can be null and the verdict comes from the oracle mirror.
   `PAYMENT-RESPONSE` carries the settlement receipt. D1 stores the result, and subsequent presentations
   of the same operation return it without another settlement or judgement, even after a restart.
   Cron reconciles completed judgements independently of the HTTP connection. Pending operations do not
   crowd completed ones out of its bounded batch; mirrored outcomes also survive desk order pruning.

**Upfront means paid before judgement, not a hold captured on delivery.** A failed onchain post,
rejected/refunded desk order, or policy refusal after successful settlement returns an application error
with `creditAvailable: true`. No money moves back. The quote-time admission check is not a reservation:
another order or a policy change can win the race while payment completes.

Redeem a credit by sending the same deposit payment with `{"chain":"monad","vault":"0x...",
"redeemCredit":true}`. The credit buys **one replacement judgement of the original chain/vault**,
without another PingPay settlement. Ordinary retries replay the saved failure rather than spending
the credit. A refusal at the redemption preflight leaves it available; once the replacement attempt
starts, the credit is consumed. Failure of that attempt returns `creditAvailable: false` and does not
mint another credit. Concurrent redemptions cannot create additional attempts.

Deploy a desk with `check_x402_request` and idempotent `submit_x402_request` before enabling this Worker.
The latter retains attempt references after order pruning, so an accepted NEAR call whose response was
lost cannot create another order. Its receipt storage uses a separate prefix without changing the
serialized desk-state layout. The Worker stores the provider instrument identity (origin network,
deposit address and memo), quote terms, settlement receipt, attempt IDs and result in D1. Treat the
operation token as a bearer credential; it is not included in application results or settlement receipts.

The CLI helper never deposits funds:

```sh
node --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> [payment-signature]
node --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> <payment-signature> --redeem-credit
```

Live confirmation is still required for the organization's treasury routing, actual receipts, quote/token
expiry, and swap-failure refunds/fees. A successful swap is not reversed when a Rein judgement fails.


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
