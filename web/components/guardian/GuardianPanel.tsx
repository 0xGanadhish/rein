'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type EIP1193Provider,
} from 'viem';
import { base } from 'viem/chains';
import { MoveAfterExit } from '@/components/orders/MoveAfterExit';
import { utcStamp } from '@/lib/format';
import s from './guardian.module.css';

export interface GuardVault {
  vault: Address;
  name: string;
  short: string;
  withdrawable: number | null;
  /** Recent EXIT calls on the vault, newest first. */
  exits: { confidenceBps: number; postedAt: number }[];
}

/** GuardianV2's bounds (evm/src/GuardianV2.sol). */
const MIN_CONF = 80;
const MAX_CONF = 99;
const MIN_AGE_MIN = 1;
const MAX_AGE_MIN = 60;

const guardianAbi = parseAbi([
  'function rules(address owner, address vault) view returns (bool enabled, uint16 minConfidenceBps, uint32 maxAge, uint64 enabledAt)',
  'function approvedVault(address vault) view returns (bool)',
  'function enable(address vault, uint16 minConfidenceBps, uint32 maxAge)',
  'function disable(address vault)',
]);
const vaultAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

// Native Base USDC, verified against 1Click's public token catalog.
const BASE_USDC: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

interface Position {
  shares: bigint;
  decimals: number;
  assets: bigint;
  allowance: bigint;
  approved: boolean;
  armed: boolean;
  ruleEnabled: boolean;
  usdcBalance: bigint;
}
const SAMPLE: Position = {
  shares: 958571300000000000000n,
  decimals: 18,
  assets: 1_000_000_000n,
  allowance: 0n,
  approved: true,
  armed: false,
  ruleEnabled: false,
  usdcBalance: 0n,
};

const injected = () =>
  typeof window === 'undefined' ? undefined : (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
const usdc = (v: bigint) =>
  Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function GuardianPanel({
  vaults,
  initial,
  guardian,
  rpc,
  sample,
  exitWorker,
  api,
}: {
  vaults: GuardVault[];
  initial: Address | undefined;
  guardian: Address | null;
  rpc: string;
  sample: boolean;
  /** Rein's exit worker is live, so copy may say exits happen without the owner. */
  exitWorker: boolean;
  api: string | null;
}) {
  const [vault, setVault] = useState<Address | undefined>(initial);
  const [conf, setConf] = useState(90);
  const [age, setAge] = useState(10);
  const [owner, setOwner] = useState<Address | null>(null);
  const [pos, setPos] = useState<Position | null>(sample ? SAMPLE : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const reader = useMemo(() => createPublicClient({ chain: base, transport: http(rpc) }), [rpc]);
  const v = vaults.find((x) => x.vault === vault);

  const load = useCallback(async () => {
    if (sample || !guardian || !owner || !vault) return;
    try {
      const [shares, decimals, allowance, approved, rule] = await Promise.all([
        reader.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [owner] }),
        reader.readContract({ address: vault, abi: vaultAbi, functionName: 'decimals' }),
        reader.readContract({ address: vault, abi: vaultAbi, functionName: 'allowance', args: [owner, guardian] }),
        reader.readContract({ address: guardian, abi: guardianAbi, functionName: 'approvedVault', args: [vault] }),
        reader.readContract({ address: guardian, abi: guardianAbi, functionName: 'rules', args: [owner, vault] }),
      ]);
      const assets =
        shares === 0n
          ? 0n
          : await reader.readContract({
              address: vault,
              abi: vaultAbi,
              functionName: 'convertToAssets',
              args: [shares],
            });
      const [enabled, minBps, maxAge] = rule;
      const usdcBalance =
        enabled && shares === 0n
          ? await reader.readContract({ address: BASE_USDC, abi: vaultAbi, functionName: 'balanceOf', args: [owner] })
          : 0n;
      setPos({
        shares,
        decimals,
        assets,
        allowance,
        approved,
        armed: enabled && allowance >= shares && shares > 0n,
        ruleEnabled: enabled,
        usdcBalance,
      });
      if (enabled) {
        setConf(Math.round(minBps / 100));
        setAge(Math.max(MIN_AGE_MIN, Math.round(maxAge / 60)));
      }
    } catch {
      setMsg('Base couldn’t be read just now.');
    }
  }, [sample, guardian, owner, vault, reader]);

  useEffect(() => {
    void load();
  }, [load]);

  async function wallet() {
    const eth = injected();
    if (!eth) throw new Error('No browser wallet found. Install one that supports Base.');
    const client = createWalletClient({ chain: base, transport: custom(eth) });
    const [account] = await client.requestAddresses();
    if ((await client.getChainId()) !== base.id) await client.switchChain({ id: base.id });
    return { client, account };
  }

  async function connect() {
    setMsg(null);
    try {
      setOwner((await wallet()).account);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Couldn’t connect.');
    }
  }

  async function arm() {
    if (!guardian || !vault || !pos) return;
    setMsg(null);
    try {
      const { client, account } = await wallet();
      if (pos.allowance < pos.shares) {
        setBusy('Approve Guardian to redeem your shares…');
        const h = await client.writeContract({
          account,
          address: vault,
          abi: vaultAbi,
          functionName: 'approve',
          args: [guardian, pos.shares],
        });
        await reader.waitForTransactionReceipt({ hash: h });
      }
      setBusy('Sign the rule…');
      const h = await client.writeContract({
        account,
        address: guardian,
        abi: guardianAbi,
        functionName: 'enable',
        args: [vault, conf * 100, age * 60],
      });
      await reader.waitForTransactionReceipt({ hash: h });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.split('\n')[0] : 'The transaction didn’t go through.');
    } finally {
      setBusy(null);
    }
  }

  async function disarm() {
    if (!guardian || !vault) return;
    setMsg(null);
    try {
      const { client, account } = await wallet();
      setBusy('Turning Guardian off…');
      const h = await client.writeContract({
        account,
        address: guardian,
        abi: guardianAbi,
        functionName: 'disable',
        args: [vault],
      });
      await reader.waitForTransactionReceipt({ hash: h });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.split('\n')[0] : 'The transaction didn’t go through.');
    } finally {
      setBusy(null);
    }
  }

  const t = (conf - MIN_CONF) / (MAX_CONF - MIN_CONF);
  const exits = v?.exits ?? [];
  const fired = exits.filter((x) => x.confidenceBps >= conf * 100).length;
  const blocked = sample
    ? 'Sample data: arming is off.'
    : !guardian
      ? 'Guardian isn’t deployed on Base yet.'
      : !owner
        ? null
        : pos && !pos.approved
          ? 'Guardian’s admin hasn’t approved this vault yet.'
          : pos && pos.shares === 0n
            ? 'You hold no shares in this vault.'
            : null;

  return (
    <>
      <div className={s.head}>
        <div>
          <label className={s.pickLabel} htmlFor="gv">
            Guardian ·
          </label>
          <select
            id="gv"
            className={s.pick}
            value={vault}
            onChange={(e) => {
              setVault(e.target.value as Address);
              setPos(sample ? SAMPLE : null);
            }}
          >
            {vaults.map((x) => (
              <option key={x.vault} value={x.vault}>
                {x.name}
              </option>
            ))}
          </select>
          <h1 className={s.title}>
            Set the rule.
            <br />
            <span>{exitWorker ? 'Walk away.' : 'Exit in one call.'}</span>
          </h1>
        </div>
        <div className={s.position}>
          <span className={s.k}>Your position{sample && ' · sample'}</span>
          {pos ? (
            <>
              <span className={s.big}>
                {usdc(pos.assets)} <small>USDC</small>
              </span>
              <span className={s.sub}>
                {Number(formatUnits(pos.shares, pos.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 })}{' '}
                shares{v?.withdrawable != null && ` · ${v.withdrawable.toFixed(1)}% withdrawable at last read`}
              </span>
            </>
          ) : owner ? (
            <span className={s.sub}>Reading Base…</span>
          ) : (
            <button type="button" className={s.connect} onClick={() => void connect()} disabled={!guardian}>
              Connect wallet on Base
            </button>
          )}
        </div>
      </div>

      <div className={s.grid}>
        <section aria-label="Rule" className={s.panel}>
          <div className={s.dialRow}>
            <div className={s.dial} aria-hidden="true">
              <svg viewBox="0 0 300 172">
                <path
                  d="M20,160 A130,130 0 0 1 280,160"
                  fill="none"
                  stroke="#2A2B26"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
                <path
                  d="M20,160 A130,130 0 0 1 280,160"
                  fill="none"
                  stroke="#FF5420"
                  strokeWidth="14"
                  strokeLinecap="round"
                  strokeDasharray="409"
                  strokeDashoffset={Math.round(409 * (1 - t))}
                  className={s.arc}
                />
              </svg>
              <div
                className={s.needle}
                style={{ transform: `translateX(-50%) rotate(${Math.round(-90 + t * 180)}deg)` }}
              />
              <div className={s.hub} />
              <span className={s.min}>{MIN_CONF}%</span>
              <span className={s.max}>{MAX_CONF}%</span>
            </div>
            <div className={s.readout}>
              <div className={s.k}>Exit when Rein is at least</div>
              <div className={s.conf}>
                {conf}
                <span>%</span>
              </div>
              <div className={s.sentence}>
                sure, on a call no older than <strong>{age} min</strong>.
              </div>
            </div>
          </div>

          <div className={s.sliders}>
            <label className={s.slider}>
              <span className={s.sliderHead}>
                Minimum confidence <b>{conf}%</b>
              </span>
              <input
                className={s.range}
                type="range"
                min={MIN_CONF}
                max={MAX_CONF}
                step={1}
                value={conf}
                onChange={(e) => setConf(Number(e.target.value))}
              />
              <span className={s.hint}>
                Higher means fewer, surer exits. Guardian allows {MIN_CONF} to {MAX_CONF}.
              </span>
            </label>
            <label className={s.slider}>
              <span className={s.sliderHead}>
                Call must be fresher than <b>{age} min</b>
              </span>
              <input
                className={s.range}
                type="range"
                min={MIN_AGE_MIN}
                max={MAX_AGE_MIN}
                step={1}
                value={age}
                onChange={(e) => setAge(Number(e.target.value))}
              />
              <span className={s.hint}>
                An older call can’t move you. {MIN_AGE_MIN} to {MAX_AGE_MIN} minutes.
              </span>
            </label>
          </div>

          <div className={s.armRow}>
            <code className={s.call}>
              GuardianV2.enable(<b>{v?.short ?? '0x…'}</b>, <b>{conf * 100}</b>, <b>{age * 60}</b>)
            </code>
            {pos?.armed ? (
              <button type="button" className={s.arm} data-armed onClick={() => void disarm()} disabled={!!busy}>
                <span className={s.ring} aria-hidden="true" />
                {busy ?? 'Armed — disarm'}
              </button>
            ) : (
              <button
                type="button"
                className={s.arm}
                onClick={() => void (owner ? arm() : connect())}
                disabled={!!blocked || !!busy}
              >
                <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M9 1.8 15 4v4.6c0 3.6-2.5 6.4-6 7.6-3.5-1.2-6-4-6-7.6V4z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </svg>
                {busy ??
                  (owner ? (pos && pos.allowance < pos.shares ? 'Approve & arm' : 'Arm Guardian') : 'Connect to arm')}
              </button>
            )}
          </div>
          {(blocked || msg) && (
            <p className={s.note} role={msg ? 'alert' : undefined}>
              {msg ?? blocked}
            </p>
          )}
          {pos?.armed && (
            <p className={s.note}>
              Armed. Guardian may redeem only the shares you hold now; approve again after a deposit. Changing the rule
              and arming again replaces it; only calls posted from then on count.
            </p>
          )}
        </section>

        <aside className={s.side}>
          <section aria-labelledby="bt" className={s.backtest}>
            <h2 id="bt" className={s.k}>
              Under this rule
            </h2>
            {exits.length > 0 ? (
              <>
                <p className={s.btLine}>
                  {exits.length === 1
                    ? `The last EXIT call here would ${fired ? '' : 'not '}have met your rule.`
                    : `${fired} of the last ${exits.length} EXIT calls here would have met your rule.`}
                </p>
                <ol className={s.history}>
                  {exits.map((x) => {
                    const ok = x.confidenceBps >= conf * 100;
                    return (
                      <li key={x.postedAt}>
                        <span className={s.hDot} data-on={ok || undefined} />
                        <span>
                          <strong>EXIT {(x.confidenceBps / 100).toFixed(1)}%</strong>{' '}
                          <span className={s.muted}>· {utcStamp(x.postedAt)}</span>
                        </span>
                        <span className={s.hLabel}>{ok ? 'exit' : 'below rule'}</span>
                      </li>
                    );
                  })}
                </ol>
                <p className={s.btFine}>
                  {exitWorker
                    ? 'Rein’s exit worker calls exit as soon as a call lands; the age limit only matters if it can’t.'
                    : 'Nothing calls exit for you yet. When an EXIT meets your rule, you or anyone else has to call it before it’s too old.'}
                </p>
              </>
            ) : (
              <p className={s.btLine}>No EXIT calls on this vault in the Ledger yet.</p>
            )}
          </section>
          <section className={s.facts}>
            <div>
              <span>A</span>
              <span>Funds go only to your address. Guardian never holds them.</span>
            </div>
            <div>
              <span>B</span>
              <span>Anyone can call the exit once your rule matches, so it doesn’t depend on Rein being online.</span>
            </div>
            <div>
              <span>C</span>
              <span>
                A full exit needs the vault to have the liquidity. If it doesn’t, the exit redeems what it can, and the
                rest can follow on the same call while it’s fresh.
              </span>
            </div>
            <div>
              <span>D</span>
              <span>
                Calls posted before you arm don’t count, and a call that fully exited you can’t move a later deposit.
              </span>
            </div>
          </section>
        </aside>
      </div>
      {!sample && api && owner && vault && pos?.ruleEnabled && pos.shares === 0n && (
        <MoveAfterExit
          key={`${owner}:${vault}:${pos.usdcBalance}`}
          api={api}
          chain="base"
          amount={pos.usdcBalance}
          owner={owner}
        />
      )}
    </>
  );
}
