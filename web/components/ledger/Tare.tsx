import type { LedgerScore } from '../../../shared/score';
import { TARE_SITE } from '@/lib/tare';
import styles from './ledger.module.css';

const brier = (s: LedgerScore) => (s.brier === null ? '–' : s.brier.toFixed(3));

/**
 * Rein next to Tare, an older oracle on the same vaults. Tare's numbers come from its own API: its posts are not
 * signed by a TEE, so Rein can't check them the way it checks its own.
 */
export function TareComparison({ tare, rein }: { tare: LedgerScore | null; rein: LedgerScore }) {
  if (!tare) return null;
  const rows: { name: string; note: string; s: LedgerScore }[] = [
    { name: 'Rein', note: 'TEE-signed, checked by the desk', s: rein },
    { name: 'Tare · Jev, not signature-checked', note: 'From Tare’s public API', s: tare },
  ];
  return (
    <figure className={styles.panel}>
      <figcaption className={styles.panelHead}>
        <span className={styles.panelTitle}>Next to Tare</span>
        <span className="label">Mainnet, resolved calls</span>
      </figcaption>
      <table className={styles.compare}>
        <thead>
          <tr><th scope="col">Oracle</th><th scope="col" className={styles.right}>Resolved</th><th scope="col" className={styles.right}>Brier</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">{r.name}<small>{r.note}{r.s.early && ' · early data'}</small></th>
              <td className={styles.right}>{r.s.n}</td>
              <td className={styles.right}>{brier(r.s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.note}>
        Lower Brier is better. Tare grades the same way, but its scores aren’t verified here.{' '}
        <a href={TARE_SITE} target="_blank" rel="noreferrer">Tare ↗</a>
      </p>
    </figure>
  );
}
