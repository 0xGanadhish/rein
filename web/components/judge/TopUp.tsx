'use client';

import { useState } from 'react';
import { parseUnits } from 'viem';
import { useNearWallet } from '@/components/near/NearWallet';
import { depositQuote, USDC_ORIGINS, type DepositQuote } from '@/lib/oneclick';
import s from './topup.module.css';

/** Reads the connected account only; top-up never connects, signs, or sends through a wallet. */
export function AccountTopUp({ api }: { api: string }) {
  const { account, network } = useNearWallet();
  if (network !== 'mainnet')
    return <p className={s.note}>Cross-chain top-up uses mainnet USDC only, not testnet funds.</p>;
  return account ? (
    <TopUp key={account} api={api} recipientNear={account} />
  ) : (
    <p className={s.note}>
      Need USDC on NEAR? Connect your NEAR account above to get a cross-chain top-up deposit address.
    </p>
  );
}

export function TopUp({ api, recipientNear }: { api: string; recipientNear: string }) {
  const [origin, setOrigin] = useState('base');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rawAmount = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount) ? parseUnits(amount, 6) : 0n;

  async function getQuote() {
    if (rawAmount <= 0n || !recipientNear) return;
    setQuote(null);
    setError(null);
    setBusy(true);
    try {
      setQuote(
        await depositQuote(api, {
          originAsset: USDC_ORIGINS.find((x) => x.chain === origin)!.asset,
          amount: rawAmount.toString(),
          recipientNear,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Quote unavailable.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={s.panel} aria-labelledby="topup-heading">
      <h2 id="topup-heading">Pay from another chain</h2>
      <p>Top up {recipientNear} with mainnet USDC first. This does not place an order or pay the desk.</p>
      <div className={s.fields}>
        <label>
          Pay from
          <select
            value={origin}
            disabled={busy}
            onChange={(e) => {
              setOrigin(e.target.value);
              setQuote(null);
              setError(null);
            }}
          >
            {USDC_ORIGINS.map((x) => (
              <option key={x.chain} value={x.chain}>
                USDC on {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Amount (USDC)
          <input
            inputMode="decimal"
            value={amount}
            disabled={busy}
            placeholder="3.00"
            onChange={(e) => {
              setAmount(e.target.value);
              setQuote(null);
              setError(null);
            }}
          />
        </label>
      </div>
      <button type="button" onClick={() => void getQuote()} disabled={busy || rawAmount <= 0n || !recipientNear}>
        {busy ? 'Getting quote…' : 'Get deposit address'}
      </button>
      {error && <p role="alert">{error}</p>}
      {quote && (
        <div role="status">
          <p>
            Deposit address: <code>{quote.depositAddress}</code>
          </p>
          <p>
            Expires: <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>
          </p>
          <p>
            Send {amount} USDC on {USDC_ORIGINS.find((x) => x.chain === origin)!.name} there yourself — Rein never holds
            funds.
          </p>
          <p>
            Once USDC lands in {recipientNear}, pay the desk using USDC on NEAR with <code>ft_transfer_call</code>. That
            is a separate wallet transaction you initiate.
          </p>
        </div>
      )}
    </section>
  );
}
