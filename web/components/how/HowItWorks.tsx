import { TARE_SITE } from '@/lib/tare';
import s from './how.module.css';

const CHECKS: { title: string; body: string }[] = [
  {
    title: 'Only the agent can deliver, and only for an open order.',
    body: 'Nobody else can hand the desk an answer, and an order is answered once.',
  },
  {
    title: 'The prompt is the approved one.',
    body: 'The owner fixes the model, system prompt, temperature, token limit and output format on the desk. The contract builds the request itself around the vault reading.',
  },
  {
    title: 'The reading can’t escape the prompt.',
    body: 'It may hold only plain printable characters, so it can’t smuggle instructions out of its place in the request.',
  },
  {
    title: 'The reading belongs to this order.',
    body: 'It names this order, chain and vault, and is at most five minutes old. An answer can’t be replayed for another order or vault.',
  },
  {
    title: 'The model really said it.',
    body: 'The contract hashes the exact request and response and recovers the signer from NEAR AI’s TEE signature. Only a signer the owner approved for that model passes.',
  },
  {
    title: 'The answer is well formed.',
    body: 'The model must have finished normally and returned exactly an action, a confidence and a risk, each within range. The token counts it reports are covered by the same signature.',
  },
  {
    title: 'The rules allow it.',
    body: 'Spacing between calls on a vault, hourly caps, the kill switch, and a second reading before any EXIT.',
  },
];

const LIMITS: { title: string; body: string }[] = [
  {
    title: 'False inputs',
    body: 'The agent could show the model false numbers. The signature proves what the model answered, not that its inputs were true. Each post’s input check compares the reading with the state the oracle recorded onchain, so a false reading is detected, not prevented.',
  },
  {
    title: 'Signer approval',
    body: 'One owner key decides which model signers are valid and could approve a bad one. The evidence for every approval is public.',
  },
  {
    title: 'Withholding',
    body: 'The agent could ask the model several times and submit the answer it prefers, or refuse an order, which refunds the customer. Temperature 0 narrows the room for this, but answers can still vary. It can’t invent an answer.',
  },
  {
    title: 'The model',
    body: 'Its confidence is self-reported and uncalibrated. The Ledger grades every call in public, starting from no record.',
  },
  {
    title: 'Verifier scope',
    body: 'NEAR AI’s TEE signature proves that a key bound to a verified model report signed the answer. It doesn’t prove the same instance served that report.',
  },
  {
    title: 'Delivery reports',
    body: 'The desk trusts the agent’s delivery and failure reports and the fees in them; it doesn’t check EVM receipt proofs. If a post lands but isn’t reported before its expiry and grace, a customer could get both the post and a refund.',
  },
  {
    title: 'x402 payments',
    body: 'An agent paying over x402 pays upfront, before the desk works. If the post then fails, the payment becomes a credit for one free judgement, redeemed with the same payment. No money moves back.',
  },
];

export function HowItWorks() {
  return (
    <>
      <div className={s.head}>
        <div className="label">How it works</div>
        <h1 className={s.title}>Every call is checked before it’s signed.</h1>
        <p className={s.lede}>
          You pay the desk contract on NEAR. Its agent reads the vault and asks a model running in a TEE. The contract
          checks the signed answer, then NEAR Chain Signatures sign the post to the oracle on the vault’s chain.
        </p>
      </div>

      <section aria-labelledby="checks" className={s.section}>
        <h2 id="checks" className={s.h2}>
          What the desk checks
        </h2>
        <ol aria-label="What the desk checks" className={s.checks}>
          {CHECKS.map((c) => (
            <li key={c.title}>
              <b>{c.title}</b> {c.body}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="limits" className={s.section}>
        <h2 id="limits" className={s.h2}>
          What it doesn’t prove
        </h2>
        <ul aria-label="Disclosed limits" className={s.limits}>
          {LIMITS.map((l) => (
            <li key={l.title}>
              <h3>{l.title}</h3>
              <p>{l.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="tare" className={s.section}>
        <h2 id="tare" className={s.h2}>
          Tare
        </h2>
        <p className={s.body}>
          Rein grades its calls the same way as{' '}
          <a href={TARE_SITE} target="_blank" rel="noreferrer">
            Tare
          </a>
          , an earlier vault oracle. The Ledger shows Tare’s score from its public API for comparison; Tare’s posts
          aren’t signed by a TEE, so Rein doesn’t check them.
        </p>
      </section>
    </>
  );
}
