import type { Metadata } from 'next';
import Link from 'next/link';
import { DEPLOYMENTS } from '../../../../shared/deployments';

export const metadata: Metadata = { title: 'HTTP API' };

export default function ApiDocs() {
  return (
    <>
      <h1>HTTP API</h1>
      <p>
        The Worker serves JSON reads, deposit quotes, judgement payments, browser alerts and MCP on mainnet and testnet.
        Use the matching network’s endpoint; each Worker has its own database.
      </p>
      <ul>
        {Object.entries(DEPLOYMENTS).map(([network, deployment]) => (
          <li key={network}>
            {network}: <code>{deployment.api}</code>
          </li>
        ))}
      </ul>
      <h2>Conventions and limits</h2>
      <p>
        Send JSON request bodies with <code>Content-Type: application/json</code>. Amounts are decimal integer strings
        in the asset’s smallest units. Timestamps ending in <code>_s</code> and post/grade timestamps are Unix seconds.
        Optional or unavailable proof data can be null. Chain names are <code>monad-testnet</code>,{' '}
        <code>base-sepolia</code>, <code>monad</code> and <code>base</code>.
      </p>
      <p>
        Quote, nudge, alert-subscription and MCP POSTs share the configured per-IP quote limiter. x402 quote creation
        uses the same binding with a separate IP bucket; deposit replay and credit redemption do not create a new quote.
        Limits are approximate and local to a Cloudflare location, not a global spending guard. Public GETs below have
        no such route guard. Rate-limit middleware returns JSON 429 with <code>Retry-After: 60</code>; alert capacity
        errors also use 429 but do not carry that retry header.
      </p>
      <p>
        Common errors are <code>{'{"error":"<message>"}'}</code>: 400 invalid input, 404 not found, 405 wrong method
        with an <code>Allow</code> header, 429 rate limited, and 500 internal error without a stack trace. HEAD is not
        supported. Paths are strict, so do not add a trailing slash. CORS is enabled for quote creation and alert
        routes; other routes do not promise cross-origin browser access.
      </p>
      <h2>Ledger and operations</h2>
      <h3>
        <code>GET /v1/ledger</code>
      </h3>
      <p>
        Optional query <code>network=testnet|mainnet</code> defaults to the Worker’s network. Returns{' '}
        <code>{'{network, score, posts, calls, input_checks, business, recent: Post[]}'}</code>. Invalid network: 400.
        Scores cover all stored calls; recent posts are a bounded newest-first window.
      </p>
      <pre>
        {
          'score: {n, brier: number|null, early, bands: [{band, n, hitRate}]}\nPost: {chain, id, vault, verdict, confidence_bps, risk_bps, posted_at,\n  order_id, input_check, resolved, adverse, reasons, doc, signer, repeat,\n  grading_quality: string[], grade_due_s, resolved_at, grading_time_unknown}\ninput_checks: {match, mismatch, unknown}'
        }
      </pre>
      <p>
        <code>input_check</code> describes the Worker’s comparison with oracle snapshots, not a proof of all inputs.{' '}
        <code>business</code> is the same economics shape as stats below.
      </p>
      <h3>
        <code>GET /v1/ledger/brier</code>
      </h3>
      <p>
        Same optional network query and 400 validation. Returns <code>{'{network, points: [{at, n, brier}]}'}</code>{' '}
        over resolved non-repeat calls with known resolution timestamps, in resolution order. This is the running chart,
        not the bounded recent-post list.
      </p>
      <h3>
        <code>GET /v1/stats</code>
      </h3>
      <p>
        No body or query required. Returns business totals for this Worker:{' '}
        <code>{'{desk, judge_calls, judge_cost_usd_micros, orders, watch, ...economics}'}</code>. Desk can be null;
        otherwise it includes the mirrored desk stats and <code>as_of</code>. Orders are grouped{' '}
        <code>{'{source, status, n}'}</code>; watch contains <code>{'{asked, opened}'}</code>.
      </p>
      <p>
        Economics fields include <code>settled_revenue</code>, <code>opened_orders</code>, <code>refunds</code>,{' '}
        <code>unpaid_liabilities</code>, <code>gas_per_chain</code>, <code>inference</code>, <code>margin</code>,{' '}
        <code>positive_margin</code>, <code>margin_unavailable_reason</code>, <code>self_funding</code>,{' '}
        <code>self_funding_reason</code>, <code>x402_unsettled_usdc</code>, <code>per_order_margin</code> and{' '}
        <code>per_order_margin_truncated</code>. Currency amounts remain separate; unknown costs are null and observed
        gas may be a lower bound. Authorized refunds and earned splits do not prove payout transfers succeeded. x402
        earns revenue only on delivery; credits and settled pending purchases remain liabilities.
      </p>
      <h3>
        <code>GET /v1/health</code>
      </h3>
      <p>
        No input. Returns{' '}
        <code>
          {
            '{ok, flags, gas, agent_yocto, allowance_pct, last_cron_s, last_delivery_s, oldest_stuck_order, pending_refunds, key_permissions, incidents}'
          }
        </code>
        . HTTP 200 when ok, 503 otherwise. Unreadable balances/permissions remain null. Gas is keyed by chain with wei
        strings. Key permissions expose receiver, methods and full-access status—not the key. Incidents retain
        first/last observation, occurrence count and resolution time. This is operational evidence, not a safety
        guarantee.
      </p>
      <h3>
        <code>POST /v1/kick</code>
      </h3>
      <p>Token-only operator route. Not a public agent integration.</p>
      <h2>Orders</h2>
      <h3>
        <code>GET /v1/orders</code>
      </h3>
      <p>
        Query <code>payer=&lt;near-account&gt;</code> is required; <code>limit</code> is optional and clamped to the
        route’s page bounds. Returns <code>{'{orders: Order[]}'}</code>, newest order ID first. Missing payer: 400.
      </p>
      <pre>
        {
          'Order: {id, source, payer: string|null, chain, vault, amount, created_s,\n  status, exit_pending_s: number|null, valid_until: number|null}'
        }
      </pre>
      <p>
        Source is NEAR, USDC, x402 or watch, encoded lowercase. A null payer is normal for x402/watch. The HTTP rows are
        mirrored data and may include stored journal fields; consume documented fields, not incidental database columns.
      </p>
      <h3>
        <code>{'GET /v1/orders/:id{[0-9]+}'}</code>
      </h3>
      <p>
        Use a numeric ID, for example <code>/v1/orders/123</code>. Returns the order row plus{' '}
        <code>{'{posts: [...], judge_calls: [{at, signing_address}], post_tx: string|null}'}</code>. Posts contain
        chain/id, verdict, confidence/risk, state_hash, posted_at, input_check, sampled, resolved, adverse, reasons and
        doc. Unknown/unmirrored orders: 404. Judge calls include only successful signed answers; a transaction is
        present only after its successful receipt is known.
      </p>
      <h3>
        <code>{'POST /v1/orders/:id{[0-9]+}/nudge'}</code>
      </h3>
      <p>
        No body required. Advances that order under the cron’s chain lease and returns <code>{'{status}'}</code>.
        Unknown order: 404. Terminal orders do not invoke the model. Shared per-IP limiter applies; nudge is not a new
        purchase.
      </p>
      <h2>Cross-chain quotes</h2>
      <h3>
        <code>POST /v1/quote</code>
      </h3>
      <p>
        Requests an exact-input deposit quote from 1Click. Shared per-IP limiter applies. Creating a quote does not send
        funds.
      </p>
      <pre>
        {
          '// Default: native USDC to a NEAR account\n{ "originAsset": "<asset-id>", "amount": "<positive-integer>",\n  "recipientNear": "buyer.near" }\n// Explicit destination (MOVE)\n{ "originAsset": "<asset-id>", "amount": "<positive-integer>",\n  "destinationAsset": "<asset-id>", "recipient": "<destination-address>",\n  "refundTo": "<origin-address>" }\n// Success\n{ "depositAddress": "<address>", "amountIn": "<base-units>",\n  "expiresAt": "<deadline>" }'
        }
      </pre>
      <p>
        Default quotes refund to the NEAR recipient’s Intents account. Explicit destinations refund on the origin chain.
        Invalid fields: 400. Failed upstream quote or missing deposit address: 502. Check the returned terms and expiry
        before sending funds yourself.
      </p>
      <h3>
        <code>GET /v1/quote/status</code>
      </h3>
      <p>
        Required query <code>depositAddress</code>; missing it returns 400. Successful 1Click status responses pass
        through unchanged, including provider status/receipt fields. Upstream errors retain their HTTP status but become{' '}
        <code>{'{"error":"quote status failed"}'}</code>. The successful body is provider-defined, not a fixed Rein
        order schema.
      </p>
      <h2>x402 judgement</h2>
      <h3>
        <code>POST /v1/x402/judge</code>
      </h3>
      <p>
        Body <code>{'{chain, vault, redeemCredit?: true}'}</code>; optional <code>PAYMENT-SIGNATURE</code> header
        contains base64 x402 v2 JSON. Mainnet-only: testnet returns 503. Invalid chain/address: 400; policy refusal
        before quoting: 422; unavailable payment service or invalid receipt: 502; quote rate limit: 429.
      </p>
      <p>
        Without payment, 402 returns <code>{'{x402Version, error, resource: {url}, accepts: Requirements[]}'}</code> and
        its base64 encoding in <code>PAYMENT-REQUIRED</code>. Requirements carry scheme, origin network/asset, amount,
        payTo, maxTimeoutSeconds and extra destination/flow metadata. The quote-phase 402 adds the deposit terms and
        operation token. This is not a charge.
      </p>
      <p>
        Pending settlement or judgement returns 202, with status/paymentRef and an order ID when known. Delivery returns
        200 with <code>{'{orderId, signedTx, verdict}'}</code>; signedTx can be null after external broadcast.
        Settlement receipts use <code>PAYMENT-RESPONSE</code>. A paid failed judgement returns an application error with{' '}
        <code>creditAvailable</code>; ordinary retries replay the result. Terminal swap failures return the saved
        provider receipt rather than inventing a judgement. See <Link href="/docs/x402">x402</Link> for payloads and
        explicit credit redemption.
      </p>
      <h2>Browser EXIT alerts</h2>
      <h3>
        <code>GET /v1/alerts/key</code>
      </h3>
      <p>
        No input. Returns <code>{'{key: string|null}'}</code>: the public VAPID subscription key, or null when alerts
        are off.
      </p>
      <h3>
        <code>POST /v1/alerts/subscribe</code>
      </h3>
      <h3>
        <code>POST /v1/alerts/unsubscribe</code>
      </h3>
      <pre>
        {
          '{ "chain": "<chain-on-this-network>", "vault": "0x<address>",\n  "subscription": { "endpoint": "https://<push-service-endpoint>",\n    "keys": { "p256dh": "<browser-public-key>", "auth": "<browser-auth>" } } }'
        }
      </pre>
      <p>
        Both validate the browser subscription and chain/vault, returning <code>{'{subscribed: true}'}</code> or{' '}
        <code>{'{subscribed: false}'}</code>. Invalid subscription: 400; alerts disabled: 503; shared rate limit or
        per-browser subscription capacity: 429. An alert reports an EXIT signal, not an executed withdrawal.
      </p>
      <h2>MCP</h2>
      <h3>
        <code>POST /mcp</code>
      </h3>
      <p>
        Stateless streamable HTTP MCP: send MCP JSON-RPC initialization/tool requests using the protocol’s content and
        accept headers. Responses are MCP JSON-RPC/tool content or the negotiated stream, not the REST order envelope.
        Each POST gets a fresh server; there is no session ID. Other methods return JSON 405. The shared per-IP limiter
        applies. See <Link href="/docs/mcp">the six tools and configuration</Link>.
      </p>
    </>
  );
}
