import type { Metadata } from 'next';
import Link from 'next/link';
import { RESOLVE_WINDOW_S, SAMPLE_WINDOW_S } from '../../../../worker/src/vendor/cadence';
import { EARLY_BELOW, REPEAT_WINDOW_S } from '../../../../shared/score';
import { duration } from '@/lib/format';

export const metadata: Metadata = { title: 'Ledger and grading' };

export default function LedgerDocs() {
  return (
    <>
      <h1>Ledger and grading</h1>
      <p>
        The <Link href="/ledger">Ledger</Link> separates a model’s forecast from the vault outcome recorded later
        onchain. Confidence expresses the model’s conviction in its verdict; risk is its probability of an adverse
        outcome. Neither is measured accuracy by itself.
      </p>
      <h2>When a post can be graded</h2>
      <p>
        The oracle snapshots share price, total assets and available withdrawable liquidity when a post lands. After the
        resolve window, anyone can sample during the sampling window. Resolution waits until both windows have elapsed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Chain</th>
            <th>Resolve window</th>
            <th>Sampling window</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(RESOLVE_WINDOW_S).map(([chain, seconds]) => (
            <tr key={chain}>
              <td>{chain}</td>
              <td>{duration(seconds)}</td>
              <td>
                {SAMPLE_WINDOW_S[chain as keyof typeof SAMPLE_WINDOW_S] === 0
                  ? 'No sampling window'
                  : duration(SAMPLE_WINDOW_S[chain as keyof typeof SAMPLE_WINDOW_S])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>These are the configured chain windows. The deployed oracle’s immutable window values are authoritative.</p>
      <p>
        Sampling keeps the lowest observed share price, assets and liquidity ratio independently, not a single
        best-looking snapshot. A failed metrics read marks the sample broken. If nobody samples, resolution takes a
        reading then; no-sampling testnets also use a resolution-time read. Worst-value sampling makes transient bad
        readings capable of worsening a grade, including readings distorted by a flash loan. It does not reconstruct
        everything between samples.
      </p>
      <h2>Adverse outcomes and reason bits</h2>
      <p>
        An outcome is adverse if any reason is set. The oracle compares price and assets against their post-time
        snapshots using its configured drop thresholds, and liquidity against its floor. The liquidity condition is used
        only when a vault has an adapter.
      </p>
      <dl>
        <dt>REASON_PPS</dt>
        <dd>Share price fell beyond the allowed drop.</dd>
        <dt>REASON_TVL</dt>
        <dd>
          Total assets fell beyond the allowed drop; this can include withdrawals and is not necessarily a depositor
          loss.
        </dd>
        <dt>REASON_LIQ</dt>
        <dd>Withdrawable liquidity is below the floor as a fraction of total assets.</dd>
        <dt>REASON_BROKEN</dt>
        <dd>
          A vault or adapter metrics read failed. The contract guards against deliberately starving that read of gas.
        </dd>
      </dl>
      <p>
        Reasons form a bitmask, so several can apply. The receipt decodes the labels. A clean grade means none of these
        measured conditions fired, not that the vault was safe in every respect.
      </p>
      <h2>Repeated posts count once</h2>
      <p>
        On the same chain and vault, a post with the same verdict as the previous post less than{' '}
        {duration(REPEAT_WINDOW_S)} later is a repeat. Each post updates the previous-post clock, so a continuous burst
        still counts as one call. A changed verdict or a gap at least that long starts a new call. Posts remain visible
        even when excluded from scoring.
      </p>
      <h2>Brier error and confidence bands</h2>
      <p>
        For resolved, non-repeat calls, the mean Brier error is <code>mean((risk_bps / 10000 − adverse)²)</code>, where
        adverse is one for an adverse outcome and zero otherwise. Lower is better. No resolved calls means no score, not
        a perfect zero. Fewer than {EARLY_BELOW} resolved calls is marked early data.
      </p>
      <p>
        Confidence-band hit rates count EXIT as a hit when the outcome is adverse, and HOLD/MOVE as hits when it is
        clean. The running Brier chart adds resolved calls in resolution order; historical grades without a known
        resolution timestamp cannot supply a chart timestamp.
      </p>
      <p>
        Quality flags are separate from the outcome: unresolved means grading is due, late means the recorded resolution
        missed the due-time tolerance, and degraded means too few locally observed samples on a sampling chain. Unknown
        historical timing stays unknown. A local sample count can miss samples submitted by others.
      </p>
      <h2>Compare with simple forecasts</h2>
      <pre>
        {
          'pnpm baseline --check\npnpm baseline scripts/fixtures/baseline-sample.json\npnpm baseline <worker-url>/v1/ledger'
        }
      </pre>
      <p>
        The baseline script compares Rein with a coin forecast, the observed adverse base rate and a
        utilization/liquidity rule using the same resolved non-repeat calls. The base rate is hindsight, not an
        out-of-sample prediction. The rule does not use APY, and unavailable inputs are not invented. Missing required
        fields fail explicitly.
      </p>
      <p>
        The public Ledger’s recent-post list is bounded. Baseline comparison over that list is not a full-history
        evaluation or proof of calibration. Ledger revenue is delivery-only; x402 payments awaiting judgement or an
        unused credit remain liabilities, not earned revenue. Native gas is not silently valued at zero, and a partial
        currency margin is not proof that the desk funds itself.
      </p>
    </>
  );
}
