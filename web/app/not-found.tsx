import type { Metadata } from 'next';
import Link from 'next/link';
import { Header } from '@/components/Header';
import s from '@/components/how/how.module.css';

export const metadata: Metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <>
      <Header />
      <main className="container" style={{ paddingTop: 'clamp(32px, 4vw, 56px)', paddingBottom: 80 }}>
        <header className={s.page}>
          <div className="label">404</div>
          <h1 className={s.title}>No page here.</h1>
          <p className={s.lede}>
            The link may be old or mistyped. The <Link href="/ledger">Ledger</Link> lists every graded call, and the{' '}
            <Link href="/docs">Docs</Link> explain how Rein works.
          </p>
        </header>
      </main>
    </>
  );
}
