'use client';

import { useState } from 'react';
import { isHit, type ScoreVerdict } from '../../../shared/score';
import { bpsPct, reasonLabels, utcStamp } from '@/lib/format';
import type { LedgerPost } from '@/lib/ledger';
import { useNewKeys } from '@/components/useNewKeys';
import { shortAddress, vaultName } from '@/lib/vaults';
import styles from './ledger.module.css';

/** Rows shown per page of the table. */
const PAGE = 30;
const FILTERS: (ScoreVerdict | 'All')[] = ['All', 'HOLD', 'EXIT', 'MOVE'];

function Outcome({ post }: { post: LedgerPost }) {
  if (!post.resolved || post.adverse === null) {
    return (
      <span className={styles.outcome}>
        <span className={styles.dot} data-state="wait" />
        Resolving
      </span>
    );
  }
  const reasons = reasonLabels(post.reasons);
  return (
    <span className={styles.outcome}>
      <span
        className={styles.dot}
        data-state={isHit(post) ? 'hit' : 'miss'}
        aria-label={isHit(post) ? 'Hit' : 'Miss'}
        role="img"
      />
      {post.adverse ? (
        <span className={styles.adverse} title={reasons.join(', ')}>
          Adverse{reasons.length > 0 && `: ${reasons.join(', ')}`}
        </span>
      ) : (
        'Clean'
      )}
    </span>
  );
}

export function Calls({ posts }: { posts: LedgerPost[] }) {
  const [verdict, setVerdict] = useState<(typeof FILTERS)[number]>('All');
  const [repeats, setRepeats] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const matching = posts.filter((p) => (verdict === 'All' || p.verdict === verdict) && (repeats || !p.repeat));
  const shown = matching.slice(0, limit);
  const fresh = useNewKeys(posts.map((p) => `${p.chain}:${p.id}`));

  return (
    <section className={styles.calls} aria-labelledby="calls">
      <div className={styles.callsHead}>
        <h2 id="calls" className={styles.callsTitle}>
          Recent calls
        </h2>
        <div className={styles.filters}>
          <div role="group" aria-label="Verdict" className={styles.seg}>
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                className={styles.segItem}
                aria-pressed={verdict === f}
                onClick={() => {
                  setVerdict(f);
                  setLimit(PAGE);
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={repeats}
              onChange={(e) => {
                setRepeats(e.target.checked);
                setLimit(PAGE);
              }}
            />
            Show repeats
          </label>
        </div>
      </div>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">POSTED (UTC)</th>
              <th scope="col">VAULT</th>
              <th scope="col">CALL</th>
              <th scope="col" className={styles.right}>
                CONF
              </th>
              <th scope="col" className={styles.right}>
                RISK
              </th>
              <th scope="col">SIGNED READING</th>
              <th scope="col">INPUT</th>
              <th scope="col">OUTCOME</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr
                key={`${p.chain}:${p.id}`}
                data-post={p.id}
                data-repeat={p.repeat || undefined}
                data-new={fresh.has(`${p.chain}:${p.id}`) || undefined}
                data-mismatch={p.input_check === 'mismatch' || undefined}
              >
                <td className={styles.cellMono}>
                  {utcStamp(p.posted_at)}
                  <span className={styles.sub}>
                    {p.chain} · #{p.id}
                    {p.order_id !== null && ` · order ${p.order_id}`}
                  </span>
                </td>
                <td>
                  <span className={styles.vault}>{vaultName(p.chain, p.vault)}</span>
                  <span className={styles.sub}>
                    {shortAddress(p.vault)}
                    {p.repeat && ' · repeat'}
                  </span>
                </td>
                <td>
                  <span className="chip" data-verdict={p.verdict}>
                    {p.verdict}
                  </span>
                </td>
                <td className={`${styles.cellMono} ${styles.right}`}>{bpsPct(p.confidence_bps)}</td>
                <td className={`${styles.cellMono} ${styles.right}`}>{bpsPct(p.risk_bps)}</td>
                <td className={styles.cellMono}>
                  {p.signer ? (
                    <span title={p.signer}>signer {shortAddress(p.signer)}</span>
                  ) : (
                    <span className={styles.unknown}>signer unknown</span>
                  )}
                  {p.doc && (
                    <details className={styles.doc}>
                      <summary>What the model read</summary>
                      <code>{p.doc}</code>
                    </details>
                  )}
                </td>
                <td
                  className={`${styles.cellMono} ${p.input_check === 'mismatch' ? styles.mismatch : p.input_check === 'unknown' ? styles.unknown : ''}`}
                >
                  {p.input_check === 'mismatch' ? (
                    <span title="The doc the model read doesn't match the vault state the oracle recorded with the post.">
                      ⚠ Input mismatch
                    </span>
                  ) : (
                    p.input_check
                  )}
                </td>
                <td>
                  <Outcome post={p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className={styles.empty}>
            {posts.length === 0 ? 'No calls posted yet.' : 'No calls match these filters.'}
          </p>
        )}
      </div>
      {matching.length > shown.length && (
        <button type="button" className={styles.more} onClick={() => setLimit(limit + PAGE)}>
          Show {Math.min(PAGE, matching.length - shown.length)} more of {matching.length - shown.length}
        </button>
      )}

      <div className={styles.foot}>
        <span>
          <span className={styles.dot} data-state="hit" />
          Hit
        </span>
        <span>
          <span className={styles.dot} data-state="miss" />
          Miss
        </span>
        <span>
          <span className={styles.dot} data-state="wait" />
          Resolving
        </span>
        <span>Faded rows repeat the call before them and aren’t scored.</span>
      </div>
    </section>
  );
}
