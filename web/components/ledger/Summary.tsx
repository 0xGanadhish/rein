import type { LedgerScore } from '../../../shared/score';
import { units, pct, utcStamp } from '@/lib/format';
import type { Ledger } from '@/lib/ledger';
import styles from './ledger.module.css';

/** Below this many resolved calls a band is too thin to read anything into. */
const THIN_BAND = 5;

/** Where a perfectly calibrated hit rate falls for each confidence band, in percent. */
const TARGET: Record<string, { lo: number | null; hi: number }> = {
  '<80': { lo: null, hi: 80 },
  '80-89': { lo: 80, hi: 90 },
  '90-94': { lo: 90, hi: 95 },
  '95-100': { lo: 95, hi: 100 },
};

const hitRate = (score: LedgerScore) => {
  const n = score.bands.reduce((s, b) => s + b.n, 0);
  return n === 0 ? null : score.bands.reduce((s, b) => s + (b.hitRate ?? 0) * b.n, 0) / n;
};

export function Kpis({ ledger }: { ledger: Ledger }) {
  const { score, input_checks: ic } = ledger;
  const checked = ic.match + ic.mismatch + ic.unknown;
  return (
    <div className={styles.kpis}>
      <div className={styles.kpi}>
        <div className="label">Brier score</div>
        <div className={styles.big}>
          <span className={styles.num}>{score.brier === null ? '–' : score.brier.toFixed(3)}</span>
          {score.early && <span className={styles.badge}>Early data</span>}
        </div>
        <p className={styles.note}>Lower is better. 0 is perfect, 0.25 is a coin flip.</p>
      </div>
      <div className={styles.kpi}>
        <div className="label">Resolved calls</div>
        <div className={styles.big}>
          <span className={styles.num}>{score.n}</span>
          <span className={styles.aside}>of {ledger.calls} calls</span>
        </div>
        <p className={styles.note}>{ledger.posts} posts. Repeats within an hour count once.</p>
      </div>
      <div className={styles.kpi}>
        <div className="label">Hit rate</div>
        <div className={styles.big}>
          <span className={styles.num}>{pct(hitRate(score))}</span>
        </div>
        <p className={styles.note}>An EXIT followed by trouble, or a HOLD or MOVE followed by none.</p>
      </div>
      <div className={styles.kpi}>
        <div className="label">Input check</div>
        <div
          className={styles.inputBar}
          role="img"
          aria-label={`${ic.match} match, ${ic.mismatch} mismatch, ${ic.unknown} unknown`}
        >
          {checked > 0 && (
            <>
              <span style={{ flex: ic.match }} />
              <span style={{ flex: ic.mismatch }} />
              <span style={{ flex: ic.unknown }} />
            </>
          )}
        </div>
        <div className={styles.inputLegend}>
          <span>{ic.match} match</span>
          <span className={styles.mismatch}>{ic.mismatch} mismatch</span>
          <span className={styles.unknown}>{ic.unknown} unknown</span>
        </div>
        <p className={styles.note}>Each reading re-checked against the chain.</p>
      </div>
    </div>
  );
}

/** `tone="night"` draws it for the dark Ledger band on the landing page. */
export function Calibration({ score, tone }: { score: LedgerScore; tone?: 'night' }) {
  return (
    <figure className={styles.panel} data-tone={tone}>
      <figcaption className={styles.panelHead}>
        <span className={styles.panelTitle}>Calibration</span>
        <span className="label">Hit rate by stated confidence</span>
      </figcaption>
      <div className={styles.plot}>
        {score.bands.map((b, i) => {
          const t = TARGET[b.band];
          const thin = b.n < THIN_BAND;
          const hit = b.hitRate === null ? 0 : b.hitRate * 100;
          return (
            <div key={b.band} className={styles.col}>
              {t.lo === null ? (
                <div className={styles.ceiling} style={{ bottom: `${t.hi}%` }} />
              ) : (
                <div className={styles.zone} style={{ bottom: `${t.lo}%`, height: `${t.hi - t.lo}%` }} />
              )}
              <div
                className={styles.bar}
                data-thin={thin || undefined}
                data-empty={b.hitRate === null || undefined}
                style={{ height: `${hit}%`, animationDelay: `${0.25 + i * 0.08}s` }}
              >
                <span className={styles.barValue}>{b.hitRate === null ? '–' : `${Math.round(hit)}%`}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.axis}>
        {score.bands.map((b) => (
          <div key={b.band}>
            {b.band.replace('-', '–')}%<small>{b.n < THIN_BAND ? `n=${b.n} · too few` : `n=${b.n}`}</small>
          </div>
        ))}
      </div>
      <div className={styles.legend}>
        <span>
          <span className={styles.swatch} />
          Hit rate
        </span>
        <span>
          <span className={styles.swatchZone} />
          Where a calibrated desk lands
        </span>
      </div>
    </figure>
  );
}

const NATIVE: Record<string, string> = { monad: 'MON', 'monad-testnet': 'MON', base: 'ETH', 'base-sepolia': 'ETH' };
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

/** The desk's money: what customers paid, what counts as revenue (at delivery), what went back, and what's still owed. */
export function Books({ business, kill }: { business: Ledger['business']; kill: boolean | null }) {
  const d = business.desk;
  const owed = business.unpaid_liabilities;
  const gas = Object.entries(business.gas_per_chain);
  return (
    <section className={styles.panel} aria-labelledby="books">
      <div className={styles.panelHead}>
        <h2 id="books" className={styles.panelTitle} style={{ margin: 0, fontSize: 'inherit' }}>
          The desk’s books
        </h2>
        <span className="label">{d ? `As of ${utcStamp(d.as_of)} UTC` : 'Not read yet'}</span>
      </div>
      {d ? (
        <dl className={styles.books}>
          <div>
            <dt>Paid by customers</dt>
            <dd>
              {units(d.sales_near, 24)} NEAR · {units(d.sales_usdc, 6)} USDC
              <small>Includes orders later refunded</small>
            </dd>
          </div>
          <div>
            <dt>Revenue at delivery</dt>
            <dd>
              {units(business.settled_revenue.near, 24)} NEAR · {units(business.settled_revenue.usdc, 6)} USDC · x402{' '}
              {units(business.settled_revenue.x402_usdc, 6)} USDC
            </dd>
          </div>
          <div>
            <dt>Split, treasury / agent</dt>
            <dd>
              {units(d.paid_treasury.usdc, 6)} / {units(d.paid_agent.usdc, 6)} USDC
              <small>
                {units(d.paid_treasury.near, 24)} / {units(d.paid_agent.near, 24)} NEAR
              </small>
            </dd>
          </div>
          <div>
            <dt>Refunds authorized</dt>
            <dd>{business.refunds.authorized_orders}</dd>
          </div>
          {owed.usdc !== null && owed.near !== null && (
            <div>
              <dt>Owed, not yet transferred</dt>
              <dd>
                {units(owed.usdc, 6)} USDC · {units(owed.near, 24)} NEAR
                <small>Failed refunds and splits, claimable with claim_owed</small>
              </dd>
            </div>
          )}
          <div>
            <dt>x402, not yet settled</dt>
            <dd>{units(business.x402_unsettled_usdc, 6)} USDC</dd>
          </div>
          <div>
            <dt>x402 credits, not yet redeemed</dt>
            <dd>
              {units(owed.x402_credit_usdc, 6)} USDC
              <small>Each buys one free judgement after a failed post; no money moves back</small>
            </dd>
          </div>
          <div>
            <dt>Paid orders still open</dt>
            <dd>{d.open_paid}</dd>
          </div>
          <div>
            <dt>Watch orders</dt>
            <dd>
              {d.watch_orders}
              <small>{business.watch.asked} asked for</small>
            </dd>
          </div>
          <div>
            <dt>Model calls</dt>
            <dd>{business.judge_calls}</dd>
          </div>
          <div>
            <dt>Model cost</dt>
            <dd>
              {usd(business.inference.known_cost_usd_micros)}
              {business.inference.calls_with_unknown_usage > 0 && (
                <small>{business.inference.calls_with_unknown_usage} calls with no usage reported</small>
              )}
            </dd>
          </div>
          <div>
            <dt>Gas, at least</dt>
            <dd>
              {gas.length
                ? gas.map(([chain, g]) => `${chain} ${units(g.cost_wei, 18)} ${NATIVE[chain] ?? ''}`).join(' · ')
                : 'none yet'}
            </dd>
          </div>
          <div>
            <dt>Margin before gas</dt>
            <dd>
              {units(business.margin.usdc_less_inference_micros, 6)} USDC
              <small>{business.margin_unavailable_reason}</small>
            </dd>
          </div>
          {kill !== null && (
            <div>
              <dt>Kill switch</dt>
              <dd>{kill ? 'On' : 'Off'}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className={styles.note}>The Worker hasn’t mirrored the desk’s stats yet.</p>
      )}
    </section>
  );
}
