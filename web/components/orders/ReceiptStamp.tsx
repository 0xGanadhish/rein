'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DeskOrderStatus } from '../../../shared/desk';

const FINISHED: DeskOrderStatus[] = ['delivered', 'rejected', 'refunded', 'post_failed'];

/**
 * The verdict stamp. It plays only when an order changes from a pending state to delivered while the page is open
 * (AutoRefresh re-renders the server page with the new status), never on opening an order that is already done.
 */
export function ReceiptStamp({
  status,
  verdict,
  className,
  playClassName,
  children,
}: {
  status: DeskOrderStatus;
  verdict: string;
  className: string;
  playClassName: string;
  children: ReactNode;
}) {
  const previous = useRef(status);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (previous.current === status) return;
    if (status === 'delivered' && !FINISHED.includes(previous.current)) setPlay(true);
    previous.current = status;
  }, [status]);
  return (
    <div className={play ? `${className} ${playClassName}` : className} data-verdict={verdict}>
      {children}
    </div>
  );
}
