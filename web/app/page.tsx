import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Header, Mark } from '@/components/Header';
import s from '@/components/landing/landing.module.css';
import { Footer, Heartbeat, Instrument, Intro, TabVisibility, type HeroCall } from '@/components/landing/Live';
import { Calibration } from '@/components/ledger/Summary';
import { NETWORK_CHAINS, readDesk } from '@/lib/desk';
import { amount, duration, utcStamp, bpsPct } from '@/lib/format';
import { publicConfig } from '@/lib/config';
import { LOW_LIQUIDITY_PCT, hotFields, parseDoc } from '@/lib/doc';
import { readLedger, type LedgerPost } from '@/lib/ledger';
import { CHAIN_LABEL } from '@/lib/receipt';
import { BASE_MENU, SNAPSHOT, SNAPSHOT_BLOCK, shortAddress, usdShort, vaultName } from '@/lib/vaults';

export const revalidate = 60;

const Arrow = ({ color = 'currentColor' }: { color?: string }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path
      d="M2 7h10M8 3l4 4-4 4"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** The example reading in the hero when no recent call carries its reading: the line the model judges (worker/src/doc.ts). */
const EXAMPLE_DOC =
  'rein-v1|order=4127|chain=base|vault=0xbeeff2490feffa212fac2f6553682c219e6a8845|at=1793802600|block=53512044|pps=1043218|assets=457959928112233|liquidity=10.10|apy_bps=812|apy_bps_prev=694|util_bps=9390|net_out_pct_1h=6.42|name=Steakhouse High Yield USDC Edition';

/** A call the hero can show: its reading parsed, with every figure present, or null. */
function heroCall(p: LedgerPost, doc: string): HeroCall | null {
  const fields = parseDoc(doc);
  const f = Object.fromEntries(fields);
  const liquidity = Number(f.liquidity);
  const utilBps = Number(f.util_bps);
  const apyBps = Number(f.apy_bps);
  const apyPrevBps = Number(f.apy_bps_prev);
  const assets = Number(f.assets);
  if (![liquidity, utilBps, apyBps, apyPrevBps, assets].every(Number.isFinite) || f.liquidity === 'na' || !f.block) {
    return null;
  }
  return {
    id: p.id,
    verdict: p.verdict,
    confidenceBps: p.confidence_bps,
    riskBps: p.risk_bps,
    name: vaultName(p.chain, p.vault),
    address: shortAddress(p.vault),
    chain: CHAIN_LABEL[p.chain],
    block: Number(f.block).toLocaleString('en-US'),
    postedStamp: utcStamp(p.posted_at),
    inputCheck: p.input_check,
    liquidity,
    utilBps,
    apyBps,
    apyPrevBps,
    // USDC vaults: assets are in 6-decimal base units.
    tvlUsd: usdShort(assets / 1e6),
    doc: fields,
    hot: [...hotFields(fields)],
  };
}

const STEPS = [
  {
    t: 'Read',
    p: 'The vault is read at one pinned block: share price, assets, withdrawable liquidity, APY, utilization and the last hour’s net flows.',
    c: 'block=53512044 liquidity=10.10',
  },
  {
    t: 'Judge',
    p: 'A model sealed in a NEAR AI enclave answers HOLD, EXIT or MOVE, and the enclave signs exactly the bytes it answered.',
    c: 'signing_algo=ecdsa',
  },
  {
    t: 'Verify',
    p: 'The desk contract on NEAR checks the signer, the order, the chain, the vault and the reading’s age. Anything off, it refuses.',
    c: 'check_reading → ok',
  },
  {
    t: 'Sign',
    p: 'The contract itself signs the Base or Monad transaction through NEAR Chain Signatures, with a capped fee.',
    c: 'status: signing → signed',
  },
  {
    t: 'Post',
    p: 'The call lands on the Rein oracle, where Guardian and any contract can read it, and where the Ledger grades it later.',
    c: 'status: delivered',
  },
];

const WORDS = [
  { v: 'HOLD', p: 'Risk sits inside its range. Stay in and keep earning.' },
  {
    v: 'EXIT',
    p: 'Liquidity, flows or rates say leave now. An EXIT is read a second time before the desk will sign it.',
  },
  { v: 'MOVE', p: 'Not an emergency, but drifting. Rotate to a steadier vault on the menu.' },
];

export default async function Landing() {
  const cfg = await publicConfig();
  const [ledgerResult, desk] = await Promise.all([readLedger(cfg.network), readDesk()]);
  const ledger = ledgerResult.ok ? ledgerResult.ledger : null;
  const policy = desk?.policy ?? null;
  const priceUsdc = policy ? amount(policy.price_usdc, 6) : null;

  const ticker = (ledger?.recent ?? []).filter((p) => !p.repeat).slice(0, 10);
  const lastCall = new Map<string, LedgerPost>();
  for (const p of ledger?.recent ?? []) {
    const k = `${p.chain}:${p.vault.toLowerCase()}`;
    if (!lastCall.has(k)) lastCall.set(k, p);
  }
  const heroCalls: HeroCall[] = [];
  for (const p of ticker) {
    const c = p.doc ? heroCall(p, p.doc) : null;
    if (c) heroCalls.push(c);
    if (heroCalls.length === 6) break;
  }
  const example = heroCalls.length === 0;
  const exampleCall = example
    ? heroCall(
        {
          chain: 'base',
          id: 4127,
          vault: '0xbeeff2490feffa212fac2f6553682c219e6a8845',
          verdict: 'EXIT',
          confidence_bps: 9400,
          risk_bps: 8100,
          posted_at: 1793802600,
          order_id: 4127,
          input_check: 'match',
          resolved: false,
          adverse: null,
          reasons: null,
          repeat: false,
          doc: EXAMPLE_DOC,
          signer: null,
        },
        EXAMPLE_DOC,
      )
    : null;
  const shown = example ? (exampleCall ? [exampleCall] : []) : heroCalls;
  const newest = ledger?.recent[0];
  const chains = NETWORK_CHAINS[cfg.network];
  const menu = desk
    ? chains.flatMap((chain) => (desk.menu[chain] ?? []).map((vault) => ({ chain, vault })))
    : BASE_MENU.map((vault) => ({ chain: 'base' as const, vault }));
  const rows = menu
    .map(({ chain, vault }) => ({
      chain,
      vault,
      snap: chain === 'base' ? SNAPSHOT[vault.toLowerCase()] : undefined,
      last: lastCall.get(`${chain}:${vault.toLowerCase()}`),
    }))
    .sort((a, b) => (b.snap?.tvlUsd ?? 0) - (a.snap?.tvlUsd ?? 0));
  const baseCount = rows.filter((r) => r.chain === 'base').length;
  const watched = rows.length;
  const chainNames = chains
    .map((c) =>
      c === 'monad-testnet' ? 'Monad testnet' : c === 'base-sepolia' ? 'Base Sepolia' : c === 'base' ? 'Base' : 'Monad',
    )
    .join(', ');

  return (
    <div className={s.page}>
      <TabVisibility />
      <Intro>
        <Mark />
        <span className={s.introCap}>Desk opening</span>
      </Intro>
      <Header />

      <section id="top" className={`container ${s.hero}`}>
        <div className={`${s.eyebrow} ${s.heroMeta}`}>
          <span className={s.live}>
            <span className={s.pulse} aria-hidden="true" />
            Desk open — watching {watched} vaults
            {newest && (
              <Heartbeat
                at={newest.posted_at}
                stamp={utcStamp(newest.posted_at)}
                sample={!!ledgerResult.ok && ledgerResult.sample}
              />
            )}
          </span>
          <span>
            Risk calls for yield vaults · NEAR →{' '}
            {chainNames}
          </span>
        </div>
        <h1 className={s.h1}>
          <span className={s.line}>
            <span>Pull the reins</span>
          </span>
          <span className={s.line}>
            <span>before the run.</span>
          </span>
        </h1>
        <div className={s.heroFoot}>
          <p className={s.lede}>
            Rein reads a USDC vault at a pinned block, has a model sealed in a NEAR AI enclave judge it, and posts a
            signed <strong>HOLD</strong>, <strong className={s.exit}>EXIT</strong> or{' '}
            <strong className={s.move}>MOVE</strong> onchain. Guardian can walk your position out on the call. Every
            call is graded in public.
          </p>
          <div className={s.ctaRow}>
            <Link href="/judge" className={`${s.btn} ${s.btnInk} ${s.btnLg}`}>
              Judge a vault {priceUsdc && <span className={s.price}>{priceUsdc} USDC</span>}
            </Link>
            <Link href="/ledger" className={`${s.btn} ${s.btnLine} ${s.btnLg}`}>
              See every call
            </Link>
          </div>
        </div>

        {shown.length > 0 && (
          <Instrument
            calls={shown}
            example={example}
            sample={!!ledgerResult.ok && ledgerResult.sample}
            trigger={LOW_LIQUIDITY_PCT}
          />
        )}
      </section>

      {ticker.length > 0 && (
        <div className={s.ticker} aria-label="Recent calls" data-loop={ticker.length >= 4 || undefined}>
          {/* A marquee needs two identical halves; the second is a visual copy only. */}
          <div className={s.marquee} style={{ '--tick-s': `${ticker.length * 9}s` } as CSSProperties}>
            {[false, true].map((copy) => (
              <div key={String(copy)} className={s.track} aria-hidden={copy || undefined} data-copy={copy || undefined}>
                {ticker.map((p) => (
                  <Link key={`${p.chain}-${p.id}`} href="/ledger" className={s.tick} tabIndex={copy ? -1 : undefined}>
                    <span className="chip" data-verdict={p.verdict}>
                      {p.verdict}
                    </span>
                    <span className={s.tickName}>{vaultName(p.chain, p.vault)}</span>
                    <span className={s.tickMeta}>
                      {bpsPct(p.confidence_bps)} · {utcStamp(p.posted_at)}
                    </span>
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <section id="how" className={`container ${s.section}`}>
        <div className={s.split}>
          <div>
            <h2 className={s.h2}>Every call carries its own proof.</h2>
          </div>
          <p className={s.copy}>
            No dashboard to trust and no bot key to steal. Five steps, each checkable by anyone: the reading, the
            model’s signature, the contract’s check, the chain signature and the post.
          </p>
        </div>
        <div className={s.steps}>
          <div className={s.rail} aria-hidden="true" />
          <ol className={s.stepList}>
            {STEPS.map((st, i) => (
              <li key={st.t} className={s.step}>
                <span className={s.num}>{String(i + 1).padStart(2, '0')}</span>
                <h3>{st.t}</h3>
                <p>{st.p}</p>
                <code>{st.c}</code>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-label="The three calls" className={s.words}>
        {WORDS.map((w) => (
          <div key={w.v} className={s.wordRow} data-verdict={w.v} tabIndex={0}>
            <div className={`container ${s.wordInner}`}>
              <div className={s.word2} data-verdict={w.v}>
                {w.v}
              </div>
              <div className={s.wordNote}>
                <p>{w.p}</p>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section id="ledger" className={s.night}>
        <div className={`container ${s.nightInner}`}>
          <div>
            {ledgerResult.ok && ledgerResult.sample && <p className={s.sample}>Sample data</p>}
            <h2 className={s.h2}>Graded in public. Every call, forever.</h2>
            <p className={s.copy}>
              Each call is resolved against what the vault did next and scored with a Brier score: lower is better, zero
              is perfect. A burst of identical calls on one vault counts once, so the desk can’t pad its record.
            </p>
            {ledger && (
              <div className={s.figures}>
                <div>
                  <div className={s.figLabel}>Brier score</div>
                  <div className={s.figValue}>{ledger.score.brier === null ? '–' : ledger.score.brier.toFixed(3)}</div>
                </div>
                <div>
                  <div className={s.figLabel}>Resolved calls</div>
                  <div className={s.figValue}>{ledger.score.n}</div>
                </div>
              </div>
            )}
            <Link href="/ledger" className={`${s.btn} ${s.btnBone}`}>
              Open the Ledger <Arrow />
            </Link>
          </div>
          {ledger && <Calibration score={ledger.score} tone="night" />}
        </div>
      </section>

      <section id="guardian" className={`container ${s.section} ${s.guard}`}>
        <div>
          <h2 className={s.h2}>
            {cfg.exitWorker ? 'The call lands. You’re already out.' : 'The call lands. One call takes you out.'}
          </h2>
          <p className={s.copy} style={{ marginTop: 28 }}>
            Set your own rule once. When a fresh EXIT meets it, anyone can call Guardian’s exit, and your position goes
            back to your wallet.{' '}
            {cfg.exitWorker
              ? 'Rein’s exit worker makes that call as soon as the post lands.'
              : 'Rein’s exit worker isn’t running yet, so for now someone has to make that call.'}{' '}
            Nobody holds your funds.
          </p>
          <ul className={s.facts}>
            <li>
              <span>A</span>
              <span>
                <strong>Assets only ever go to you.</strong> Guardian never holds funds; its admin can only approve
                vaults.
              </span>
            </li>
            <li>
              <span>B</span>
              <span>
                <strong>Full exits when the vault can pay.</strong> A caller can’t starve the gas to force a partial
                redeem. If liquidity is short, the exit redeems what it can and the rest can follow on the same call.
              </span>
            </li>
            <li>
              <span>C</span>
              <span>
                <strong>No stale or replayed calls.</strong> A verdict from before you opted in can’t move you, and one
                that fully exited you can’t move a later deposit.
              </span>
            </li>
          </ul>
          <Link href="/guardian" className={`${s.btn} ${s.btnLine} ${s.btnLg}`} style={{ marginTop: 32 }}>
            Arm Guardian
          </Link>
        </div>
        <div className={`${s.card} torn`} aria-label="An example Guardian rule">
          <div className={s.cardHead}>
            <div className={s.cardWho}>
              <span className={s.shield}>
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M9 1.8 15 4v4.6c0 3.6-2.5 6.4-6 7.6-3.5-1.2-6-4-6-7.6V4z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div>
                <div style={{ fontWeight: 650 }}>Guardian rule · example</div>
                <div className={s.addr}>Steakhouse High Yield USDC Edition</div>
              </div>
            </div>
            <span className={s.armed}>ARMED</span>
          </div>
          <div className={s.rule}>
            <div className={s.ruleBox}>
              <div className="label">Min confidence</div>
              <div className={s.ruleValue}>90%</div>
              <div className={s.meter}>
                <span style={{ width: '52.6%' }} />
              </div>
              <div className={s.ends}>
                <span>80</span>
                <span>99</span>
              </div>
            </div>
            <div className={s.ruleBox}>
              <div className="label">Fresh within</div>
              <div className={s.ruleValue}>10 min</div>
              <div className={s.meter}>
                <span style={{ width: '15.3%' }} />
              </div>
              <div className={s.ends}>
                <span>1 min</span>
                <span>60 min</span>
              </div>
            </div>
          </div>
          <div className="label" style={{ marginTop: 24 }}>
            Last event
          </div>
          <ol className={s.events}>
            <li>
              <span className={s.ev} data-k="exit" />
              <span>
                <strong>EXIT</strong> posted at 94% confidence
              </span>
              <time>14:02:11</time>
            </li>
            <li>
              <span className={s.ev} />
              <span>Rule met: at least 90%, fresh</span>
              <time>14:02:11</time>
            </li>
            <li>
              <span className={s.ev} data-k="done" />
              <span>
                <strong>1,000.00 USDC</strong> back in 0x9f2c…41d0
              </span>
              <time>14:02:13</time>
            </li>
          </ol>
        </div>
      </section>

      <section id="menu" className={`container ${s.section}`}>
        <div className={s.split}>
          <div>
            <h2 className={s.h2}>
              {baseCount > 0 ? `${baseCount} Base vaults made the cut.` : `${rows.length} vaults on the menu.`}
            </h2>
          </div>
          <p className={s.copy}>
            USDC Morpho Vault V2s on Base with at least $1M in them, a liquidity read we trust, and a Guardian exit of
            1,000 USDC proven on a fork. 24 candidates, 10 turned away.
          </p>
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Vault</th>
                <th scope="col" className={s.right}>
                  TVL
                </th>
                <th scope="col" style={{ width: '30%' }}>
                  Withdrawable
                </th>
                <th scope="col">Last call</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.chain}:${r.vault}`}>
                  <td>
                    <div className={s.vname}>{vaultName(r.chain, r.vault)}</div>
                    <div className={s.addr}>
                      {r.chain} · {shortAddress(r.vault)}
                    </div>
                  </td>
                  <td className={`${s.right} ${s.mono}`} style={{ fontSize: 12.5 }}>
                    {r.snap ? usdShort(r.snap.tvlUsd) : '–'}
                  </td>
                  <td>
                    {r.snap ? (
                      <div className={s.barRow}>
                        <div className={s.bar}>
                          <span
                            data-low={r.snap.withdrawablePct < 15 || undefined}
                            style={{ width: `${r.snap.withdrawablePct}%` }}
                          />
                        </div>
                        <span className={s.barPct}>{r.snap.withdrawablePct.toFixed(1)}%</span>
                      </div>
                    ) : (
                      <span className={s.mono} style={{ fontSize: 12, color: 'var(--mute)' }}>
                        –
                      </span>
                    )}
                  </td>
                  <td>
                    {r.last ? (
                      <span className="chip" data-verdict={r.last.verdict}>
                        {r.last.verdict}
                      </span>
                    ) : (
                      <span className={s.mono} style={{ fontSize: 11, color: 'var(--mute)' }}>
                        none yet
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={s.small}>
          TVL and withdrawable share read at Base block ~{SNAPSHOT_BLOCK}. Euler Earn joins when a USDC vault there
          passes $1M.
        </p>
      </section>

      <section id="pay" className={`container ${s.section}`}>
        <div className={s.split}>
          <h2 className={s.h2} style={{ margin: 0 }}>
            One price per call.{' '}
            <span className={s.soft}>
              {policy
                ? `Refunded if it doesn’t land within ${duration(policy.deadline_s)}.`
                : 'Refunded if it doesn’t land.'}
            </span>
          </h2>
          <div className={s.bigPrice}>
            {priceUsdc ?? '–'}
            <span>USDC</span>
          </div>
        </div>
        <div className={s.rails}>
          <article className={s.railCard}>
            <span className="label">Rail A</span>
            <h3>NEAR</h3>
            <p>
              Pay {policy ? `${amount(policy.price_near, 24)} NEAR` : 'in NEAR'} from your NEAR wallet. It sits in the
              desk’s escrow until your call is delivered, and comes back if the deadline passes.
            </p>
            <code>request_judgement({'{ chain, vault }'})</code>
          </article>
          <article className={s.railCard}>
            <span className="label">Rail B</span>
            <h3>USDC on NEAR</h3>
            <p>Send USDC straight to the desk with one transfer. Same escrow, same refund.</p>
            <code>ft_transfer_call → desk</code>
          </article>
          <article className={s.railCard} data-dark>
            <span className="label">Rail C — for agents</span>
            <h3>x402</h3>
            <p>
              Your agent asks over HTTP, pays per call with x402, and gets the signed post back. No account, no wallet
              pop-up.
            </p>
            <code>POST /v1/x402/judge · 402 → paid → 200</code>
          </article>
        </div>
      </section>

      <section className={s.close}>
        <div className={`container ${s.closeInner}`}>
          <h2 className={s.closeH}>
            Get a second
            <br />
            opinion, signed.
          </h2>
          <div className={s.ctaRow}>
            <Link href="/judge" className={`${s.btn} ${s.btnInk} ${s.btnXl}`}>
              Judge a vault
            </Link>
            <Link href="/guardian" className={`${s.btn} ${s.btnLine} ${s.btnXl}`}>
              Arm Guardian
            </Link>
          </div>
        </div>
      </section>

      <Footer>
        <div className="container">
          <div className={s.footTop}>
            <p className={s.footSay}>
              Calls can be wrong. The Ledger shows <em>how often.</em>
            </p>
            <nav className={s.footCol} aria-label="Desk">
              <h3>Desk</h3>
              <Link href="/judge">Judge a vault</Link>
              <Link href="/guardian">Arm Guardian</Link>
              <Link href="/ledger">Ledger</Link>
              <Link href="/orders">My orders</Link>
            </nav>
            <nav className={s.footCol} aria-label="Proof">
              <h3>Proof</h3>
              <Link href="/how">How it works</Link>
              <Link href="/docs">Docs</Link>
              <a href="https://github.com/0xGanadhish/rein">GitHub</a>
            </nav>
            <div className={s.footCol}>
              <h3>Status</h3>
              <p className={s.footStat}>
                <b>Desk open</b>
                <br />
                watching {watched} vaults
                <br />
                NEAR → {chainNames}
              </p>
            </div>
          </div>
          {/* The mark, stretched edge to edge. */}
          <div className={s.reins} aria-hidden="true">
            <i />
            <b />
            <i />
          </div>
          <div className={s.footFine}>
            <p>Rein publishes risk signals, not financial advice.</p>
            <p>A risk desk on NEAR.</p>
          </div>
        </div>
        <span className={s.footGiant} aria-hidden="true">
          rein
        </span>
      </Footer>
    </div>
  );
}
