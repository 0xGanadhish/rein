'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { DeskChain } from '../../../shared/desk';
import { useNearWallet } from '@/components/near/NearWallet';
import { orderIdFrom } from '@/lib/orders';
import { amount, duration } from '@/lib/format';
import s from './judge.module.css';

export interface MenuVault {
  chain: DeskChain;
  vault: string;
  name: string;
  short: string;
  tvlUsd: number | null;
  tvl: string | null;
  withdrawable: number | null;
  last: string | null;
}

interface Policy {
  priceNear: string;
  priceUsdc: string;
  usdcToken: string | null;
  deadlineS: number;
  spacingS: number;
  kill: boolean;
}

type Rail = 'near' | 'usdc' | 'x402';
const CHAIN_LABEL: Record<DeskChain, string> = { base: 'Base', monad: 'Monad', 'monad-testnet': 'Monad testnet', 'base-sepolia': 'Base Sepolia' };

export function JudgeForm({ menu, initial, policy, sample, api }: {
  menu: MenuVault[];
  initial: string | null;
  policy: Policy | null;
  sample: boolean;
  api: string | null;
}) {
  const router = useRouter();
  const { account, connect, call, desk } = useNearWallet();
  const chains = useMemo(() => [...new Set(menu.map((v) => v.chain))], [menu]);
  const first = menu.find((v) => v.vault.toLowerCase() === initial) ?? menu[0];
  const [chain, setChain] = useState<DeskChain | undefined>(first?.chain);
  const [picked, setPicked] = useState<string | undefined>(first?.vault);
  const [query, setQuery] = useState('');
  const [rail, setRail] = useState<Rail>(policy && !policy.usdcToken ? 'near' : 'usdc');
  const [state, setState] = useState<{ k: 'idle' } | { k: 'signing' } | { k: 'error'; msg: string }>({ k: 'idle' });

  const list = menu.filter((v) => v.chain === chain && (!query || `${v.name} ${v.vault}`.toLowerCase().includes(query.toLowerCase())));
  const sel = menu.find((v) => v.chain === chain && v.vault === picked) ?? list[0];

  const rails: { id: Rail; name: string; note: string; off?: string }[] = [
    { id: 'near', name: 'NEAR', note: policy ? `${amount(policy.priceNear, 24)} NEAR from your wallet` : 'From your NEAR wallet' },
    { id: 'usdc', name: 'USDC on NEAR', note: policy ? `${amount(policy.priceUsdc, 6)} USDC, one transfer` : 'One transfer', off: policy && !policy.usdcToken ? 'USDC orders are off' : undefined },
    { id: 'x402', name: 'x402', note: 'For agents, over HTTP' },
  ];
  const price = !policy ? '–' : rail === 'near' ? `${amount(policy.priceNear, 24)} NEAR` : `${amount(policy.priceUsdc, 6)} USDC`;

  const blocked = sample ? 'Sample data: payments are off.'
    : !desk || !policy ? 'The desk isn’t live on this network yet.'
      : policy.kill ? 'The desk is paused. Nothing can be ordered right now.'
        : !sel ? 'Pick a vault first.' : null;

  async function pay() {
    if (!sel || !policy || !desk) return;
    if (!account) { await connect(); return; }
    setState({ k: 'signing' });
    try {
      const args = { chain: sel.chain, vault: sel.vault.toLowerCase() };
      const outcome = rail === 'near'
        ? await call({ receiverId: desk, methodName: 'request_judgement', args, deposit: policy.priceNear })
        : await call({
          receiverId: policy.usdcToken!, methodName: 'ft_transfer_call', deposit: '1',
          args: { receiver_id: desk, amount: policy.priceUsdc, msg: JSON.stringify(args) },
        });
      const id = orderIdFrom(outcome);
      router.push(id !== null ? `/orders/${id}` : '/orders');
    } catch (e) {
      setState({ k: 'error', msg: e instanceof Error ? e.message : 'The wallet didn’t send it.' });
    }
  }

  const curl = `curl -i -X POST ${api ?? 'https://<worker>'}/v1/x402/judge \\
  -H 'content-type: application/json' \\
  -d '{"chain":"${sel?.chain ?? 'base'}","vault":"${sel?.vault.toLowerCase() ?? '0x…'}"}'`;

  return (
    <div className={s.grid}>
      <section aria-labelledby="pick" className={s.pick}>
        <div className={s.row}>
          <h2 id="pick" className={s.h2}><span className={s.n}>01</span>Vault</h2>
          {chains.length > 1 && (
            <div role="group" aria-label="Chain" className={s.chains}>
              {chains.map((c) => (
                <button key={c} type="button" className={s.chainBtn} aria-pressed={c === chain} onClick={() => { setChain(c); setPicked(undefined); }}>{CHAIN_LABEL[c]}</button>
              ))}
            </div>
          )}
        </div>
        <label className={s.search}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <span className="visually-hidden">Search vaults</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${menu.filter((v) => v.chain === chain).length} vaults by name or address`} />
        </label>
        <div className={s.cols} aria-hidden="true"><span /><span>NAME</span><span>WITHDRAWABLE</span><span className={s.right}>TVL</span></div>
        <div role="radiogroup" aria-label="Vault" className={s.list}>
          {list.map((v) => (
            <button key={v.vault} type="button" role="radio" aria-checked={v === sel} className={s.opt} onClick={() => setPicked(v.vault)}>
              <span className={s.dot} />
              <span className={s.optName}><span>{v.name}</span><small>{v.short}{v.last && ` · last call ${v.last}`}</small></span>
              {v.withdrawable === null ? <span className={s.optMono}>–</span> : (
                <span className={s.meter}><span className={s.track}><span className={s.fill} data-low={v.withdrawable < 15 || undefined} style={{ width: `${v.withdrawable}%` }} /></span><span className={s.optMono}>{v.withdrawable.toFixed(1)}%</span></span>
              )}
              <span className={`${s.optMono} ${s.right} ${s.hideSm}`}>{v.tvl ?? '–'}</span>
            </button>
          ))}
          {list.length === 0 && <p className={s.empty}>{menu.length === 0 ? 'The menu is empty on this network.' : 'No vault matches that.'}</p>}
        </div>
        <p className={s.note}>Withdrawable share and TVL are from the Base read in docs/vaults.md; the model reads them fresh for your call.</p>
      </section>

      <aside aria-label="Order" className={s.side}>
        <section aria-labelledby="payh" className={s.card}>
          <h2 id="payh" className={s.h2}><span className={s.n}>02</span>Pay with</h2>
          <div role="radiogroup" aria-label="Payment" className={s.rails}>
            {rails.map((r) => (
              <button key={r.id} type="button" role="radio" aria-checked={r.id === rail} className={s.rail} disabled={!!r.off} onClick={() => setRail(r.id)}>
                <span className={s.railName}>{r.name}</span>
                <span className={s.railNote}>{r.off ?? r.note}</span>
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="sum" className={s.summary}>
          <h2 id="sum" className={s.sumLabel}>Your order</h2>
          <div className={s.sumName}>{sel?.name ?? 'No vault picked'}</div>
          <div className={s.sumMeta}>{sel ? `${CHAIN_LABEL[sel.chain]} · ${sel.short}` : '–'}</div>
          <dl className={s.sumList}>
            <div><dt>Price</dt><dd className={s.optMono}>{price}</dd></div>
            <div><dt>Escrow</dt><dd>{rail === 'x402' ? 'None: pay on delivery' : 'Held by the desk contract'}</dd></div>
            <div><dt>If it doesn’t land</dt><dd>{policy ? `Refund after ${duration(policy.deadlineS)}` : 'Refunded after the deadline'}</dd></div>
          </dl>

          {rail === 'x402' ? (
            <div className={s.agent}>
              <p>Agents pay per call. The first request answers 402 with the price; send it again with an <code>X-PAYMENT</code> header and the signed post comes back.</p>
              <pre className={s.code}>{curl}</pre>
            </div>
          ) : (
            <>
              <button type="button" className={s.pay} disabled={!!blocked || state.k === 'signing'} onClick={() => void pay()}>
                {state.k === 'signing' ? (<><span className={s.spin} aria-hidden="true" />Waiting for your wallet…</>)
                  : !account && !blocked ? 'Connect NEAR to pay' : 'Pay & judge'}
                {state.k !== 'signing' && <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h10M8 3l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
              <p className={s.fine} role={state.k === 'error' ? 'alert' : undefined}>
                {state.k === 'error' ? state.msg
                  : blocked ?? `The desk won’t take a new paid order on a vault it judged in the last ${duration(policy?.spacingS ?? 600)}.`}
              </p>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
