# Buy a Rein verdict with an agent

Rein sells a signed HOLD, EXIT or MOVE verdict and posts it to an EVM oracle. Browse first with the free MCP tools; only call `get_verdict` when you intend to pay. A verdict is not a guarantee or automatic protection.

## Networks and availability

| Setting | Testnet | Mainnet |
| --- | --- | --- |
| Worker | `https://api-testnet.reinfi.xyz` | `<placeholder>` — live by 12 Nov |
| NEAR desk | `rein-desk.testnet` | `<placeholder>` — live by 12 Nov |
| Verdict chains | `monad-testnet`, `base-sepolia` | `monad`, `base` |

Local MCP runs from a clone, not a published npm package. Remote `/mcp` is **live after the next Worker deploy**; the URL below is not a claim that it is deployed today. x402 is mainnet only: a testnet remote server can expose free tools, but cannot sell testnet x402 verdicts.

## A. Local MCP: pay from your own NEAR sub-account

### 1. Isolate the spending account

In your NEAR wallet or local NEAR CLI, select **testnet**, create a dedicated sub-account of an account you control (for example `agent.<your-account>.testnet`), and fund it with only the NEAR you are willing to spend. Confirm that the new account exists and its balance is bounded before continuing. Keep enough for the quoted judgement price plus transaction fees and account storage. These are buyer actions; browsing the tools does not create or fund an account.

Use that sub-account's full-access key, stored only on your machine. **A function-call access key cannot attach a deposit.** `request_judgement` requires the current `price_near` as an attached deposit, so a key scoped to that method would not work. The dedicated account's balance, not a function-call allowance, bounds exposure. A stolen full-access key can drain or control that sub-account; do not use your primary wallet key or put unrelated assets there.

Never put the key in a tool argument, an agent prompt, chat, a screenshot, or a committed file. Enter it locally into the MCP client environment. `ed25519:<your-key>` below is an intentionally invalid placeholder.

### 2. Configure Claude Code

Clone the repository and install its pinned dependencies:

```sh
pnpm install
```

Merge this `mcpServers` entry into your **private local** Claude Code configuration. Replace `/absolute/path/to/rein` with the clone path and the account/key placeholders locally. Do not commit the configuration. Using `--dir` makes the process independent of the client's working directory. `--silent` keeps pnpm's own banner off stdout, which carries the MCP protocol.

```json
{
  "mcpServers": {
    "rein": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/absolute/path/to/rein", "--filter", "rein-mcp", "start"],
      "env": {
        "REIN_NETWORK": "testnet",
        "REIN_NEAR_ACCOUNT": "agent.<your-account>.testnet",
        "REIN_NEAR_KEY": "ed25519:<your-key>",
        "REIN_API_URL": "https://api-testnet.reinfi.xyz"
      }
    }
  }
}
```

Restart the MCP connection. You should see five tools: `list_vaults`, `latest_verdict`, `get_verdict`, `order_status`, and `ledger`. `REIN_NETWORK`, `REIN_NEAR_ACCOUNT`, and `REIN_NEAR_KEY` are required; `REIN_API_URL` is optional. The network selects the desk and unsigned NEAR RPC. Mainnet use must wait for confirmed deployment values above; changing the API alone does not change the desk.

### 3. Browse, then buy once

Ask the client to invoke `list_vaults` with:

```json
{"chain":"monad-testnet"}
```

See the current menu, price and spacing. Then, if the account is funded and you approve the spend, invoke `get_verdict` once:

```json
{"chain":"monad-testnet","vault":"0xA32cF682DA4A62c056fD631eE91dfE3C713EF1DB"}
```

The local payer attaches the current `price_near` to `request_judgement`. Admission can refuse an unavailable vault, active order, spacing violation or kill switch. A delivered result includes `order_id`, verdict, confidence/risk and available proof fields. A grade is `null` until resolved, and unavailable proof fields remain `null`.

An order wait is capped at four minutes. If the result is `{ "pending": true, "order_id": 123, "status": "signed" }`, do **not** buy again. Invoke `order_status` with the returned ID:

```json
{"order_id":123}
```

NEAR escrow is released on delivery; failed posts authorize automatic refunds. Failed transfers remain owed and can require a claim. A Worker outage can delay recovery until expiry plus grace; see the receipt for status rather than assuming funds have arrived.

## B. Remote MCP: x402, no NEAR key

For an MCP client supporting streamable HTTP, the testnet route is:

```text
https://api-testnet.reinfi.xyz/mcp
```

**Live after the next Worker deploy.** Claude Code remote configuration for browsing is:

```json
{
  "mcpServers": {
    "rein-remote": {
      "type": "http",
      "url": "https://api-testnet.reinfi.xyz/mcp"
    }
  }
}
```

For a paid mainnet call, replace the URL with `<placeholder>/mcp` — **live by 12 Nov**. Select a vault from `list_vaults` on `monad` or `base`, not a testnet mirror. Remote mode never needs or accepts your NEAR signing key.

1. Call `get_verdict` without `payment`, for example:

   ```json
   {"chain":"monad","vault":"0xE1BcA19baA63894D374578320551633320436523"}
   ```

   See `payment_required: true` and `accepts`. This is a quote requirement, not a charge.
2. Have your x402-capable wallet/client choose an advertised offer. The wire format is x402 v2, `scheme: exact`, `assetTransferMethod: near-intents`, and `paymentFlow: upfront`. Encode the returned resource and original unquoted accepted entry with a quote payload containing your origin-chain `refundTo`. Pass the base64 JSON as the tool's `payment` string. See quoted deposit terms, including the operation token, deposit address, amount, expiry and any memo. Keep the operation token private: it is a bearer credential.
3. Only after checking the terms, send the quoted funds using your wallet. Rein does not send them for you. Call the same tool with `payment` encoding the original unquoted accepted entry and deposit proof (`type: deposit`, `operationToken`, `depositAddress`, `txHash`, and `depositMemo` if required):

   ```json
   {"chain":"monad","vault":"0xE1BcA19baA63894D374578320551633320436523","payment":"<base64-x402-v2-payment>"}
   ```

   See the verdict record once delivered. If settlement is pending, the result contains `pending: true`, `payment_ref`, and `order_id: null`. Request the verdict again with **the same payment**; do not make another deposit. Reusing it does not incur a second charge. Once there is an order ID, resume with `order_status`.

x402 settles **before** judgement; it is not NEAR escrow and is not a hold captured on delivery. A paid judgement failure can earn one replacement judgement credit, not a cash refund. Ordinary retries replay the saved result. Explicit credit redemption uses the raw endpoint/helper in path C; the MCP tool does not expose `redeemCredit`. Live treasury routing, receipts and swap-failure refunds/fees still need confirmation.

## C. Raw x402 helper

From the clone root, these are the two supported command forms (replace angle-bracket placeholders before running):

```sh
node --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> [payment-signature]
node --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> <payment-signature> --redeem-credit
```

Use `<placeholder>` for the mainnet Worker until it is **live by 12 Nov**, and a current mainnet menu vault. Omit the optional payment signature to see the 402 requirements. Supply the base64 quote payment to see deposit terms, then use your wallet to fund them and supply the deposit payment to see settlement/delivery or a pending response. The helper **never deposits funds**. Keep operation tokens and deposit proofs private.

The second command explicitly spends an available one-use credit on the **original chain/vault**, without another settlement. A replacement failure does not mint another credit. Do not redeem merely because a request is still pending.

## Verify the result

Open the returned order's receipt at `/orders/<order_id>` on the matching Rein network. “Verify this order” links the NEAR order, stored reading/hash, approved model signer, Chain Signatures post and eventual grade. Missing stages stay absent while an order is in flight. A signature authenticates an answer, not the truth of the RPC inputs; confidence is not calibrated accuracy.

## Compare the Ledger with simple forecasts

From the clone root:

```sh
pnpm baseline --check
pnpm baseline scripts/fixtures/baseline-sample.json
pnpm baseline https://api-testnet.reinfi.xyz/v1/ledger
```

The last command is a free public read. A URL or a saved Ledger JSON object with `recent` rows produces the same table: N scored and mean Brier error, lower being better. The fixture self-check pins all four results to six decimals and checks that unavailable APY is not interpreted as zero.

Every forecast uses the same resolved, non-repeat calls. Rein uses the shared Ledger scorer with `risk_bps / 10000` against `adverse`; the coin uses 0.5. The hindsight base rate uses the observed adverse fraction, so it is not an out-of-sample forecast. The rule uses 0.9 when `util_bps >= 9500` or known liquidity is below 2%, otherwise 0.1. Liquidity is parsed as the percent written in the reading, not as basis points. With `liquidity=na`, only utilization can trigger the rule: missing liquidity is not evidence of low liquidity. APY is never an input.

Missing risk or document fields on scored rows cause an explicit failure, not invented inputs. No resolved calls means N=0 and Brier `na`. The public endpoint's `recent` window is bounded; this comparison is not a full-history evaluation or proof of calibrated accuracy. Explicit repeat flags supplement count-once classification within that window.
