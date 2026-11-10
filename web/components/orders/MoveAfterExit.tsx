'use client';

import { useState } from 'react';
import type { DeskChain } from '../../../shared/desk';
import { amount as formatAmount } from '@/lib/format';
import { ASSETS, depositQuote, type DepositQuote } from '@/lib/oneclick';
import s from './move.module.css';

export function MoveAfterExit({
  api,
  chain,
  amount,
  owner,
}: {
  api: string;
  chain: DeskChain;
  amount: bigint;
  owner: string;
}) {
  const [destination, setDestination] = useState(chain === 'base' ? 'monad' : 'base');
  const [recipient, setRecipient] = useState('');
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const originAsset = ASSETS[chain];

  async function getQuote() {
    if (!originAsset || !recipient.trim() || amount <= 0n) return;
    setQuote(null);
    setError(null);
    setBusy(true);
    try {
      setQuote(
        await depositQuote(api, {
          originAsset,
          amount: amount.toString(),
          destinationAsset: ASSETS[destination as DeskChain]!,
          recipient: recipient.trim(),
          refundTo: owner,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.panel} aria-labelledby="move-heading">
      <h2 id="move-heading">MOVE</h2>
      <p>Your Guardian rule is still enabled and you hold no shares in this vault.</p>
      <p>
        Current USDC balance on {chain === 'base' ? 'Base' : 'Monad'}:{' '}
        <strong>{formatAmount(amount.toString(), 6)} USDC</strong>. This may include funds beyond the exit.
      </p>
      <div className={s.fields}>
        <label>
          Destination chain
          <select
            value={destination}
            disabled={busy}
            onChange={(e) => {
              setDestination(e.target.value);
              setQuote(null);
              setError(null);
            }}
          >
            <option value="base">Base</option>
            <option value="monad">Monad</option>
          </select>
        </label>
        <label>
          Destination address
          <input
            value={recipient}
            disabled={busy}
            onChange={(e) => {
              setRecipient(e.target.value);
              setQuote(null);
              setError(null);
            }}
            placeholder="0x…"
            autoComplete="off"
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => void getQuote()}
        disabled={busy || !originAsset || !recipient.trim() || amount <= 0n}
      >
        {busy ? 'Getting quote…' : 'Get deposit address'}
      </button>
      {!originAsset && <p>Quotes are not supported on this chain.</p>}
      {error && <p role="alert">{error}</p>}
      {quote && (
        <div role="status">
          <p>
            Deposit address: <code>{quote.depositAddress}</code>
          </p>
          <p>
            Expires: <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>
          </p>
          <p>Send the USDC there yourself — Rein never holds funds. This quote does not send anything.</p>
        </div>
      )}
    </section>
  );
}
