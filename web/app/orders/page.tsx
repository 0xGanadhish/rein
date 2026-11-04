import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { OrdersList } from '@/components/orders/OrdersList';
import { publicConfig } from '@/lib/config';

export const metadata: Metadata = { title: 'My orders' };

/** In sample mode there's no wallet to connect, so the page shows this sample payer's orders. */
const SAMPLE_PAYER = 'vault-watch.near';

export default function OrdersPage() {
  const { sample } = publicConfig();
  return (
    <>
      <Header active="orders" />
      <main className="container" style={{ paddingTop: 'clamp(32px, 4vw, 56px)', paddingBottom: 80 }}>
        <OrdersList samplePayer={sample ? SAMPLE_PAYER : null} />
      </main>
    </>
  );
}
