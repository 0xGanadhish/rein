import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Verify a receipt' };

export default function ReceiptDocs() {
  return (
    <>
      <h1>Verify a receipt</h1>
      <p>
        Open <code>/orders/&lt;order_id&gt;</code> on the matching network, or select a receipt from{' '}
        <Link href="/orders">My orders</Link>. “Verify this order” is a chain of available evidence, not an end-to-end
        cryptographic verifier. Missing stages remain absent while an order is in flight or its data has not been
        indexed.
      </p>
      <ol>
        <li>
          <strong>Order on the NEAR desk.</strong> Links to the configured desk account and identifies the order. It is
          an inspection link, not a local proof of every NEAR state transition. The receipt prefers the desk’s current
          order status when readable; its other data comes from the Worker mirror.
        </li>
        <li>
          <strong>Reading document.</strong> Computes Keccak-256 of the stored document’s exact UTF-8 bytes and compares
          it with the stored <code>state_hash</code>. Matching bytes bind the document to that hash. They do not prove
          that the RPC readings are true, that the model saw it, or that the hash itself was independently obtained from
          the chain.
        </li>
        <li>
          <strong>Model signer.</strong> Compares the latest successful recorded model-call signing address with the
          desk’s current <code>signers()</code> list, ignoring address case. An unreadable list leaves the check
          unknown, not passed. It does not verify the answer’s signature, TEE attestation or signer membership at the
          historical time of judgement.
        </li>
        <li>
          <strong>Chain Signatures post.</strong> Shows the desk-derived signer address when readable and links to the
          recorded EVM transaction. The receipt does not locally recover the transaction signer or verify a receipt
          inclusion proof. Inspect the explorer and oracle independently.
        </li>
        <li>
          <strong>Grade.</strong> Once resolved, shows adverse or clean and the reason labels supplied by the mirrored
          post. This displays a recorded grade; it does not rerun the oracle’s metrics reads or establish forecast
          correctness beyond the defined grading rules.
        </li>
      </ol>
      <h2>Read status precisely</h2>
      <p>
        <code>signed</code> means a transaction is available, not that it landed. <code>delivered</code> means the
        Worker reported delivery to the desk. A missing post transaction, document or grade remains unknown rather than
        being fabricated. EXIT may include an extra confirmation step; extra model calls alone do not prove that step
        occurred.
      </p>
      <p>
        Refunded, rejected and post-failed orders stop the happy-path progress display. An authorized refund is not
        proof that its transfer succeeded. For an x402 purchase, those statuses concern the judgement attempt: the
        payment can instead leave a <Link href="/docs/x402">retry credit</Link>, not a NEAR escrow refund.
      </p>
      <h2>Independent inspection</h2>
      <p>
        Use the NEAR desk view, EVM transaction and oracle’s post/resolution state together. The local checks help
        detect inconsistent stored bytes or a signer absent from today’s allowlist. They cannot replace independent
        RPCs, historical state, signature verification or a TEE attestation review. See{' '}
        <Link href="/docs/trust">Trust and limits</Link>.
      </p>
    </>
  );
}
