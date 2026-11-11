import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { DeskOrderStatus } from '../../../../shared/desk';
import { Header } from '@/components/Header';
import { AutoRefresh } from '@/components/orders/AutoRefresh';
import { ExitAlertButton } from '@/components/orders/ExitAlertButton';
import { ReceiptStamp } from '@/components/orders/ReceiptStamp';
import { RefundButton } from '@/components/orders/RefundButton';
import s from '@/components/orders/receipt.module.css';
import { publicConfig } from '@/lib/config';
import { readDesk, readOrder, type OrderDetail } from '@/lib/desk';
import { refundable } from '@/lib/orders';
import { CHAIN_LABEL as CHAIN, STATUS_LABEL as LABEL, isExitOrder, proofChain, statusTrack } from '@/lib/receipt';
import { hotFields, parseDoc } from '@/lib/doc';
import { amount, bpsPct, reasonLabels, utcStamp } from '@/lib/format';
import { shortAddress, vaultName } from '@/lib/vaults';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  return { title: `Order #${(await params).id}` };
}

const FLOW: DeskOrderStatus[] = ['open', 'exit_pending', 'signing', 'signed', 'delivered'];

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M2 6.5 4.8 9 10 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function paidLine(o: OrderDetail): string {
  if (o.source === 'watch')
    return 'Opened by the desk’s own watch feed after the vault moved. Nobody paid; the desk judged it on its own.';
  if (o.source === 'x402') return `${amount(o.amount, 6)} USDC paid upfront over x402. There is no onchain escrow.`;
  const paid =
    o.source === 'near'
      ? `${amount(o.amount, 24)} NEAR via request_judgement`
      : `${amount(o.amount, 6)} USDC via ft_transfer_call`;
  return `${paid}${o.payer ? ` from ${o.payer}` : ''}. Held by the desk until delivery.`;
}

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 0) notFound();
  const cfg = await publicConfig();
  let order: OrderDetail | null;
  try {
    order = await readOrder(id);
  } catch (e) {
    return (
      <div className={s.page}>
        <Header active="orders" dark />
        <main className="container" style={{ paddingBlock: 64 }}>
          <div className={s.error} role="alert">
            <h1>Order #{id} can’t be read right now.</h1>
            <p>{e instanceof Error ? e.message : ''} It’s still on the desk contract; try again in a minute.</p>
          </div>
        </main>
      </div>
    );
  }
  if (!order) notFound();
  const desk = await readDesk();

  const post = order.posts.at(-1) ?? null;
  // exit_pending means the first reading said EXIT and the desk is waiting to confirm it.
  const verdict = post?.verdict ?? (order.status === 'exit_pending' ? 'EXIT' : null);
  const status = order.status;
  const failed = status === 'rejected' || status === 'refunded' || status === 'post_failed';
  const reached = FLOW.indexOf(status);
  const isExit = isExitOrder(order);
  const chain = proofChain(order, cfg.network, {
    desk: cfg.desk,
    signers: desk?.signers ?? null,
    derived_address: desk?.derived_address ?? null,
  });
  const judged = order.judge_calls[0];
  const confirmed = order.judge_calls[1];
  const fields = post?.doc ? parseDoc(post.doc) : [];
  const hot = hotFields(fields);
  const field = Object.fromEntries(fields);
  const canRefund = refundable(order, desk?.policy ?? null, Date.now() / 1000);
  const finished = status === 'delivered' || failed;
  const past = (st: DeskOrderStatus) => reached >= FLOW.indexOf(st);

  const steps: {
    title: string;
    at?: number;
    done: boolean;
    live?: boolean;
    signal?: boolean;
    body: React.ReactNode;
  }[] = [
    {
      title: order.source === 'watch' ? 'Watch order opened' : 'Order paid',
      at: order.created_s,
      done: true,
      body: <p>{paidLine(order)}</p>,
    },
    {
      title: 'Model answered, enclave signed',
      at: judged?.at,
      done: !!judged,
      live: !judged && !failed,
      body: judged ? (
        <>
          <p>NEAR AI private inference in a TEE. Its signature covers the exact request and response bytes.</p>
          <div className={s.mono}>
            signing_address <b>{judged.signing_address}</b>
            {verdict && post && (
              <>
                <br />
                answer{' '}
                <b className={verdict === 'EXIT' ? s.hot : undefined}>
                  {verdict} · confidence {bpsPct(post.confidence_bps)} · risk {bpsPct(post.risk_bps)}
                </b>
              </>
            )}
          </div>
        </>
      ) : (
        <p>Waiting for the agent to read the vault and ask the model.</p>
      ),
    },
    {
      title: 'Desk contract verified the reading',
      at: judged?.at,
      done: past('exit_pending') || past('signing'),
      body: (
        <div className={s.chips}>
          {['signer known', `order ${order.id}`, `chain ${order.chain}`, 'vault match', 'doc fresh'].map((c) => (
            <span key={c} className={s.chip}>
              {c}
            </span>
          ))}
          <span className={s.chip} data-on={past('signing') || status === 'exit_pending' || undefined}>
            check_reading → ok
          </span>
        </div>
      ),
    },
    ...(isExit
      ? [
          {
            title: 'EXIT confirmed by a second reading',
            at: confirmed?.at,
            done: past('signing'),
            live: status === 'exit_pending',
            signal: true,
            body: (
              <p>
                An EXIT waits inside the confirm window and is judged again at a newer block before anything is signed.
                {past('signing') ? ' Both readings said leave.' : ''}
              </p>
            ),
          },
        ]
      : []),
    {
      title: 'Signed with NEAR Chain Signatures',
      done: past('signed'),
      live: status === 'signing',
      body: (
        <p>
          The desk’s derived {CHAIN[order.chain]} address signs the oracle post. The fee is capped by the desk; no hot
          key is involved.
        </p>
      ),
    },
    {
      title: `Delivered to the Rein oracle on ${CHAIN[order.chain]}`,
      at: post?.posted_at,
      done: status === 'delivered',
      live: status === 'signed',
      body: (
        <p>
          {post
            ? `Verdict #${post.id} on the oracle. Guardian positions on this vault can act on it now.`
            : 'The signed post is broadcast and confirmed onchain.'}
        </p>
      ),
    },
  ];
  if (failed) {
    const why =
      status === 'refunded'
        ? 'The order missed its deadline, the kill switch was on, or its signed post expired without landing.'
        : status === 'post_failed'
          ? 'The signed post never landed onchain: it reverted or expired.'
          : 'The desk refused this order.';
    const money =
      order.source === 'x402'
        ? ' The x402 payment became a credit for one free judgement; send the same payment again to redeem it.'
        : order.source === 'watch'
          ? ''
          : ' The desk sent the escrow back to the payer in full. If that transfer failed, the amount is held as owed and can be claimed with claim_owed.';
    steps.push({
      title: status === 'rejected' ? 'Rejected' : 'Refund authorized',
      done: true,
      signal: true,
      body: (
        <p>
          {why}
          {money}
        </p>
      ),
    });
  }

  return (
    <div className={s.page}>
      {!finished && <AutoRefresh seconds={5} />}
      <Header active="orders" dark />
      <main className="container" style={{ paddingTop: 'clamp(28px, 4vw, 48px)', paddingBottom: 80 }}>
        <div className={s.top}>
          <Link href="/orders" className={s.back}>
            ← My orders
          </Link>
          {cfg.sample && <span className={s.sample}>Sample data</span>}
        </div>
        {order.indexing && (
          <p role="status" className={s.indexing}>
            Pending indexing. The desk has this order; its readings and proof links appear here within a minute or two.
          </p>
        )}

        <ol aria-label="Order status" className={s.status}>
          {statusTrack(order).map((st) => (
            <li
              key={st.status}
              data-done={st.done || undefined}
              data-signal={((st.status === 'exit_pending' || failed) && st.done) || undefined}
              data-now={st.now || undefined}
            >
              <span className={s.bar} />
              <span>{st.label}</span>
            </li>
          ))}
        </ol>

        <div className={s.grid}>
          <article aria-label="Signed call" className={`${s.receipt} torn`}>
            <div className={s.rHead}>
              <span>REIN · {post ? 'SIGNED CALL' : 'ORDER'}</span>
              <span>#{order.id}</span>
            </div>
            <h1 className={s.vault}>{vaultName(order.chain, order.vault)}</h1>
            <div className={s.addr}>
              {order.chain} · {order.vault}
            </div>

            <div className={s.stampZone}>
              {/* One component for both branches, so it is already mounted while the order is pending. */}
              <ReceiptStamp status={status} verdict={verdict ?? 'none'} className={s.stamp} playClassName={s.stampPlay}>
                {verdict ? (
                  <>
                    <span className={s.stampWord}>{verdict}</span>
                    <span className={s.stampSub}>
                      {verdict === 'EXIT'
                        ? past('signing')
                          ? 'READ TWICE · AGREED'
                          : 'CONFIRMING'
                        : status === 'delivered'
                          ? 'SIGNED · DELIVERED'
                          : 'SIGNING'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={s.stampWord}>{failed ? LABEL[status].toUpperCase() : 'JUDGING'}</span>
                    <span className={s.stampSub}>{failed ? 'NO CALL POSTED' : 'THE MODEL IS READING THE VAULT'}</span>
                  </>
                )}
              </ReceiptStamp>
            </div>

            <dl className={s.facts}>
              <div>
                <dt>Confidence</dt>
                <dd className={s.big}>{post ? bpsPct(post.confidence_bps) : '–'}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd className={s.big}>{post ? bpsPct(post.risk_bps) : '–'}</dd>
              </div>
              <div>
                <dt>Read at block</dt>
                <dd>{field.block ? Number(field.block).toLocaleString('en-US') : '–'}</dd>
              </div>
              <div>
                <dt>Posted</dt>
                <dd>{post ? `${utcStamp(post.posted_at)} UTC` : '–'}</dd>
              </div>
            </dl>

            {fields.length > 0 && (
              <div className={s.saw}>
                <div className={s.k}>What the model saw</div>
                <p>
                  rein-v1
                  {fields.map(([k, v]) => (
                    <span key={k}>
                      |
                      {hot.has(k) ? (
                        <mark>
                          {k}={v}
                        </mark>
                      ) : (
                        `${k}=${v}`
                      )}
                    </span>
                  ))}
                </p>
              </div>
            )}

            <div className={s.rFoot}>
              <span className={s.hash}>
                {post ? `state ${shortAddress(post.state_hash)}` : `opened ${utcStamp(order.created_s)} UTC`}
              </span>
              <span className={s.hash}>
                {post?.input_check === 'mismatch'
                  ? 'input check: mismatch'
                  : post
                    ? `input check: ${post.input_check}`
                    : ''}
              </span>
            </div>
          </article>

          <section aria-labelledby="prov" className={s.prov}>
            <h2 id="prov" className={s.h2}>
              From the vault to the chain, step by step.
            </h2>
            <ol className={s.steps}>
              {steps.map((st) => (
                <li key={st.title} className={s.step}>
                  <span
                    className={s.node}
                    data-done={st.done || undefined}
                    data-live={st.live || undefined}
                    data-signal={(st.signal && st.done) || undefined}
                  >
                    {st.done && <Check />}
                  </span>
                  <div className={s.stepBody}>
                    <div className={s.stepHead}>
                      <span>{st.title}</span>
                      {st.at && <time>{utcStamp(st.at)}</time>}
                    </div>
                    {st.body}
                  </div>
                </li>
              ))}
            </ol>

            <div className={s.actions}>
              <Link href={`/guardian?vault=${order.vault}`} className={s.primary}>
                Guard this vault
              </Link>
              <Link href="/ledger" className={s.ghost}>
                See it on the Ledger
              </Link>
              {canRefund && <RefundButton orderId={order.id} className={s.ghost} />}
              <ExitAlertButton api={cfg.api} chain={order.chain} vault={order.vault} className={s.ghost} />
            </div>
            <section aria-labelledby="verify" className={s.grade}>
              <div>
                <h2 id="verify" className={s.h2}>
                  Verify this order
                </h2>
                <p>
                  Checks compare the stored document hash and the desk’s current signer list; they do not verify the
                  model signature or TEE attestation.
                </p>
                <ol className={`${s.links} ${s.proof}`} aria-label="Proof chain">
                  {chain.map((step) => (
                    <li key={step.label}>
                      <strong>{step.label}</strong>
                      {step.check !== undefined && (
                        <span>
                          {' '}
                          · {step.check === 'ok' ? 'Match' : step.check === 'fail' ? 'Mismatch' : 'Not checked'}
                        </span>
                      )}
                      <p className={s.mono}>{step.detail}</p>
                      {step.href && (
                        <a href={step.href} target="_blank" rel="noreferrer">
                          {step.label} ↗
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            {post && (
              <div className={s.grade}>
                <div>
                  <div className={s.k} style={{ color: 'var(--night-mute)' }}>
                    Ledger
                  </div>
                  <div>
                    {!post.resolved
                      ? 'Resolving. Graded once the outcome window closes.'
                      : post.adverse
                        ? `Graded: adverse${reasonLabels(post.reasons).length ? ` (${reasonLabels(post.reasons).join(', ')})` : ''}.`
                        : 'Graded: clean. Nothing went wrong in the window.'}
                  </div>
                </div>
                <span
                  className={s.gradeTag}
                  data-state={!post.resolved ? 'wait' : (verdict === 'EXIT') === !!post.adverse ? 'hit' : 'miss'}
                >
                  {!post.resolved ? 'pending' : (verdict === 'EXIT') === !!post.adverse ? 'hit' : 'miss'}
                </span>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
