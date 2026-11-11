import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { BrierChart } from '@/components/ledger/BrierChart';
import { Calls } from '@/components/ledger/Calls';
import { Books, Calibration, Kpis } from '@/components/ledger/Summary';
import { TareComparison } from '@/components/ledger/Tare';
import styles from '@/components/ledger/ledger.module.css';
import { readDesk } from '@/lib/desk';
import { publicConfig } from '@/lib/config';
import { readBrier, readLedger, type Network } from '@/lib/ledger';
import { readTareScore } from '@/lib/tare';

export const metadata: Metadata = { title: 'Ledger' };

const NETWORK_LABEL: Record<Network, string> = {
  mainnet: 'Base, Monad',
  testnet: 'Monad testnet, Base Sepolia',
};

export default async function LedgerPage() {
  const [result, desk, cfg, brier] = await Promise.all([readLedger(), readDesk(), publicConfig(), readBrier()]);
  const network = cfg.network;
  // Tare runs on mainnet only, so it's compared with Rein's mainnet calls.
  const tare = network === 'mainnet' ? await readTareScore() : null;

  return (
    <>
      <Header active="ledger" />
      <main className="container" style={{ paddingTop: 'clamp(24px, 3vw, 36px)', paddingBottom: 80 }}>
        <div className={styles.head}>
          <h1 className={styles.title}>Every call, graded.</h1>
          <p className={styles.where}>{NETWORK_LABEL[network]}</p>
          {result.ok && result.sample && <p className={styles.sample}>Sample data</p>}
        </div>

        {result.ok ? (
          <>
            <Kpis ledger={result.ledger} />
            <div className={styles.panels}>
              <Calibration score={result.ledger.score} />
              {brier && <BrierChart points={brier} />}
              <Books business={result.ledger.business} kill={desk?.policy.kill ?? null} />
              <TareComparison tare={tare} rein={result.ledger.score} />
            </div>
            <Calls posts={result.ledger.recent} />
          </>
        ) : (
          <div className={styles.error} role="alert">
            <h2>The Ledger can’t reach the desk right now.</h2>
            <p>
              {result.error} Every call is still onchain on the Rein oracle; this page will catch up once the desk
              answers.
            </p>
          </div>
        )}

        <section className={styles.method} aria-label="How calls are graded">
          <div>
            <h2>How a call is graded</h2>
            <p>
              After a fixed window the oracle reads the vault again and keeps the worst reading. The outcome is adverse
              if, against the moment of the call, the share price fell more than 0.5%, total assets fell more than 20%,
              withdrawable liquidity was under 5%, or the vault’s reads failed.
            </p>
          </div>
          <div>
            <h2>How the score works</h2>
            <p>
              A hit is an EXIT followed by an adverse outcome, or a HOLD or MOVE followed by none. The Brier score
              compares each call’s stated risk with what happened. Below 30 resolved calls the score is early data.
            </p>
          </div>
        </section>
      </main>
    </>
  );
}
