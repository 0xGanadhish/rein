'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useNearWallet } from '@/components/near/NearWallet';

/** Anyone may call `refund` once an order is past its deadline; the escrow goes back to the payer. */
export function RefundButton({ orderId, className }: { orderId: number; className: string }) {
  const { account, connect, call, desk } = useNearWallet();
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  if (!desk) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={async () => {
          if (!account) return void connect();
          try {
            await call({ receiverId: desk, methodName: 'refund', args: { order_id: orderId }, deposit: '0' });
            router.refresh();
          } catch (e) {
            setMsg(e instanceof Error ? e.message : 'The refund didn’t go through.');
          }
        }}
      >
        {account ? 'Refund this order' : 'Connect NEAR to refund'}
      </button>
      {msg && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--signal)' }}>
          {msg}
        </p>
      )}
    </>
  );
}
