import Link from 'next/link';
import type { ReactNode } from 'react';
import { DEPLOYMENTS } from '../../../shared/deployments';
import { DOC_PAGES, docNum, docPage, type DocPage } from '@/components/docs/navigation';
import s from '@/components/docs/docs.module.css';

const FEATURED = ['/docs/verdict', '/docs/guardian', '/docs/ledger'];
const topics = DOC_PAGES.filter((p) => p.href !== '/docs');
const page = (href: string) => docPage(href)!;

const ACTORS: [string, string][] = [
  ['Buyer', 'Picks a vault from the desk’s menu and buys a judgement. Buying never moves a vault position.'],
  [
    'NEAR desk',
    'Admits orders, holds NEAR/USDC escrow, checks the signed answer against its prompt and signers, then asks Chain Signatures to sign the post.',
  ],
  [
    'Worker',
    'Reads the vault, writes the document, calls the model, advances orders, broadcasts posts and mirrors outcomes into the public API.',
  ],
  [
    'Model in NEAR AI',
    'Returns a signed judgement over the prompt and document. The signature proves who answered, not that the forecast is right.',
  ],
  ['Chain Signatures', 'Signs the EVM transaction the desk requests. Separate from the model’s answer signature.'],
  [
    'EVM oracle',
    'Takes posts from the authorized attester, rejects repeats and expired posts, and records later grades.',
  ],
];

export default function DocsOverview() {
  const verdict = page('/docs/verdict');
  return (
    <>
      <header className={s.hero}>
        <div>
          <span className={s.eyebrow}>Docs · {topics.length} short topics</span>
          <h1 className={s.heroTitle}>How Rein works, in plain words.</h1>
          <p className={s.lede}>
            Rein sells a fresh HOLD, EXIT or MOVE call on a yield vault. A model in a NEAR AI enclave signs it, the NEAR
            desk checks it, and it lands onchain where later readings grade it in public. Each topic takes a few
            minutes.
          </p>
          <div className={s.ctas}>
            <Link href={verdict.href} className={s.ctaInk}>
              Start with How a verdict is made <span aria-hidden="true">→</span>
            </Link>
            <Link href="/how" className={s.ctaLine}>
              See the visual walkthrough
            </Link>
          </div>
        </div>
        <OneBreath />
      </header>

      <section aria-label="Start here" className={s.featured}>
        <Link href={verdict.href} className={s.nightCard}>
          <div className={s.cardTop}>
            <span>Start here</span>
            <span>{docNum(verdict)}</span>
          </div>
          <h2>{verdict.title}</h2>
          <p>{verdict.description}</p>
          <ol className={s.steps} aria-label="The six steps">
            {['Pay', 'Read', 'Judge', 'Check', 'Sign', 'Post'].map((step, i) => (
              <li key={step} data-last={i === 5 || undefined}>
                <span className={s.dot} />
                {step}
              </li>
            ))}
          </ol>
          <span className={s.arrow} aria-hidden="true">
            ↗
          </span>
        </Link>

        <FeatureCard p={page('/docs/guardian')}>
          <span className={s.chip}>EXIT ≥ 90% sure</span>
          <span className={s.chip}>fresh post</span>
          <span className={s.mute}>→</span>
          <span className={s.signal}>your wallet</span>
        </FeatureCard>

        <FeatureCard p={page('/docs/ledger')}>
          <span className={s.stamp}>EXIT</span>
          <span>94%</span>
          <span className={s.mute}>→ graded by later readings</span>
        </FeatureCard>
      </section>

      <section aria-labelledby="every-topic" className={s.block}>
        <h2 id="every-topic" className={s.eyebrow}>
          Every topic
        </h2>
        <div className={s.grid}>
          {topics
            .filter((p) => !FEATURED.includes(p.href) && p.group !== 'Developers')
            .map((p) => (
              <TopicCard key={p.href} p={p} />
            ))}
        </div>
      </section>

      <section aria-labelledby="developers" className={s.devBand}>
        <div className={s.devHead}>
          <div>
            <h2 id="developers" className={s.eyebrow}>
              For developers
            </h2>
            <p>Read verdicts, pay per call, or hand Rein to an agent.</p>
          </div>
          <span className={s.devTag}>HTTP · MCP · x402</span>
        </div>
        <div className={s.devGrid}>
          {topics
            .filter((p) => p.group === 'Developers')
            .map((p) => (
              <Link key={p.href} href={p.href} className={s.devCard}>
                <span className={s.eyebrow}>{docNum(p)}</span>
                <h3>{p.title}</h3>
                <p>{p.description}</p>
                <span className={s.read}>Read →</span>
              </Link>
            ))}
        </div>
      </section>

      <section aria-labelledby="who" className={s.block}>
        <h2 id="who" className={s.eyebrow}>
          Who does what
        </h2>
        <dl className={s.actors}>
          {ACTORS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="networks" className={s.block}>
        <h2 id="networks" className={s.eyebrow}>
          Networks
        </h2>
        <div className={s.networks}>
          {(['mainnet', 'testnet'] as const).map((network) => (
            <div key={network} className={s.network}>
              <b>{network}</b>
              <dl>
                <dt>Desk</dt>
                <dd>
                  <code>{DEPLOYMENTS[network].desk ?? 'not deployed'}</code>
                </dd>
                <dt>Worker</dt>
                <dd>
                  <code>{DEPLOYMENTS[network].api}</code>
                </dd>
                {Object.entries(DEPLOYMENTS[network].oracles).map(([chain, oracle]) => (
                  <div key={chain} className={s.row}>
                    <dt>Oracle · {chain}</dt>
                    <dd>
                      <code>{oracle ?? 'not deployed'}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className={s.note}>Testnet vaults are Rein’s own mirror vaults on mock USDC, for demonstration only.</p>
      </section>
    </>
  );
}

function FeatureCard({ p, children }: { p: DocPage; children: ReactNode }) {
  return (
    <Link href={p.href} className={s.featureCard}>
      <div className={s.cardTop}>
        <span>{p.group}</span>
        <span>{docNum(p)}</span>
      </div>
      <h2>{p.title}</h2>
      <p>{p.description}</p>
      <div className={s.chips}>{children}</div>
      <span className={s.arrow} aria-hidden="true">
        ↗
      </span>
    </Link>
  );
}

function TopicCard({ p }: { p: DocPage }) {
  return (
    <Link href={p.href} className={s.topicCard}>
      <div className={s.cardTop}>
        <span>{p.group}</span>
        <span>{docNum(p)}</span>
      </div>
      <h3>{p.title}</h3>
      <p>{p.description}</p>
      <span className={s.read}>Read →</span>
    </Link>
  );
}

/** The hero slip: Rein in five lines, printed like one of its own receipts. */
function OneBreath() {
  const rows: [string, string][] = [
    ['Reads', 'one vault, at one pinned block'],
    ['Judges', 'in a NEAR AI enclave, signed'],
    ['Checks', 'on the NEAR desk, before posting'],
    ['Posts', 'to Rein’s oracle on Base or Monad'],
    ['Grades', 'against later readings, in public'],
  ];
  return (
    <aside aria-label="Rein in one breath" className={`torn ${s.slip}`}>
      <div className={s.cardTop}>
        <span>Rein · Docs</span>
        <span>#00</span>
      </div>
      <b className={s.slipTitle}>Rein in one breath</b>
      <span className={s.slipStamp} aria-hidden="true">
        Plain
      </span>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className={s.slipFoot}>A signal · never holds your shares</p>
    </aside>
  );
}
