import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Trust and limits' };

export default function TrustDocs() {
  return (
    <>
      <h1>Trust and limits</h1>
      <p>
        Rein makes a judgement inspectable and grades a defined outcome. It does not prove that a vault is safe,
        eliminate operator trust or guarantee an exit. Mainnet is live on Monad and Base; each receipt links the onchain
        records it relies on, so check those rather than this page.
      </p>
      <h2>What is enforced</h2>
      <ul>
        <li>
          The NEAR desk enforces its current admission policy, approved prompt/signer checks, document order binding,
          freshness and signing deadline.
        </li>
        <li>
          Chain Signatures signs the transaction requested by the desk; the model answer’s signature is a separate
          check.
        </li>
        <li>
          The EVM oracle accepts only its authorized attester, rejects an expired post and rejects a second post for the
          same document hash.
        </li>
        <li>
          Onchain grading records the defined price/assets/liquidity/broken-read outcome after its windows. It is not a
          general audit of the vault.
        </li>
        <li>
          Guardian enforces the owner’s enabled rule, latest EXIT confidence/age and verdict floor, and pays the owner
          rather than a caller-selected address.
        </li>
        <li>
          x402 stores settlement and attempt identity so ordinary retries do not create another charge or judgement. Its
          replacement credit is explicit and one-use.
        </li>
      </ul>
      <h2>What remains trusted</h2>
      <dl>
        <dt>RPC state and availability</dt>
        <dd>
          Pinning reads to a block makes a reading internally consistent; it does not authenticate a dishonest RPC. RPC
          outages or incomplete receipt visibility can delay posting, refunds, indexing and exits. The input checker
          covers only metrics represented in oracle snapshots, not every document field.
        </dd>
        <dt>Model reasoning</dt>
        <dd>
          A signed answer authenticates its source and binding, not the correctness of its judgement. Confidence is not
          calibrated accuracy. An allowed signer and approved prompt can still produce a bad answer.
        </dd>
        <dt>Desk/oracle administration</dt>
        <dd>
          Owners control policy, menus and approved signers; the oracle owner can change its attester. Guardian
          administration controls approved vaults. Review these authorities rather than treating deployment as
          immutability of every setting.
        </dd>
        <dt>Worker reports and database</dt>
        <dd>
          The desk trusts the agent’s EVM delivery/failure reports and reported fees; it does not verify EVM receipt
          proofs. API documents, signer records, post links, costs and local sample counts are mirrored data. A receipt
          link is useful evidence, not a proof that the database is complete.
        </dd>
        <dt>Cross-chain recovery</dt>
        <dd>
          A post could land but remain unreported during an extended Worker outage. After expiry plus grace, the public
          desk refund path can allow both a delivered post and a refund. Worker recovery reduces this risk using RPC
          receipts/state, not cryptographic cross-chain proofs.
        </dd>
        <dt>Payment provider</dt>
        <dd>
          x402 relies on the facilitator and swap route. Settlement is upfront, not escrow. A paid judgement failure
          earns a replacement credit, not money back. Swap failure refunds/fees follow provider terms and still need
          live confirmation.
        </dd>
      </dl>
      <h2>The receipt is deliberately narrower</h2>
      <p>
        The local document check hashes stored bytes. The signer check uses the <em>current</em> signer allowlist, not
        historical membership. The page does not verify the model signature, TEE attestation, transaction signer or
        receipt inclusion proof. Missing data stays unknown. See{' '}
        <Link href="/docs/receipts">each verification step</Link>.
      </p>
      <h2>Grades and economic claims have limits</h2>
      <p>
        Worst-value sampling observes submitted readings, not continuous vault history. Thin sampling can miss a short
        event; a transient distorted reading can worsen a grade. Asset outflows can trigger adverse without a
        share-price loss. A clean outcome does not establish that all risks were absent.
      </p>
      <p>
        Count-once scoring reduces repeated-signal inflation, but small samples and hindsight baselines do not establish
        predictive power. Public recent-post windows are not full-history datasets. Cost totals can be incomplete,
        unknown credits/cash costs stay null, and positive partial currency margin does not imply positive profit after
        native gas or automatic gas replenishment.
      </p>
      <h2>Opt-in is not guaranteed protection</h2>
      <p>
        Guardian requires approvals, an enabled rule, usable liquidity, live chain/RPC access and a caller with gas.
        Partial exits can leave shares behind; stale or superseded EXITs cannot authorize later retries. MOVE only
        quotes a route the user must fund. Rein never takes custody of the vault position or exit proceeds, but that
        does not make the underlying vault or swap risk-free.
      </p>
      <p>
        Use <Link href="/docs/judge">Judge</Link> to check current policy and{' '}
        <Link href="/docs/ledger">Ledger and grading</Link> to interpret the record before acting on it.
      </p>
    </>
  );
}
