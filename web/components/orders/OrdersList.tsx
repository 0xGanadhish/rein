'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DeskOrder } from '../../../shared/desk';
import { useNearWallet } from '@/components/near/NearWallet';
import { amount, utcStamp } from '@/lib/format';
import { shortAddress, vaultName } from '@/lib/vaults';
import s from './orders.module.css';

const STATUS: Record<DeskOrder['status'], string> = {
  open: 'Open', exit_pending: 'EXIT pending', signing: 'Signing', signed: 'Signed', delivered: 'Delivered', rejected: 'Rejected', refunded: 'Refunded', post_failed: 'Post failed',
};

function paid(o: DeskOrder): string {
  if (o.source === 'near') return `${amount(o.amount, 24)} NEAR`;
  if (o.source === 'watch') return 'watch';
  return `${amount(o.amount, 6)} USDC${o.source === 'x402' ? ' · x402' : ''}`;
}

export function OrdersList({ samplePayer }: { samplePayer: string | null }) {
  const { account, connect } = useNearWallet();
  const router = useRouter();
  const payer = account ?? samplePayer;
  const [orders, setOrders] = useState<DeskOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');

  useEffect(() => {
    if (!payer) return;
    let live = true;
    setOrders(null);
    setError(null);
    fetch(`/api/orders?payer=${encodeURIComponent(payer)}`)
      .then(async (r) => {
        const body = (await r.json()) as { orders?: DeskOrder[]; error?: string };
        if (!live) return;
        if (body.orders) setOrders(body.orders); else setError(body.error ?? 'Orders can’t be read right now.');
      })
      .catch(() => live && setError('Orders can’t be read right now.'));
    return () => { live = false; };
  }, [payer]);

  return (
    <>
      <div className={s.head}>
        <div>
          <div className={`label ${s.eyebrow}`}>
            <span>My orders</span>
            {!account && samplePayer && <span className={s.sample}>· Sample data for {samplePayer}</span>}
          </div>
          <h1 className={s.title}>Every call you paid for.</h1>
        </div>
        <form className={s.lookup} onSubmit={(e) => { e.preventDefault(); if (/^\d+$/.test(lookup)) router.push(`/orders/${lookup}`); }}>
          <label htmlFor="lookup" className="visually-hidden">Order number</label>
          <input id="lookup" inputMode="numeric" placeholder="Order #" value={lookup} onChange={(e) => setLookup(e.target.value.trim())} />
          <button type="submit">Open</button>
        </form>
      </div>

      {!payer ? (
        <div className={s.empty}>
          <p>Connect the NEAR account you paid from to see your orders.</p>
          <button type="button" className={s.cta} onClick={() => void connect()}>Connect NEAR</button>
        </div>
      ) : error ? (
        <div className={s.empty} role="alert"><p>{error}</p></div>
      ) : orders === null ? (
        <div className={s.loading} aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>
      ) : orders.length === 0 ? (
        <div className={s.empty}>
          <p>No orders from {payer} yet.</p>
          <Link href="/judge" className={s.cta}>Judge a vault</Link>
        </div>
      ) : (
        <ul className={s.list}>
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/orders/${o.id}`} className={s.row}>
                <span className={s.id}>#{o.id}</span>
                <span className={s.vault}><b>{vaultName(o.chain, o.vault)}</b><small>{o.chain} · {shortAddress(o.vault)}</small></span>
                <span className={s.mono}>{paid(o)}</span>
                <span className={s.mono}>{utcStamp(o.created_s)}</span>
                <span className={s.status} data-status={o.status}>{STATUS[o.status]}</span>
                <span className={s.go} aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
