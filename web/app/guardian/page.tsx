import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { GuardianPanel, type GuardVault } from '@/components/guardian/GuardianPanel';
import { publicConfig } from '@/lib/config';
import { readDesk } from '@/lib/desk';
import { readLedger } from '@/lib/ledger';
import { BASE_MENU, SNAPSHOT, shortAddress, vaultName } from '@/lib/vaults';

export const metadata: Metadata = { title: 'Guardian' };

/** Guardian lives on Base and acts on the Rein oracle there, which the mainnet desk posts to. */
export default async function GuardianPage({ searchParams }: { searchParams: Promise<{ vault?: string }> }) {
  const cfg = await publicConfig();
  const [{ vault: asked }, desk, ledger] = await Promise.all([searchParams, readDesk(), readLedger('mainnet')]);
  const menu = desk?.menu.base?.length ? desk.menu.base : BASE_MENU;
  const exits = new Map<string, { confidenceBps: number; postedAt: number }[]>();
  for (const p of ledger.ok ? ledger.ledger.recent : []) {
    if (p.chain !== 'base' || p.verdict !== 'EXIT' || p.repeat) continue;
    const k = p.vault.toLowerCase();
    exits.set(k, [...(exits.get(k) ?? []), { confidenceBps: p.confidence_bps, postedAt: p.posted_at }]);
  }
  const vaults: GuardVault[] = menu.map((v) => ({
    vault: v.toLowerCase() as `0x${string}`,
    name: vaultName('base', v),
    short: shortAddress(v),
    withdrawable: SNAPSHOT[v.toLowerCase()]?.withdrawablePct ?? null,
    exits: (exits.get(v.toLowerCase()) ?? []).slice(0, 6),
  }));
  const initial =
    vaults.find((v) => v.vault === asked?.toLowerCase())?.vault ??
    vaults.find((v) => v.exits.length > 0)?.vault ??
    vaults[0]?.vault;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--night)', color: 'var(--night-ink)' }}>
      <Header active="guardian" dark />
      <main className="container" style={{ paddingTop: 'clamp(32px, 4vw, 56px)', paddingBottom: 80 }}>
        <GuardianPanel
          vaults={vaults}
          initial={initial}
          guardian={cfg.guardian}
          rpc={cfg.baseRpc}
          sample={cfg.sample}
          exitWorker={cfg.exitWorker}
        />
      </main>
    </div>
  );
}
