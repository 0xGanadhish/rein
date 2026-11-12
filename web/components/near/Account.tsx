'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { DeskOrder } from '../../../shared/desk';
import { STATUS } from '../orders/OrdersList';
import { useNearWallet } from './NearWallet';
import { amount, units } from '@/lib/format';
import { NEAR_EXPLORER } from '@/lib/receipt';
import { vaultName } from '@/lib/vaults';
import styles from '../Header.module.css';

interface Wallet {
  near: string | null;
  usdc: string | null;
  usdcToken: string | null;
  orders: DeskOrder[] | null;
}

/** What an account has paid Rein, per rail: "1.5 USDC · 0.2 NEAR". Refunded orders don't count. */
function spent(orders: DeskOrder[]): string {
  let usdc = 0n;
  let near = 0n;
  for (const o of orders) {
    if (o.status === 'refunded') continue;
    if (o.source === 'near') near += BigInt(o.amount);
    else if (o.source !== 'watch') usdc += BigInt(o.amount);
  }
  const parts = [usdc > 0n && `${amount(String(usdc), 6)} USDC`, near > 0n && `${amount(String(near), 24)} NEAR`];
  return parts.filter(Boolean).join(' · ') || 'Nothing yet';
}

export function Account() {
  const { account, network, connect, disconnect } = useNearWallet();
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Read balances and orders each time the panel opens, so they're current after a payment.
  useEffect(() => {
    if (!open || !account) return;
    let live = true;
    setFailed(false);
    fetch(`/api/wallet?account=${encodeURIComponent(account)}`)
      .then((r) => (r.ok ? (r.json() as Promise<Wallet>) : Promise.reject(new Error(String(r.status)))))
      .then((w) => live && setWallet(w))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [open, account]);

  // Close on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (ref.current) ref.current.open = false;
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!account) {
    return (
      <button type="button" className={styles.connect} onClick={() => void connect()}>
        Connect NEAR
      </button>
    );
  }

  const orders = wallet?.orders ?? null;
  const loading = !wallet && !failed;
  const close = () => {
    if (ref.current) ref.current.open = false;
  };

  return (
    <details ref={ref} className={styles.account} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={styles.accountPill}>
        <span className={styles.avatar} aria-hidden="true" />
        {account}
      </summary>
      <div className={styles.menu} role="dialog" aria-label="Wallet">
        <div className={styles.wHead}>
          <span className={styles.k}>NEAR {network}</span>
          <b className={styles.wName}>{account}</b>
          <div className={styles.wLinks}>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(account).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a href={`${NEAR_EXPLORER[network]}${account}`} target="_blank" rel="noreferrer">
              NearBlocks ↗
            </a>
          </div>
        </div>

        <div className={styles.wSection}>
          <span className={styles.k}>Balances</span>
          <div className={styles.wBalances} aria-busy={loading || undefined}>
            <div>
              <b>{wallet?.near ? units(wallet.near, 24, 3) : loading ? '…' : '–'}</b>
              <span>NEAR</span>
            </div>
            <div>
              <b>{wallet?.usdc ? units(wallet.usdc, 6, 2) : loading ? '…' : '–'}</b>
              <span>USDC on NEAR</span>
            </div>
          </div>
          {failed && <p className={styles.wNote}>Balances can’t be read right now.</p>}
        </div>

        <div className={styles.wSection}>
          <span className={styles.k}>On Rein</span>
          {orders === null ? (
            <p className={styles.wNote}>{loading ? 'Reading your orders…' : 'Orders can’t be read right now.'}</p>
          ) : orders.length === 0 ? (
            <p className={styles.wNote}>
              No orders yet.{' '}
              <Link href="/judge" onClick={close}>
                Judge a vault
              </Link>
            </p>
          ) : (
            <>
              <dl className={styles.wStats}>
                <div>
                  <dt>Orders</dt>
                  <dd>{orders.length}</dd>
                </div>
                <div>
                  <dt>Delivered</dt>
                  <dd>{orders.filter((o) => o.status === 'delivered').length}</dd>
                </div>
                <div>
                  <dt>Paid</dt>
                  <dd>{spent(orders)}</dd>
                </div>
              </dl>
              <ul className={styles.wOrders}>
                {orders.slice(0, 3).map((o) => (
                  <li key={o.id}>
                    <Link href={`/orders/${o.id}`} onClick={close}>
                      <span className={styles.wId}>#{o.id}</span>
                      <span className={styles.wVault}>{vaultName(o.chain, o.vault)}</span>
                      <span className={styles.wStatus} data-status={o.status}>
                        {STATUS[o.status]}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link href="/orders" className={styles.wAll} onClick={close}>
                All orders →
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className={styles.wDisconnect}
          onClick={() => {
            close();
            void disconnect();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Disconnect
        </button>
      </div>
    </details>
  );
}
