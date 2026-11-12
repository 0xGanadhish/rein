'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, type ReactNode } from 'react';
import { DOC_GROUPS, DOC_PAGES, docPage } from './navigation';
import styles from './docs.module.css';

/**
 * The frame around every docs page. The hub (/docs) is full width; a topic page gets the grouped sidebar on wide
 * screens, a scrolling topic strip on phones, an eyebrow naming its group, and previous/next cards at the bottom.
 */
export function DocsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const page = docPage(pathname);
  const strip = useRef<HTMLElement>(null);
  // On phones, bring the current topic's chip into view in the strip.
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && strip.current)
      strip.current.scrollLeft = el.offsetLeft - strip.current.offsetWidth / 2 + el.offsetWidth / 2;
  }, [pathname]);
  if (!page || page.href === '/docs') return <div className={styles.hub}>{children}</div>;

  const i = DOC_PAGES.indexOf(page);
  const prev = DOC_PAGES[i - 1];
  const next = DOC_PAGES[i + 1];
  return (
    <div className={styles.layout}>
      <nav aria-label="Documentation" className={styles.sidebar}>
        <Link href="/docs" className={styles.back}>
          ← All docs
        </Link>
        {DOC_GROUPS.map((g) => (
          <div key={g} className={styles.group}>
            <span className={styles.eyebrow}>{g}</span>
            <ol>
              {DOC_PAGES.filter((p) => p.group === g && p.href !== '/docs').map((p) => (
                <li key={p.href}>
                  <Link href={p.href} aria-current={p.href === pathname ? 'page' : undefined}>
                    {p.title}
                  </Link>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </nav>

      <div className={styles.main}>
        <nav ref={strip} aria-label="Docs topics" className={styles.strip}>
          <Link href="/docs">All docs</Link>
          {DOC_PAGES.filter((p) => p.href !== '/docs').map((p) => (
            <Link key={p.href} href={p.href} aria-current={p.href === pathname ? 'page' : undefined}>
              {p.title}
            </Link>
          ))}
        </nav>
        <article className={styles.article}>
          <span className={styles.eyebrow}>Docs · {page.group}</span>
          {children}
          <nav aria-label="Previous and next" className={styles.pager}>
            {prev ? <PageLink href={prev.href} title={prev.title} dir="prev" /> : <span />}
            {next && <PageLink href={next.href} title={next.title} dir="next" />}
          </nav>
        </article>
      </div>
    </div>
  );
}

function PageLink({ href, title, dir }: { href: string; title: string; dir: 'prev' | 'next' }) {
  return (
    <Link href={href} className={styles.pageLink} data-dir={dir}>
      <span className={styles.eyebrow}>{dir === 'prev' ? '← Previous' : 'Next →'}</span>
      <b>{title}</b>
    </Link>
  );
}
