import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { HowItWorks } from '@/components/how/HowItWorks';

export const metadata: Metadata = { title: 'How it works' };

export default function HowPage() {
  return (
    <>
      <Header active="how" />
      <main className="container" style={{ paddingTop: 'clamp(32px, 4vw, 56px)', paddingBottom: 80 }}>
        <HowItWorks />
      </main>
    </>
  );
}
