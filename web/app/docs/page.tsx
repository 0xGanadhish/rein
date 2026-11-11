import Link from 'next/link';
import { DEPLOYMENTS } from '../../../shared/deployments';
import { DOC_PAGES } from '@/components/docs/navigation';
import styles from '@/components/docs/docs.module.css';

export default function DocsOverview() {
  return (
    <>
      <p className="label">Rein / Documentation</p>
      <h1>A risk desk with a public record.</h1>
      <p>
        Rein sells a fresh HOLD, EXIT or MOVE judgement on a supported yield vault. A buyer pays a NEAR desk, a model in
        NEAR AI Cloud signs its answer, and the desk verifies that answer before requesting an EVM transaction through
        Chain Signatures. The verdict lands in Rein’s oracle on Monad or Base, where later vault readings grade the
        outcome. It is a risk signal, not a guarantee or custody service.
      </p>
      <p>
        Start with the visual <Link href="/how">How it works</Link> walkthrough, then use these pages for the contracts,
        payment flows and verification boundaries.
      </p>
      <h2>Who does what</h2>
      <dl>
        <dt>Buyer</dt>
        <dd>Chooses a vault from the desk’s menu and buys a judgement. Buying does not move a vault position.</dd>
        <dt>NEAR desk contract</dt>
        <dd>
          Enforces admission and timing, checks the signed model answer against its approved prompt and signers, manages
          NEAR/USDC escrow, and requests a signature for the oracle transaction.
        </dd>
        <dt>Worker</dt>
        <dd>
          Reads vault state, constructs the document, calls the model, advances orders, broadcasts signed transactions
          and mirrors outcomes into the public API. It also schedules grading, watch work, alerts and configured
          Guardian exits.
        </dd>
        <dt>Model in NEAR AI Cloud</dt>
        <dd>
          Returns a signed judgement over the prompt and document. Its signature authenticates the answer; it does not
          establish that the forecast is correct.
        </dd>
        <dt>Chain Signatures</dt>
        <dd>Signs the EVM transaction requested by the desk. It is distinct from the model’s answer signature.</dd>
        <dt>EVM oracle</dt>
        <dd>
          Accepts posts from the authorized attester, rejects repeated document hashes and expired posts, snapshots
          vault metrics and records later grades.
        </dd>
      </dl>
      <h2>Networks and availability</h2>
      <p>
        Mainnet is not deployed yet. Configured mainnet account names and URLs are deployment targets, not evidence of a
        working service. Testnet mirror vaults are demonstrations, not mainnet positions.
      </p>
      {(['testnet', 'mainnet'] as const).map((network) => (
        <section key={network}>
          <h3>{network}</h3>
          <p>
            Desk: <code>{DEPLOYMENTS[network].desk ?? 'after the mainnet deploy'}</code>
            <br />
            Worker: <code>{DEPLOYMENTS[network].api}</code>
          </p>
          <ul>
            {Object.entries(DEPLOYMENTS[network].oracles).map(([chain, oracle]) => (
              <li key={chain}>
                {chain}: <code>{oracle ?? 'after the mainnet deploy'}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <h2>Read the docs</h2>
      <ul className={styles.index}>
        {DOC_PAGES.filter((page) => page.href !== '/docs').map((page) => (
          <li key={page.href}>
            <Link href={page.href}>{page.title}</Link>
            <p>{page.description}</p>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/docs">Overview</Link> is the index for every topic. Ready to explore actual data? Open the{' '}
        <Link href="/ledger">Ledger</Link> or <Link href="/judge">Judge page</Link>.
      </p>
    </>
  );
}
