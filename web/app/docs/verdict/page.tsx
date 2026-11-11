import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'How a verdict is made' };

export default function VerdictDocs() {
  return (
    <>
      <h1>How a verdict is made</h1>
      <ol>
        <li>
          <strong>Open an order.</strong> The desk admits a chain/vault pair only when it is on the menu and policy
          permits it. NEAR and USDC buyers put the price in escrow; x402 settles upfront before its desk request.
        </li>
        <li>
          <strong>Read at one pinned block.</strong> The Worker pins the vault RPC reads to one block number, including
          the name and available APY/utilization. It writes the order, chain, vault, timestamp and metrics into the
          exact document the model reads. Unavailable APY is <code>na</code>, not zero.
        </li>
        <li>
          <strong>Ask for a signed answer.</strong> The Worker fetches the desk’s approved prompt and sends it with that
          document to the model in NEAR AI Cloud. The answer contains HOLD, EXIT or MOVE, confidence and adverse-outcome
          risk.
        </li>
        <li>
          <strong>Check it on NEAR.</strong> The desk verifies the answer signature, approved signer and prompt binding.
          The reading must match the order, fall between order creation and the current block time, and satisfy
          freshness policy. EXIT enters <code>exit_pending</code> and requires confirmation inside the desk’s
          confirmation window; HOLD and MOVE proceed directly to signing.
        </li>
        <li>
          <strong>Sign and post.</strong> The desk asks Chain Signatures to sign the oracle transaction. The first
          signing fixes its oracle target, gas limit and reading expiry. The Worker broadcasts it; re-signing may update
          nonce/fees but cannot extend that expiry. The oracle rejects duplicate <code>stateHash</code> values and posts
          after <code>validUntil</code>.
        </li>
        <li>
          <strong>Mark delivered.</strong> After observing a successful EVM receipt, the Worker reports delivery and the
          actual transaction fee to the desk. NEAR/USDC escrow is split only then. The receipt and Ledger can lag while
          indexing catches up.
        </li>
      </ol>
      <h2>Policy is admission, not a promise of delivery</h2>
      <p>
        Spacing prevents another judgement on the same vault too soon. Active-order checks, menu membership, caps and
        the kill switch can also refuse an order. The desk is authoritative even when the public Ledger is behind.
        Quote-time x402 admission does not reserve a slot.
      </p>
      <p>
        Signing stops at the order deadline. A kill switch stops new work and re-signing; it is not a way to revoke a
        transaction that has already been signed. The live policy, rather than a fixed value in this guide, determines
        deadlines, freshness, spacing and EXIT confirmation timing.
      </p>
      <h2>Failure and recovery</h2>
      <pre>
        {
          'open → exit_pending (EXIT only) → signing → signed → delivered\nopen / exit_pending → rejected / refunded\nsigned → post_failed / refunded'
        }
      </pre>
      <p>
        A failed Chain Signatures request restores the previous state. The Worker journals signed attempts before
        broadcast and checks receipts before recovery so an ambiguous response is not treated as a new purchase.
      </p>
      <p>
        For NEAR/USDC escrow, anyone can request a refund after an open order’s deadline, or immediately under the kill
        switch. A signed order must wait until its fixed expiry plus the desk’s deadline grace has passed; the kill
        switch cannot shorten that wait. A signing order is not publicly refundable. The agent can report a failed
        signed post, which authorizes a refund.
      </p>
      <p>
        A failed refund or split transfer remains owed, not paid. <code>claim_owed(account)</code> retries amounts owed
        in both currencies. An extended Worker outage can delay recovery. These escrow rules do not apply to{' '}
        <Link href="/docs/x402">x402’s one-use retry credit</Link>.
      </p>
      <p>
        The desk trusts the Worker’s delivery/failure and fee reports; it does not verify EVM receipt proofs. See{' '}
        <Link href="/docs/trust">Trust and limits</Link> before treating a delivered status as independent cross-chain
        proof.
      </p>
    </>
  );
}
