import type { Metadata } from 'next';
import Link from 'next/link';
import { readDesk } from '@/lib/desk';
import { publicConfig } from '@/lib/config';
import { amount, duration } from '@/lib/format';

export const metadata: Metadata = { title: 'Judge a vault' };

export default async function JudgeDocs() {
  const [desk, cfg] = await Promise.all([readDesk(), publicConfig()]);
  return (
    <>
      <h1>Judge a vault</h1>
      <p>
        Open <Link href="/judge">Judge</Link>, choose the NEAR network and a supported EVM vault, and read the current
        policy before paying. A judgement buys a new oracle post, not a deposit, withdrawal or continuous monitoring
        subscription. Mainnet purchasing must wait until deployment; testnet mirror vaults use test assets.
      </p>
      <h2>Price and admission</h2>
      {desk ? (
        <>
          <p>
            {cfg.sample ? 'Sample policy—not a live quote' : `Desk policy on ${cfg.network}`}:{' '}
            <strong>{amount(desk.policy.price_near, 24)} NEAR</strong> or{' '}
            <strong>{amount(desk.policy.price_usdc, 6)} USDC</strong> per judgement.{' '}
            {desk.policy.usdc_token ? 'USDC payments are configured.' : 'USDC payments are off.'}{' '}
            {desk.policy.kill ? 'The kill switch is on; new orders are refused.' : 'The kill switch is off.'}
          </p>
          <p>
            Spacing: {duration(desk.policy.spacing_s)}. Signing deadline: {duration(desk.policy.deadline_s)}. Reading
            freshness: {duration(desk.policy.doc_max_age_s)}. EXIT confirmation:{' '}
            {duration(desk.policy.exit_confirm_min_s)} to {duration(desk.policy.exit_confirm_max_s)} after the first
            reading.
          </p>
        </>
      ) : (
        <p>
          Current policy is unreadable; see the <Link href="/judge">Judge page</Link> for current prices and
          availability. No fixed price is promised here.
        </p>
      )}
      <p>
        The menu, current open order, spacing, caps and kill switch decide admission. Prices above are a read, not a
        reservation; the desk checks the policy at submission. Keep additional NEAR for gas and storage.
      </p>
      <h2>Pay with NEAR</h2>
      <p>
        Connect a NEAR wallet on the selected network. The purchase calls <code>request_judgement</code> with the chosen{' '}
        <code>chain</code> and <code>vault</code>, attaching the current <code>price_near</code> in yoctoNEAR. Confirm
        the desk account and amount in your wallet. Keep the returned order ID and follow its receipt rather than paying
        again while it is pending.
      </p>
      <h2>Pay with USDC on NEAR</h2>
      <p>
        Use the policy’s configured USDC token on the same NEAR network, with enough token balance and required token
        storage registration. The wallet calls that token’s <code>ft_transfer_call</code>: <code>receiver_id</code> is
        the desk, <code>amount</code> is current <code>price_usdc</code> in token base units, and <code>msg</code> is
        JSON containing <code>chain</code> and <code>vault</code>. Sending tokens with an ordinary transfer does not
        create an order.
      </p>
      <p>
        These two paths escrow payment in the desk until delivery. Failed posts authorize refunds; failed payout
        transfers remain owed. See the <Link href="/docs/verdict">lifecycle and refund rules</Link>.
      </p>
      <h2>Top up from another chain</h2>
      <p>
        The Judge page can quote mainnet USDC from Base, Monad, Ethereum, Arbitrum or Solana into the connected NEAR
        account. Requesting a deposit address does not sign or send funds. Check the asset, amount, recipient, refund
        terms and expiry, then send the quoted funds yourself on the selected origin chain.
      </p>
      <p>
        Wait for USDC to arrive on NEAR, then separately pay the desk with <code>ft_transfer_call</code>. A top-up is
        not an order payment. Editing quote inputs discards the displayed address. Sample mode disables quotes; testnet
        top-up cannot turn mainnet money into testnet payment.
      </p>
      <h2>Pay through x402</h2>
      <p>
        An agent can use <Link href="/docs/mcp">remote MCP</Link> or <Link href="/docs/api">the HTTP API</Link> without
        a NEAR signing key. x402 is mainnet-only and settles before judgement. It is not escrow: a paid judgement
        failure leaves a one-use replacement credit, not a cash refund. Read the{' '}
        <Link href="/docs/x402">full payment flow</Link> before depositing.
      </p>
      <h2>After buying</h2>
      <p>
        My orders lists the connected NEAR payer’s orders. An order receipt shows progress and the available proof
        chain. EXIT alerts, when enabled and permitted by the browser, notify a subscriber of a posted EXIT; they do not
        move funds or prove an exit occurred. Automatic exits require a separate{' '}
        <Link href="/docs/guardian">Guardian opt-in</Link>.
      </p>
    </>
  );
}
