import Link from 'next/link';
import { publicConfig } from '@/lib/config';
import { Account } from './near/Account';
import { NetworkSwitch } from './NetworkSwitch';
import styles from './Header.module.css';

/** Two rings joined by a taut line: the reins. */
export function Mark() {
  return (
    <svg width="30" height="14" viewBox="0 0 34 16" aria-hidden="true">
      <circle cx="5" cy="8" r="3.6" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="8.6" y1="8" x2="25.4" y2="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="29" cy="8" r="3.6" fill="var(--signal)" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export type Tab = 'ledger' | 'judge' | 'guardian' | 'orders' | 'how' | 'docs';
const TABS: { id: Tab; href: string; label: string }[] = [
  { id: 'ledger', href: '/ledger', label: 'Ledger' },
  { id: 'judge', href: '/judge', label: 'Judge' },
  { id: 'guardian', href: '/guardian', label: 'Guardian' },
  { id: 'orders', href: '/orders', label: 'My orders' },
  { id: 'how', href: '/how', label: 'How it works' },
  { id: 'docs', href: '/docs', label: 'Docs' },
];

/** The app bar. `dark` matches the night pages (receipt, Guardian). */
export async function Header({ active, dark = false }: { active?: Tab; dark?: boolean }) {
  const { network } = await publicConfig();
  return (
    <header className={styles.bar} data-dark={dark || undefined}>
      <div className={`container ${styles.inner}`}>
        <Link href="/" className={styles.brand} aria-label="Rein home">
          <Mark />
          <span className={styles.word}>rein</span>
        </Link>
        <nav aria-label="App" className={styles.nav}>
          {TABS.map((t) => (
            <Link key={t.id} href={t.href} className={styles.tab} aria-current={t.id === active ? 'page' : undefined}>
              {t.label}
            </Link>
          ))}
        </nav>
        <div className={styles.right}>
          <NetworkSwitch network={network} />
          <Account />
        </div>
      </div>
    </header>
  );
}
