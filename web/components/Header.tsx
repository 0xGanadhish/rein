import Link from 'next/link';
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

export function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className={styles.bar}>
      <div className={`container ${styles.inner}`}>
        <div className={styles.left}>
          <Link href="/" className={styles.brand} aria-label="Rein home">
            <Mark />
            <span className={styles.word}>rein</span>
          </Link>
          <nav aria-label="App" className={styles.nav}>
            <Link href="/ledger" className={styles.tab} aria-current="page">Ledger</Link>
          </nav>
        </div>
        {children}
      </div>
    </header>
  );
}
