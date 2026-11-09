'use client';

import { usePathname } from 'next/navigation';
import type { Network } from '@/lib/ledger';
import styles from './Header.module.css';

const LABEL: Record<Network, string> = { mainnet: 'Mainnet', testnet: 'Testnet' };

/**
 * Switches every page between mainnet and testnet, each with its own desk and Worker. The middleware turns
 * `?network=` into a cookie. Plain links reload the page, so the wallet reconnects on the new network.
 */
export function NetworkSwitch({ network }: { network: Network }) {
  const path = usePathname();
  return (
    <nav aria-label="NEAR network" className={styles.network}>
      {(['mainnet', 'testnet'] as const).map((n) => (
        <a key={n} href={`${path}?network=${n}`} className={styles.netItem} aria-current={n === network || undefined}>
          {n === network && <span className={styles.netDot} aria-hidden="true" />}
          {LABEL[n]}
        </a>
      ))}
    </nav>
  );
}
