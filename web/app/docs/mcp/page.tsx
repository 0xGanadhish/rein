import type { Metadata } from 'next';
import Link from 'next/link';
import { DEPLOYMENTS } from '../../../../shared/deployments';

export const metadata: Metadata = { title: 'MCP server' };

export default function McpDocs() {
  return (
    <>
      <h1>MCP server</h1>
      <p>
        Rein exposes six tools with structured results and a short text summary. Browse for free, buy deliberately, and
        resume an existing order instead of paying again. The local package runs from a clone; it is not a published npm
        install. Remote MCP is live on mainnet and testnet.
      </p>
      <h2>The six tools</h2>
      <dl>
        <dt>
          <code>list_vaults</code>
        </dt>
        <dd>
          Optional <code>chain</code>. Returns menus with vault addresses and <code>nextAllowedS</code>, plus live{' '}
          <code>price_near</code>, <code>price_usdc</code>, <code>spacing_s</code> and <code>kill</code>. No payment.
        </dd>
        <dt>
          <code>latest_verdict</code>
        </dt>
        <dd>
          Required <code>chain</code>, <code>vault</code>. Reads the latest matching public post from the recent Ledger
          window and its order receipt; returns a verdict record or <code>{'{verdict: null}'}</code>. No payment. This
          bounded lookup is not an archival full-chain query.
        </dd>
        <dt>
          <code>get_verdict</code>
        </dt>
        <dd>
          Required <code>chain</code>, <code>vault</code>; optional remote <code>payment</code> string. Checks menu,
          kill switch and visible post spacing, then buys a fresh judgement and waits up to its bounded timeout. Local
          mode pays NEAR; remote mode uses x402. Only invoke when you intend to buy.
        </dd>
        <dt>
          <code>order_status</code>
        </dt>
        <dd>
          Required nonnegative integer <code>order_id</code>. Reads the status and available delivered record without
          paying again. Uses the receipt when present, falling back to the desk order.
        </dd>
        <dt>
          <code>ledger</code>
        </dt>
        <dd>
          Optional <code>chain</code> and <code>limit</code> within the tool schema’s bounds. Returns public graded
          posts and scores without payment.
        </dd>
        <dt>
          <code>guardian_transactions</code>
        </dt>
        <dd>
          Required <code>action</code> (<code>deposit</code>, <code>arm</code> or <code>disarm</code>),{' '}
          <code>chain</code> (<code>base</code> or <code>monad</code>) and <code>vault</code>; <code>owner</code>,{' '}
          <code>amount_usdc</code>, <code>shares</code>, <code>min_confidence_bps</code> (8000–9900) and{' '}
          <code>max_age_s</code> (60–3600) as the action needs. Returns unsigned mainnet transactions to send in order
          from the owner’s wallet. No payment; Rein never signs or holds funds. See the{' '}
          <Link href="/docs/guardian">Guardian guide</Link>.
        </dd>
      </dl>
      <p>
        Verdict records expose <code>order_id</code>, chain, vault, verdict, confidence_bps, risk_bps, reasons,
        posted_tx, oracle, state_hash, valid_until, explorer_url and grade. Missing proof fields remain null; grade is
        null until resolution. Structured results accompany MCP text content. Tool failures can set <code>isError</code>
        ; policy refusals can instead return <code>refused</code>.
      </p>
      <h2>Local stdio: bounded spending account</h2>
      <p>
        Create a dedicated NEAR sub-account on the intended network and fund it only with what you are willing to spend,
        plus gas/storage. Use that account’s full-access key locally: a function-call access key cannot attach the
        judgement deposit. The account balance bounds exposure, not a function-call allowance. A stolen full-access key
        can drain or control this account; never use your primary wallet.
      </p>
      <p>
        Install dependencies from the clone with <code>pnpm install</code>. Keep private client configuration off
        GitHub. Never put the key in tool arguments, prompts, chat or screenshots. The placeholder below is
        intentionally invalid. <code>--silent</code> keeps pnpm’s banner off stdout, which carries the MCP protocol.
      </p>
      <pre>
        {JSON.stringify(
          {
            mcpServers: {
              rein: {
                command: 'pnpm',
                args: ['--silent', '--dir', '/absolute/path/to/rein', '--filter', 'rein-mcp', 'start'],
                env: {
                  REIN_NETWORK: 'testnet',
                  REIN_NEAR_ACCOUNT: 'agent.<your-account>.testnet',
                  REIN_NEAR_KEY: 'ed25519:<your-key>',
                  REIN_API_URL: DEPLOYMENTS.testnet.api,
                },
              },
            },
          },
          null,
          2,
        )}
      </pre>
      <p>
        <code>REIN_NETWORK</code>, <code>REIN_NEAR_ACCOUNT</code> and <code>REIN_NEAR_KEY</code> are required.{' '}
        <code>REIN_API_URL</code> is optional. Network selects the desk and unsigned NEAR RPC; changing only the API URL
        does not change the desk. Browsing never parses or uses the signing key. A purchase attaches current{' '}
        <code>price_near</code> to <code>request_judgement</code>.
      </p>
      <h2>Remote HTTP: no NEAR key</h2>
      <pre>
        {JSON.stringify(
          { mcpServers: { 'rein-remote': { type: 'http', url: `${DEPLOYMENTS.mainnet.api}/mcp` } } },
          null,
          2,
        )}
      </pre>
      <p>
        This is the mainnet URL; testnet is at <code>{`${DEPLOYMENTS.testnet.api}/mcp`}</code>. Browsing is free on
        both. Remote mode never needs or accepts your NEAR signing key. x402 purchases are mainnet-only and need a
        mainnet menu vault, not a mirror. Each POST is stateless streamable HTTP with no session ID and shares the
        quote/nudge per-IP limiter.
      </p>
      <p>
        Call <code>get_verdict</code> without payment to receive <code>{'{payment_required: true, accepts}'}</code>. Use
        an x402-capable wallet/client to obtain deposit terms, fund them yourself, and pass the base64 x402 v2 proof in{' '}
        <code>payment</code>. The <Link href="/docs/x402">x402 guide</Link> explains why the original unquoted accepted
        offer must be retained. The tool does not send deposits.
      </p>
      <h2>Pending means resume, not repurchase</h2>
      <pre>
        {
          '// Payment still settling\n{ "pending": true, "payment_ref": "<reference>", "order_id": null }\n// Order exists, but the bounded wait ended\n{ "pending": true, "order_id": 123, "status": "signed" }'
        }
      </pre>
      <p>
        For pending settlement, call <code>get_verdict</code> again with the <em>same payment</em>; do not deposit
        again. Once an order ID exists, call <code>order_status</code> with it. A purchased order is nudged once and
        then polled; clients supplying a progress token can receive status-change notifications.
      </p>
      <p>
        The desk remains authoritative if the Ledger’s spacing view lags. A delivered record may also wait for indexing.
        Missing proof data must not be turned into a claimed match.
      </p>
      <h2>Failure wording and credits</h2>
      <p>
        The current shared tool can say “refund is automatic” for rejected, refunded or post-failed orders. That wording
        describes NEAR/USDC escrow only and is not an x402 cash-refund promise. x402’s actual payment record controls
        its one-use retry credit. The MCP tool does not expose <code>redeemCredit</code>; explicit redemption uses{' '}
        <Link href="/docs/api">the raw HTTP endpoint</Link> or the buyer helper. Ordinary retries must not silently
        consume it.
      </p>
    </>
  );
}
