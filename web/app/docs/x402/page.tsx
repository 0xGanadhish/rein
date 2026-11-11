import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'x402 payments' };

export default function X402Docs() {
  return (
    <>
      <h1>x402 payments</h1>
      <p>
        x402 lets an HTTP or remote MCP client buy a judgement without a NEAR signing key. Rein uses PingPay’s x402 v2
        exact-payment flow through NEAR Intents. It is mainnet-only, and mainnet is not deployed yet. Settlement is{' '}
        <strong>upfront</strong>: money moves before the judgement runs, not after delivery. This is not escrow or a
        card authorization.
      </p>
      <h2>Quote, deposit, settle, judge</h2>
      <ol>
        <li>
          <strong>Ask without payment.</strong> POST <code>/v1/x402/judge</code> with a mainnet <code>chain</code> and
          menu <code>vault</code>. Before quoting, the Worker checks menu, active order, spacing, caps and kill switch
          through the desk. Refused requests return 422 without payment verification or a consumed claim.
        </li>
        <li>
          <strong>Keep the advertised offer.</strong> HTTP 402 returns <code>resource</code> and <code>accepts</code>,
          also base64-encoded in <code>PAYMENT-REQUIRED</code>. The offer uses <code>scheme: exact</code>,{' '}
          <code>extra.assetTransferMethod: near-intents</code> and <code>extra.paymentFlow: upfront</code>. Its
          destination is the desk policy’s USDC token and treasury. The unquoted payTo and amount are empty.
        </li>
        <li>
          <strong>Request deposit terms.</strong> Retry with a base64 JSON <code>PAYMENT-SIGNATURE</code> containing
          x402Version, the exact resource, the original unquoted accepted offer and a quote payload. The second 402
          gives a deposit address, origin amount, operation token, refund deadline and any required memo. Quote
          verification itself does not move funds.
        </li>
        <li>
          <strong>Deposit yourself.</strong> Check the origin network/asset, recipient, amount, expiry, refund terms and
          memo. Send the quoted funds with your wallet. Neither the MCP server nor the buyer helper sends them for you.
          The quoted <code>payTo</code> is the swap deposit address, not the final treasury.
        </li>
        <li>
          <strong>Present deposit proof.</strong> Retry with the original unquoted accepted offer and a deposit payload.
          The Worker settles using its saved terms. It starts judgement only after successful settlement, and stores
          payment identity, settlement receipt, attempt references and result in D1.
        </li>
        <li>
          <strong>Receive or resume.</strong> Delivery returns the order ID, signed transaction when available and
          verdict. <code>PAYMENT-RESPONSE</code> carries the recorded settlement receipt. Re-presenting the same
          operation replays its saved result rather than settling or judging again.
        </li>
      </ol>
      <h2>Payment header shape</h2>
      <pre>
        {
          '// required is the original unquoted 402 JSON body.\nconst payment = {\n  x402Version: required.x402Version,\n  resource: required.resource,\n  accepted: required.accepts[0], // choose an advertised origin offer\n  payload: { type: "quote", refundTo: "<origin-chain-address>" }\n};\nconst header = btoa(JSON.stringify(payment));\n// For deposit presentation, keep resource and accepted unchanged:\npayment.payload = {\n  type: "deposit", operationToken: "<private-token>",\n  depositAddress: "<quoted-address>", txHash: "<deposit-tx>",\n  depositMemo: "<only-if-required>"\n};\nconst depositHeader = btoa(JSON.stringify(payment));'
        }
      </pre>
      <p>
        Base64-encode the complete JSON object for the header. A quote may also supply <code>slippageTolerance</code> in
        basis points. The resource URL binds the purchase to its chain and lowercase vault; do not substitute the MCP
        URL. Treat operation tokens and deposit proofs as private bearer credentials. Never publish them in logs,
        receipts or prompts.
      </p>
      <h2>Pending is not failure</h2>
      <p>
        HTTP 202 with <code>status: pending</code> and <code>paymentRef</code> means resume with the same deposit
        payment, not a fresh deposit. An orderId appears once known. Remote MCP represents settlement pending as{' '}
        <code>{'{pending: true, payment_ref, order_id: null}'}</code>; retry <code>get_verdict</code> with the same
        payment. Once an order ID exists, <code>order_status</code> reads it without buying again.
      </p>
      <p>
        A rejected deposit proof need not consume the operation: correct the proof and retry the same token. Terminal
        swap failure/refund receipts are saved and replayed. Swap-provider refund handling is separate from Rein
        judgement credits. Cron can reconcile an outcome after the original HTTP connection disappears.
      </p>
      <h2>One-use retry credit, not money back</h2>
      <p>
        A post failure, rejected/refunded judgement attempt or policy refusal after successful settlement can return{' '}
        <code>creditAvailable: true</code>. No money moves back. Quote-time admission was not a reservation: policy or
        another order can change while the swap settles.
      </p>
      <p>
        Ordinary retries replay that failure without spending the credit. To buy one replacement for the{' '}
        <em>original chain and vault</em>, explicitly POST the same deposit payment with{' '}
        <code>{'{chain, vault, redeemCredit: true}'}</code>. No second settlement occurs. Admission refusal before a
        replacement order is opened preserves the credit; an accepted replacement consumes it. A replacement failure
        returns <code>creditAvailable: false</code> and creates no further credit. Concurrent redemptions cannot open
        extra attempts.
      </p>
      <p>The MCP tool does not expose the redemption flag. From a clone, the raw helper supports:</p>
      <pre>
        {
          'node --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> [payment-signature]\nnode --experimental-strip-types scripts/x402-buyer.ts <worker-url> monad <vault> <payment-signature> --redeem-credit'
        }
      </pre>
      <p>
        The helper never deposits. Do not redeem merely because a judgement is pending. The Ledger recognizes x402
        revenue only when the original or replacement judgement is delivered; unused credits and settled pending
        purchases are liabilities.
      </p>
      <h2>What still requires live confirmation</h2>
      <p>
        Organization treasury routing, actual settlement receipts, quote/token expiry behavior and swap-failure
        refunds/fees require live deployment confirmation. The implementation is not evidence those services are
        currently available. A successful swap is not reversed because a Rein judgement fails. See{' '}
        <Link href="/docs/trust">Trust and limits</Link> and <Link href="/docs/api">HTTP errors and routes</Link>.
      </p>
    </>
  );
}
