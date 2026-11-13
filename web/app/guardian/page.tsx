import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { GuardianPanel, type GuardVault } from '@/components/guardian/GuardianPanel';
import { publicConfig } from '@/lib/config';
import { readDesk } from '@/lib/desk';
import { readLedger } from '@/lib/ledger';
import { SNAPSHOT, shortAddress, vaultName } from '@/lib/vaults';
import { DEPLOYMENTS } from '../../../shared/deployments';
import type { GuardianChain } from '../../../shared/guardianTx';

export const metadata: Metadata = { title: 'Guardian' };

/** Guardian lives on Base and Monad and acts on the Rein oracle there, which the mainnet desk posts to. */
export default async function GuardianPage({
  searchParams,
}: {
  searchParams: Promise<{ vault?: string; chain?: string }>;
}) {
  const cfg = await publicConfig();
  const [{ vault: asked, chain: askedChain }, desk, ledger] = await Promise.all([
    searchParams,
    readDesk(),
    readLedger('mainnet'),
  ]);
  const chain: GuardianChain = askedChain === 'monad' ? 'monad' : 'base';
  const menu = desk?.menu[chain]?.length ? desk.menu[chain] : (DEPLOYMENTS.mainnet.menu[chain] ?? []);
  const exits = new Map<string, { confidenceBps: number; postedAt: number }[]>();
  for (const p of ledger.ok ? ledger.ledger.recent : []) {
    if (p.chain !== chain || p.verdict !== 'EXIT' || p.repeat) continue;
    const k = p.vault.toLowerCase();
    exits.set(k, [...(exits.get(k) ?? []), { confidenceBps: p.confidence_bps, postedAt: p.posted_at }]);
  }
  const vaults: GuardVault[] = menu.map((v) => ({
    vault: v.toLowerCase() as `0x${string}`,
    name: vaultName(chain, v),
    short: shortAddress(v),
    withdrawable: SNAPSHOT[v.toLowerCase()]?.withdrawablePct ?? null,
    exits: (exits.get(v.toLowerCase()) ?? []).slice(0, 6),
  }));
  const initial =
    vaults.find((v) => v.vault === asked?.toLowerCase())?.vault ??
    vaults.find((v) => v.exits.length > 0)?.vault ??
    vaults[0]?.vault;

  return (
    <>
      <Header active="guardian" />
      <main className="container" style={{ paddingTop: 'clamp(24px, 3vw, 36px)', paddingBottom: 80 }}>
        <GuardianPanel
          key={chain}
          chain={chain}
          vaults={vaults}
          initial={initial}
          guardian={cfg.guardians[chain]}
          rpc={cfg.rpcs[chain]}
          sample={cfg.sample}
          exitWorker={cfg.exitWorker}
          api={cfg.api}
        />
      </main>
    </>
  );
}
