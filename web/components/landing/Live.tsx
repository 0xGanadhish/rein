'use client';

import { useEffect, useState } from 'react';
import s from './landing.module.css';

/** Sets data-tab-hidden on <html> so CSS loops (the ticker) pause while the tab is in the background. */
export function TabVisibility() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      if (document.hidden) root.dataset.tabHidden = '';
      else delete root.dataset.tabHidden;
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      delete root.dataset.tabHidden;
    };
  }, []);
  return null;
}

/** "3m 12s", "2h 05m", "8d 4h": coarser as the gap grows, so the text only changes when it has to. */
export function ago(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, '0')}s`;
  if (t < 86400) return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(t / 86400)}d ${Math.floor((t % 86400) / 3600)}h`;
}

/**
 * How long ago the newest call was posted, ticking up once a second from its posted_at. Until it mounts it shows the
 * stamp the server rendered, so the markup matches on hydration. It stops ticking while the tab is hidden.
 */
export function Heartbeat({ at, stamp, sample }: { at: number; stamp: string; sample: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const tick = () => setNow(Date.now() / 1000);
    const start = () => {
      tick();
      id ??= setInterval(tick, 1000);
    };
    const stop = () => {
      clearInterval(id);
      id = undefined;
    };
    const sync = () => (document.hidden ? stop() : start());
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
  return (
    <span className={s.beat}>
      {/* Past a day the counter only reads as stale, so the posted time stays instead. */}
      Latest call {now === null || now - at > 86400 ? `${stamp} UTC` : `${ago(now - at)} ago`}
      {sample && <span className={s.beatTag}>Sample data</span>}
    </span>
  );
}

export interface HeroCall {
  id: number;
  verdict: 'HOLD' | 'EXIT' | 'MOVE';
  confidenceBps: number;
  riskBps: number;
  name: string;
  address: string;
  chain: string;
  block: string;
  postedStamp: string;
  inputCheck: string;
  /** Withdrawable share, %. */
  liquidity: number;
  utilBps: number;
  apyBps: number;
  apyPrevBps: number;
  tvlUsd: string;
  /** The signed reading's fields, in order, and which of them look wrong. */
  doc: [string, string][];
  hot: string[];
}

const keyOf = (c: HeroCall) => `${c.chain}-${c.id}`;

/** One real call per slide, newest first. With no real call to show, the page passes one labelled example instead. */
export function Instrument({
  calls,
  example,
  sample,
  trigger,
}: {
  calls: HeroCall[];
  example: boolean;
  sample: boolean;
  trigger: number;
}) {
  const n = calls.length;
  const [i, setI] = useState(0);
  const [started, setStarted] = useState(false);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(false);
  // Static until we know the visitor allows motion.
  const [still, setStill] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    const vis = () => setHidden(document.hidden);
    vis();
    document.addEventListener('visibilitychange', vis);
    return () => {
      mq.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);

  useEffect(() => {
    if (n < 2 || still || held || hidden) return;
    const id = setInterval(() => {
      setStarted(true);
      setI((v) => (v + 1) % n);
    }, 7000);
    return () => clearInterval(id);
  }, [n, still, held, hidden]);

  const c = calls[i];
  // Left to right, oldest to newest; each point is one call's withdrawable share.
  const chrono = [...calls].reverse();
  const xPct = (k: number) => (chrono.length < 2 ? 50 : 4 + (k * 92) / (chrono.length - 1));
  const yPct = (liq: number) => 90 - Math.min(100, Math.max(0, liq)) * 0.8;
  const here = chrono.findIndex((x) => keyOf(x) === keyOf(c));
  const line = chrono.map((x, k) => `${k ? 'L' : 'M'}${xPct(k) * 10},${yPct(x.liquidity) * 3}`).join(' ');
  const area = `${line} L${xPct(chrono.length - 1) * 10},300 L${xPct(0) * 10},300 Z`;
  const hot = new Set(c.hot);

  return (
    <figure
      className={s.instrument}
      aria-label={example ? 'An example reading that ends in an EXIT call' : 'Recent calls, one at a time'}
      data-cycled={started || undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
    >
      <div className={s.instTop}>
        <div className={s.instGroup}>
          <strong className={s.instName}>{c.name}</strong>
          <span>{c.address}</span>
          <span>{c.chain}</span>
        </div>
        <div className={s.instGroup}>
          <span>
            {example ? 'Example reading' : `${sample ? 'Sample call' : 'Recent call'} · ${c.postedStamp} UTC`}
          </span>
          <span style={{ color: 'var(--night-ink)' }}>Block {c.block}</span>
          {n > 1 && (
            <span className={s.pager} role="group" aria-label="Choose a call">
              {calls.map((x, k) => (
                <button
                  key={keyOf(x)}
                  type="button"
                  className={s.pip}
                  aria-label={`${x.verdict} on ${x.name}`}
                  aria-current={k === i || undefined}
                  onClick={() => {
                    setStarted(true);
                    setI(k);
                  }}
                />
              ))}
            </span>
          )}
        </div>
      </div>
      <div className={s.chart}>
        {example ? (
          <>
            <div className={s.chartLabel}>Withdrawable liquidity · 3h</div>
            <div className={s.chartKey}>
              <span>
                <span className={s.keyLine} />
                Liquidity
              </span>
              <span className={s.hideSm}>
                <span className={s.keyDash} />
                Watch trigger
              </span>
            </div>
            <svg className={s.svg} viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="liqfill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#ECEBE5" stopOpacity="0.16" />
                  <stop offset="1" stopColor="#ECEBE5" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line
                x1="0"
                y1="196"
                x2="1000"
                y2="196"
                stroke="#FF5420"
                strokeWidth="1.5"
                strokeDasharray="6 6"
                vectorEffect="non-scaling-stroke"
                opacity="0.9"
              />
              <path
                className={s.area}
                fill="url(#liqfill)"
                d="M0,64 C40,60 70,72 110,68 S190,52 240,60 S330,78 380,70 S470,58 520,66 S600,84 640,96 S700,128 730,160 S780,222 820,236 S900,246 940,244 S985,248 1000,248 L1000,300 L0,300 Z"
              />
              <path
                className={s.trace}
                fill="none"
                stroke="#ECEBE5"
                strokeWidth="2.2"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                d="M0,64 C40,60 70,72 110,68 S190,52 240,60 S330,78 380,70 S470,58 520,66 S600,84 640,96 S700,128 730,160 S780,222 820,236 S900,246 940,244 S985,248 1000,248"
              />
              <circle className={s.trip} cx="776" cy="196" r="5" fill="#FF5420" />
            </svg>
            <div className={`${s.tripNote} ${s.hideSm}`}>net_out_pct_1h = 6.42 &gt; 5.00</div>
          </>
        ) : (
          <>
            <div className={s.chartLabel}>Withdrawable liquidity · last {n} calls</div>
            <div className={s.chartKey}>
              <span className={s.hideSm}>One point per call, any vault</span>
              <span className={s.hideSm}>
                <span className={s.keyDash} />
                Under {trigger}% is thin
              </span>
            </div>
            <div className={s.plot}>
              <svg className={s.svg} viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="liqfill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ECEBE5" stopOpacity="0.16" />
                    <stop offset="1" stopColor="#ECEBE5" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line
                  x1="0"
                  y1={yPct(trigger) * 3}
                  x2="1000"
                  y2={yPct(trigger) * 3}
                  stroke="#FF5420"
                  strokeWidth="1.5"
                  strokeDasharray="6 6"
                  vectorEffect="non-scaling-stroke"
                  opacity="0.9"
                />
                {chrono.length > 1 && (
                  <g key={i}>
                    <path className={s.area} fill="url(#liqfill)" d={area} />
                    <path
                      className={s.trace}
                      fill="none"
                      stroke="#ECEBE5"
                      strokeWidth="2.2"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                      d={line}
                    />
                  </g>
                )}
              </svg>
              {chrono.map((x, k) => (
                <span
                  key={keyOf(x)}
                  className={s.point}
                  data-on={k === here || undefined}
                  data-verdict={x.verdict}
                  style={{ left: `${xPct(k)}%`, top: `${yPct(x.liquidity)}%` }}
                  title={`${x.name}: ${x.liquidity.toFixed(1)}% withdrawable, ${x.verdict}`}
                />
              ))}
            </div>
          </>
        )}
        <div key={i} className={s.stamp} data-verdict={c.verdict}>
          <div className={s.stampWord}>{c.verdict}</div>
          <div className={s.stampMeta}>
            CONF {(c.confidenceBps / 100).toFixed(1)}% · RISK {(c.riskBps / 100).toFixed(1)}%
          </div>
          <div className={s.stampSub}>
            {example ? 'signed · verified · read twice' : `post #${c.id} · input ${c.inputCheck}`}
          </div>
        </div>
      </div>
      <div key={`stats-${i}`} className={`${s.stats} ${s.swap}`}>
        <div className={s.stat}>
          <div className={s.statLabel}>Withdrawable</div>
          <div className={`${s.statValue} ${hot.has('liquidity') ? s.hot : ''}`}>{c.liquidity.toFixed(2)}%</div>
        </div>
        <div className={s.stat}>
          <div className={s.statLabel}>Utilization</div>
          <div className={s.statValue}>{(c.utilBps / 100).toFixed(2)}%</div>
        </div>
        <div className={s.stat}>
          <div className={s.statLabel}>APY · was {(c.apyPrevBps / 100).toFixed(2)}%</div>
          <div className={s.statValue}>{(c.apyBps / 100).toFixed(2)}%</div>
        </div>
        <div className={s.stat}>
          <div className={s.statLabel}>TVL</div>
          <div className={s.statValue}>{c.tvlUsd}</div>
        </div>
      </div>
      <figcaption className={s.doc}>
        {/* Every reading sits in the same cell, so the card keeps the height of the longest one. */}
        {calls.map((x, k) => (
          <div key={keyOf(x)} className={s.docLine} data-on={k === i || undefined} aria-hidden={k !== i}>
            <b>rein-v1</b>
            {x.doc.map(([key, v]) => (
              <span key={key}>
                |{key}=<b className={x.hot.includes(key) ? s.hot : undefined}>{v}</b>
              </span>
            ))}
          </div>
        ))}
      </figcaption>
    </figure>
  );
}
