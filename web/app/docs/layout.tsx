import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/Header';
import { DocsNav } from '@/components/docs/DocsNav';
import styles from '@/components/docs/docs.module.css';

export const metadata: Metadata = { title: { default: 'Docs', template: '%s · Rein docs' } };

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header active="docs" />
      <main className={`container ${styles.layout}`}>
        <DocsNav />
        <article className={styles.article}>{children}</article>
      </main>
    </>
  );
}
