'use client';

import { useState } from 'react';
import { EARLY_BELOW } from '../../../shared/score';
import { utcStamp } from '@/lib/format';
import type { BrierPoint } from '@/lib/ledger';
import styles from './ledger.module.css';

const COIN_FLIP = 0.25;
const W = 600;
const H = 200;

/**
 * The running Brier score over every resolved call, against the coin-flip line. Early points rest on few grades, so
 * the sample size sits beside every value and the stretch before EARLY_BELOW calls is shaded.
 */
export function BrierChart({ points }: { points: BrierPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) {
    return (
      <figure className={styles.panel}>
        <figcaption className={styles.panelHead}>
          <span className={styles.panelTitle}>Brier score over time</span>
        </figcaption>
        <p className={styles.note}>No graded calls yet. A call is graded once its outcome window closes.</p>
      </figure>
    );
  }

  const t0 = points[0]!.at;
  const t1 = points.at(-1)!.at;
  const top = Math.max(0.3, ...points.map((p) => p.brier)) * 1.05;
  const x = (at: number) => (t1 === t0 ? W / 2 : ((at - t0) / (t1 - t0)) * W);
  const y = (b: number) => H - (b / top) * H;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.at).toFixed(1)},${y(p.brier).toFixed(1)}`).join(' ');
  const earlyEnd = points.find((p) => p.n >= EARLY_BELOW);
  const last = points.at(-1)!;
  const shown = hover === null ? null : points[hover]!;

  /** Snap the crosshair to the point nearest the pointer's time. */
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = t0 + ((e.clientX - box.left) / box.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i]!.at - at) < Math.abs(points[best]!.at - at)) best = i;
    }
    setHover(best);
  };

  return (
    <figure className={styles.panel}>
      <figcaption className={styles.panelHead}>
        <span className={styles.panelTitle}>Brier score over time</span>
        <span className="label">
          {last.brier.toFixed(3)} after {last.n} graded {last.n === 1 ? 'call' : 'calls'}
        </span>
      </figcaption>
      <div
        className={styles.brierPlot}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        tabIndex={0}
        role="img"
        aria-label={`Brier score went from ${points[0]!.brier.toFixed(3)} to ${last.brier.toFixed(3)} over ${last.n} graded calls. Lower is better; a coin flip scores 0.25.`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover((h) => Math.min((h ?? -1) + 1, points.length - 1));
          if (e.key === 'ArrowLeft') setHover((h) => Math.max((h ?? points.length) - 1, 0));
          if (e.key === 'Escape') setHover(null);
        }}
        onBlur={() => setHover(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {earlyEnd && earlyEnd.at > t0 && (
            <rect x={0} y={0} width={x(earlyEnd.at)} height={H} className={styles.brierEarly} />
          )}
          {!earlyEnd && <rect x={0} y={0} width={W} height={H} className={styles.brierEarly} />}
          <line x1={0} x2={W} y1={y(COIN_FLIP)} y2={y(COIN_FLIP)} className={styles.brierRef} />
          <line x1={0} x2={W} y1={H} y2={H} className={styles.brierBase} />
          <path d={line} className={styles.brierLine} />
          {shown && <line x1={x(shown.at)} x2={x(shown.at)} y1={0} y2={H} className={styles.brierCross} />}
        </svg>
        <span className={styles.brierRefLabel} style={{ top: `${(y(COIN_FLIP) / H) * 100}%` }}>
          0.25 · coin flip
        </span>
        {shown && (
          <>
            <span
              className={styles.brierDot}
              style={{ left: `${(x(shown.at) / W) * 100}%`, top: `${(y(shown.brier) / H) * 100}%` }}
            />
            <div
              className={styles.brierTip}
              style={{ left: `${(x(shown.at) / W) * 100}%` }}
              data-flip={x(shown.at) > W * 0.6 || undefined}
            >
              <strong>{shown.brier.toFixed(3)}</strong>
              <span>
                after {shown.n} graded {shown.n === 1 ? 'call' : 'calls'}
                {shown.n < EARLY_BELOW ? ' · early data' : ''}
              </span>
              <span>{utcStamp(shown.at)} UTC</span>
            </div>
          </>
        )}
      </div>
      <div className={styles.brierAxis}>
        <span>{utcStamp(t0)}</span>
        <span>{utcStamp(t1)}</span>
      </div>
      <div className={styles.legend}>
        <span>
          <span className={styles.swatchLine} />
          Brier score, lower is better
        </span>
        <span>
          <span className={styles.swatchEarly} />
          Under {EARLY_BELOW} graded calls
        </span>
      </div>
      <details className={styles.brierTable}>
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Graded (UTC)</th>
              <th scope="col">Calls</th>
              <th scope="col">Brier</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={`${p.at}-${p.n}`}>
                <td>{utcStamp(p.at)}</td>
                <td>{p.n}</td>
                <td>{p.brier.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
