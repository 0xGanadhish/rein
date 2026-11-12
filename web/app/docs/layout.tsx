import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/Header';
import { DocsFrame } from '@/components/docs/DocsNav';

export const metadata: Metadata = { title: { default: 'Docs', template: '%s · Rein docs' } };

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Header active="docs" />
      <main className="container">
        <DocsFrame>{children}</DocsFrame>
      </main>
    </>
  );
}
