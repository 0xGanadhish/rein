'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOC_PAGES } from './navigation';
import styles from './docs.module.css';

export function DocsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Documentation" className={styles.sidebar}>
      <ol>
        {DOC_PAGES.map((page) => (
          <li key={page.href}>
            <Link href={page.href} aria-current={pathname === page.href ? 'page' : undefined}>
              {page.title}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
