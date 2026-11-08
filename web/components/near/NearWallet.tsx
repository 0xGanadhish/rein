'use client';

import type { NearConnector } from '@hot-labs/near-connect';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Network } from '@/lib/ledger';

type Outcome = Awaited<ReturnType<Awaited<ReturnType<NearConnector['wallet']>>['signAndSendTransaction']>>;

export interface FunctionCall {
  receiverId: string;
  methodName: string;
  args: object;
  /** yoctoNEAR, decimal string. */
  deposit: string;
  gas?: string;
}

interface NearWalletState {
  network: Network;
  /** The desk contract, null until deployed on this network. */
  desk: string | null;
  account: string | null;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  call(fc: FunctionCall): Promise<Outcome>;
}

const Ctx = createContext<NearWalletState | null>(null);
const GAS = '100000000000000';

/** The connected NEAR account, through NEAR Connect (HOT, Meteor, Intear, MyNearWallet and others). */
export function NearWalletProvider({ network, desk, children }: { network: Network; desk: string | null; children: React.ReactNode }) {
  const connector = useRef<NearConnector | null>(null);
  const [account, setAccount] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void import('@hot-labs/near-connect').then(({ NearConnector }) => {
      if (!live) return;
      const c = new NearConnector({ network });
      connector.current = c;
      c.on('wallet:signIn', (e) => setAccount(e.accounts[0]?.accountId ?? null));
      c.on('wallet:signOut', () => setAccount(null));
      c.getConnectedWallet().then(({ accounts }) => live && setAccount(accounts[0]?.accountId ?? null)).catch(() => {});
    });
    return () => { live = false; };
  }, [network]);

  const connect = useCallback(async () => { await connector.current?.connect(); }, []);
  const disconnect = useCallback(async () => { await connector.current?.disconnect(); setAccount(null); }, []);
  const call = useCallback(async (fc: FunctionCall) => {
    if (!connector.current) throw new Error('Wallet is still loading.');
    const wallet = await connector.current.wallet();
    return wallet.signAndSendTransaction({
      receiverId: fc.receiverId,
      actions: [{ type: 'FunctionCall', params: { methodName: fc.methodName, args: fc.args, gas: fc.gas ?? GAS, deposit: fc.deposit } }],
    });
  }, []);

  return <Ctx.Provider value={{ network, desk, account, connect, disconnect, call }}>{children}</Ctx.Provider>;
}

export function useNearWallet(): NearWalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNearWallet outside NearWalletProvider');
  return v;
}
