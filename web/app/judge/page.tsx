import type { Metadata } from 'next';
import { Header } from '@/components/Header';
import { JudgeForm, type MenuVault } from '@/components/judge/JudgeForm';
import s from '@/components/judge/judge.module.css';
import { publicConfig } from '@/lib/config';
import { NETWORK_CHAINS, readDesk } from '@/lib/desk';
import { readLedger } from '@/lib/ledger';
import { BASE_MENU, SNAPSHOT, vaultName, shortAddress, usdShort } from '@/lib/vaults';

export const metadata: Metadata = { title: 'Judge a vault' };

export default async function JudgePage({ searchParams }: { searchParams: Promise<{ vault?: string }> }) {
  const cfg = publicConfig();
  const [desk, ledger, { vault: asked }] = await Promise.all([readDesk(), readLedger(cfg.network), searchParams]);
  const last = new Map<string, string>();
  for (const p of ledger.ok ? ledger.ledger.recent : []) {
    const k = `${p.chain}:${p.vault.toLowerCase()}`;
    if (!last.has(k)) last.set(k, p.verdict);
  }
  const chains = NETWORK_CHAINS[cfg.network];
  const menu: MenuVault[] = (desk
    ? chains.flatMap((chain) => (desk.menu[chain] ?? []).map((vault) => ({ chain, vault })))
    : cfg.network === 'mainnet' ? BASE_MENU.map((vault) => ({ chain: 'base' as const, vault })) : []
  ).map(({ chain, vault }) => {
    const snap = chain === 'base' ? SNAPSHOT[vault.toLowerCase()] : undefined;
    return {
      chain, vault, name: vaultName(chain, vault), short: shortAddress(vault),
      tvlUsd: snap?.tvlUsd ?? null, tvl: snap ? usdShort(snap.tvlUsd) : null, withdrawable: snap?.withdrawablePct ?? null,
      last: last.get(`${chain}:${vault.toLowerCase()}`) ?? null,
    };
  }).sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.name.localeCompare(b.name));

  return (
    <>
      <Header active="judge" />
      <main className="container" style={{ paddingTop: 'clamp(32px, 4vw, 56px)', paddingBottom: 80 }}>
        <div className={s.head}>
          <div className={`label ${s.eyebrow}`}>
            <span>New order</span>
            {cfg.sample && <span className={s.sample}>· Sample data, payments off</span>}
          </div>
          <h1 className={s.title}>Which vault worries you?</h1>
        </div>
        <JudgeForm
          menu={menu}
          initial={asked?.toLowerCase() ?? null}
          policy={desk ? {
            priceNear: desk.policy.price_near, priceUsdc: desk.policy.price_usdc, usdcToken: desk.policy.usdc_token,
            deadlineS: desk.policy.deadline_s, spacingS: desk.policy.spacing_s, kill: desk.policy.kill,
          } : null}
          sample={cfg.sample}
          api={cfg.api}
        />
      </main>
    </>
  );
}
