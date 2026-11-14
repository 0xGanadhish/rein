'use client';

import { useState, type KeyboardEvent } from 'react';
import s from './how.module.css';

const W = 820;
const LANES = [
  { x: 82, name: 'You', sub: 'or your agent' },
  { x: 246, name: 'Desk contract', sub: 'NEAR' },
  { x: 410, name: 'Rein agent', sub: 'offchain' },
  { x: 574, name: 'Model', sub: 'NEAR AI TEE' },
  { x: 738, name: 'Vault’s chain', sub: 'Base or Monad' },
];
const [YOU, DESK, AGENT, MODEL, CHAIN] = LANES.map((l) => l.x);

type Msg = {
  step: number;
  y: number;
  from: number;
  to: number;
  label: string;
  kind?: 'reply' | 'signal';
  labelX?: number;
};
const MSGS: Msg[] = [
  { step: 1, y: 100, from: YOU, to: DESK, label: '1 · pay for a call' },
  { step: 2, y: 148, from: DESK, to: AGENT, label: '2 · order opens' },
  { step: 3, y: 196, from: AGENT, to: CHAIN, label: '3 · read the vault at a pinned block' },
  { step: 4, y: 244, from: AGENT, to: MODEL, label: '4 · approved prompt + reading' },
  { step: 5, y: 292, from: MODEL, to: AGENT, label: '5 · signed answer', kind: 'reply' },
  { step: 6, y: 340, from: AGENT, to: DESK, label: '6 · deliver the answer' },
  {
    step: 8,
    y: 468,
    from: DESK,
    to: CHAIN,
    label: '8 · Chain Signatures sign the post to the oracle',
    kind: 'signal',
    labelX: (AGENT + CHAIN) / 2,
  },
];
const H = 580;

const STEPS = [
  'You, or your agent, pay the desk contract on NEAR for a call on one vault.',
  'The desk opens the order. Only Rein’s agent can answer it, and only once.',
  'The agent reads the vault at a pinned block. The reading names this order, chain and vault, and is at most five minutes old.',
  'The agent puts the reading into the approved prompt: the model, system prompt, temperature, token limit and output format the owner fixed on the desk.',
  'The model runs in a NEAR AI TEE and signs the exact request and response.',
  'The agent delivers the signed answer to the desk.',
  'The desk runs seven checks before anything is signed. If any fails, the order is refunded.',
  'If all pass, NEAR Chain Signatures sign the post, and it lands on Rein’s oracle on the vault’s chain.',
  'Later readings of the vault grade the call on the public Ledger, starting from no record.',
];

/** One order, start to finish, as a sequence diagram across the parties involved. */
export function HowFlow({ checks }: { checks: string[] }) {
  const [step, setStep] = useState(1);
  const last = STEPS.length;
  const go = (n: number) => setStep(Math.min(last, Math.max(1, n)));
  const cls = (n: number) => `${s.flowStep} ${n === step ? '' : n < step ? s.flowPast : s.flowFuture}`;
  const pick = (n: number) => ({ className: cls(n), onClick: () => go(n) });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(step + 1);
    else if (e.key === 'ArrowLeft') go(step - 1);
    else return;
    e.preventDefault();
  };

  return (
    <figure className={s.flow} onKeyDown={onKey}>
      <div className={s.flowScroll}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby="flow-title flow-desc" className={s.flowSvg}>
          <title id="flow-title">How one order moves through Rein</title>
          <desc id="flow-desc">
            You pay the desk contract on NEAR. The order opens, the agent reads the vault at a pinned block, sends the
            approved prompt and reading to the model in a TEE, and gets back a signed answer. The agent delivers it to
            the desk, which runs seven checks. If any fails, you are refunded. If all pass, NEAR Chain Signatures sign
            the post to the oracle on the vault’s chain, where later readings grade the call on the Ledger.
          </desc>
          <defs>
            <marker
              id="flow-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" className={s.flowHeadInk} />
            </marker>
            <marker
              id="flow-arrow-signal"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" className={s.flowHeadSignal} />
            </marker>
          </defs>

          {LANES.map((l) => (
            <g key={l.name}>
              <line x1={l.x} y1={58} x2={l.x} y2={H - 12} className={s.flowLife} />
              <rect x={l.x - 74} y={8} width={148} height={50} rx={10} className={s.flowActor} />
              <text x={l.x} y={30} className={s.flowActorName}>
                {l.name}
              </text>
              <text x={l.x} y={47} className={s.flowActorSub}>
                {l.sub}
              </text>
            </g>
          ))}

          {MSGS.map((m) => {
            const dir = m.to > m.from ? 1 : -1;
            const signal = m.kind === 'signal';
            return (
              <g key={m.label} {...pick(m.step)}>
                <line
                  x1={m.from + dir * 6}
                  y1={m.y}
                  x2={m.to - dir * 6}
                  y2={m.y}
                  className={signal ? s.flowMsgSignal : m.kind === 'reply' ? s.flowMsgReply : s.flowMsg}
                  markerEnd={`url(#${signal ? 'flow-arrow-signal' : 'flow-arrow'})`}
                />
                <text
                  x={m.labelX ?? (m.from + m.to) / 2}
                  y={m.y - 9}
                  className={signal ? s.flowLabelSignal : s.flowLabel}
                >
                  {m.label}
                </text>
              </g>
            );
          })}

          {/* 7: the checks, with the refund branch */}
          <g {...pick(7)}>
            <rect x={DESK - 66} y={370} width={132} height={60} rx={10} className={s.flowCheck} />
            <text x={DESK} y={395} className={s.flowCheckTitle}>
              7 · seven checks
            </text>
            <text x={DESK} y={413} className={s.flowActorSub}>
              before signing
            </text>
            <line
              x1={DESK - 72}
              y1={400}
              x2={YOU + 6}
              y2={400}
              className={s.flowMsgReply}
              markerEnd="url(#flow-arrow)"
            />
            <text x={(YOU + DESK - 66) / 2} y={391} className={s.flowLabel}>
              any fail
            </text>
            <text x={(YOU + DESK - 66) / 2} y={418} className={s.flowLabel}>
              → refund
            </text>
            <text x={DESK + 74} y={455} className={s.flowLabelStart}>
              all pass
            </text>
          </g>

          {/* 9: grading */}
          <g {...pick(9)}>
            <rect x={CHAIN - 74} y={496} width={148} height={60} rx={10} className={s.flowActor} />
            <text x={CHAIN} y={521} className={s.flowCheckTitle}>
              9 · graded later
            </text>
            <text x={CHAIN} y={539} className={s.flowActorSub}>
              on the public Ledger
            </text>
          </g>
        </svg>
      </div>
      <div className={s.flowControls}>
        <button type="button" onClick={() => go(step - 1)} disabled={step === 1} className={s.flowBtn}>
          <span aria-hidden="true">←</span> Back
        </button>
        <span className={s.flowCount}>
          Step {step} of {last}
        </span>
        {step < last ? (
          <button type="button" onClick={() => go(step + 1)} className={s.flowBtnInk}>
            Next <span aria-hidden="true">→</span>
          </button>
        ) : (
          <button type="button" onClick={() => go(1)} className={s.flowBtnInk}>
            Start over
          </button>
        )}
      </div>
      <figcaption className={s.flowCaption} aria-live="polite">
        <p>
          <b>{step}.</b> {STEPS[step - 1]}
        </p>
        {step === 7 && (
          <ol aria-label="The seven checks" className={s.flowChecks}>
            {checks.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        )}
      </figcaption>
    </figure>
  );
}
