import type { DeskChain } from '../../shared/desk';
import { NETWORK_CHAINS } from './deskTypes';
import type { NearNetwork } from './env';
import { MIN_GAS_WEI } from './order';

/** 0.2 NEAR on the agent account. */
export const MIN_AGENT_YOCTO = 2n * 10n ** 23n;
/** Flag the agent key once less than this share of its allowance is left. */
export const MIN_ALLOWANCE_PCT = 20;

/** One minute cron, with two missed intervals tolerated for scheduling/RPC jitter. */
export const CRON_INTERVAL_S = 60;
export const CRON_STALE_S = 3 * CRON_INTERVAL_S;
export const AGENT_METHODS = ['fulfil', 'confirm_exit', 'resign', 'report_delivery', 'fail_post', 'reject', 'submit_watch_request', 'submit_x402_request'];

export interface Activity {
  last_cron_s: number | null;
  last_delivery_s: number | null;
  oldest_stuck_order: { id: number; status: string; created_s: number; valid_until: number | null; deadline_s: number } | null;
  pending_refunds: { orders: number; usdc: string; near: string };
}

export interface HealthDeps {
  derivedAddress(): Promise<string>;
  gasBalance(chain: DeskChain, address: string): Promise<bigint>;
  agent(): Promise<{ balance: bigint; allowance: bigint | null; receiver?: string | null; methods?: string[]; fullAccess?: boolean }>;
  /** What the agent key was granted, in yoctoNEAR; null if unknown. */
  allowanceGranted: bigint | null;
  deskAccount?: string;
  activity?(): Promise<Activity>;
  now?(): number;
  db?: D1Database;
}

export interface Health {
  ok: boolean;
  flags: string[];
  /** wei per chain, as decimal strings; null where the read failed. */
  gas: Partial<Record<DeskChain, string | null>>;
  agent_yocto: string | null;
  /** Share of the agent key's allowance left; null when unlimited or unknown. */
  allowance_pct: number | null;
  last_cron_s: number | null;
  last_delivery_s: number | null;
  oldest_stuck_order: Activity['oldest_stuck_order'];
  pending_refunds: Activity['pending_refunds'] | null;
  key_permissions: { receiver: string | null; methods: string[]; full_access: boolean } | null;
  incidents: Incident[];
}

/**
 * Balances the desk needs to keep working: gas on the derived address on each chain (1 MON, 0.0001 ETH), 0.2 NEAR on
 * the agent account, and at least 20% of the agent key's function-call allowance. A read that fails is a flag too.
 */
export async function checkHealth(network: NearNetwork, deps: HealthDeps): Promise<Health> {
  const flags: string[] = [];
  const gas: Health['gas'] = {};
  let address: string | null = null;
  try {
    address = await deps.derivedAddress();
  } catch {
    flags.push('derived_address_unreadable');
  }
  if (address) {
    for (const chain of NETWORK_CHAINS[network]) {
      try {
        const wei = await deps.gasBalance(chain, address);
        gas[chain] = String(wei);
        if (wei < MIN_GAS_WEI[chain]) flags.push(`low_gas:${chain}`);
      } catch {
        gas[chain] = null;
        flags.push(`gas_unreadable:${chain}`);
      }
    }
  }

  let agentYocto: string | null = null;
  let allowancePct: number | null = null;
  let permissions: Health['key_permissions'] = null;
  try {
    const { balance, allowance, receiver, methods, fullAccess } = await deps.agent();
    if (receiver !== undefined && methods !== undefined && fullAccess !== undefined) {
      permissions = { receiver, methods, full_access: fullAccess };
      if (fullAccess) flags.push('agent_key_full_access');
      else {
        if (receiver !== deps.deskAccount) flags.push('agent_key_wrong_receiver');
        if (methods.length === 0) flags.push('agent_key_unrestricted_methods');
        else for (const method of AGENT_METHODS) if (!methods.includes(method)) flags.push(`agent_key_missing_method:${method}`);
        for (const method of methods) if (!AGENT_METHODS.includes(method)) flags.push(`agent_key_unexpected_method:${method}`);
      }
    }
    agentYocto = String(balance);
    if (balance < MIN_AGENT_YOCTO) flags.push('low_near');
    if (allowance !== null && deps.allowanceGranted) {
      allowancePct = Number((allowance * 10_000n) / deps.allowanceGranted) / 100;
      if (allowancePct < MIN_ALLOWANCE_PCT) flags.push('low_allowance');
    }
  } catch {
    flags.push('agent_unreadable');
  }
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  let activity: Activity | null = null;
  if (deps.activity) {
    try {
      activity = await deps.activity();
      if (activity.last_cron_s === null || now - activity.last_cron_s > CRON_STALE_S) flags.push('stale_cron');
      if (activity.oldest_stuck_order) flags.push(`stuck_order:${activity.oldest_stuck_order.id}`);
      if (activity.pending_refunds.orders > 0) flags.push('pending_refunds');
    } catch { flags.push('activity_unreadable'); }
  }
  const incidents = deps.db ? await reconcileIncidents(deps.db, network, flags, now) : [];
  return { ok: flags.length === 0, flags, gas, agent_yocto: agentYocto, allowance_pct: allowancePct,
    last_cron_s: activity?.last_cron_s ?? null, last_delivery_s: activity?.last_delivery_s ?? null,
    oldest_stuck_order: activity?.oldest_stuck_order ?? null, pending_refunds: activity?.pending_refunds ?? null,
    key_permissions: permissions, incidents };
}

export interface Incident {
  id: number; network: string; flag: string; first_seen: number; last_seen: number; occurrences: number; resolved_at: number | null;
}

/** A recurrence creates a new episode. Healthy evaluations close, but never erase, previous episodes. */
async function reconcileIncidents(db: D1Database, network: NearNetwork, flags: string[], now: number): Promise<Incident[]> {
  const placeholders = flags.map(() => '?').join(', ');
  await db.batch([
    db.prepare(`UPDATE incidents SET resolved_at = ? WHERE network = ? AND resolved_at IS NULL AND last_seen <= ?
      AND ? = 0 ${flags.length ? `AND flag NOT IN (${placeholders})` : ''}`)
      .bind(now, network, now, flags.some((flag) => flag.includes('unreadable')) ? 1 : 0, ...flags),
    ...flags.map((flag) => db.prepare(`INSERT INTO incidents (network, flag, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT (network, flag) WHERE resolved_at IS NULL DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen), occurrences = occurrences + 1`)
      .bind(network, flag, now, now)),
  ]);
  return (await db.prepare('SELECT * FROM incidents WHERE network = ? ORDER BY id DESC LIMIT 100').bind(network).all<Incident>()).results;
}

/** Signing is stuck after the order deadline; signed is stuck after expiry plus the desk's refund grace. */
export async function readActivity(db: D1Database, network: NearNetwork, deadline: number, now: number, kill = false): Promise<Activity> {
  const chains = NETWORK_CHAINS[network];
  const scope = chains.map(() => '?').join(', ');
  const [cron, delivery, stuck, pending] = await Promise.all([
    db.prepare('SELECT at FROM meta WHERE key = ?').bind(`cron:${network}`).first<number>('at'),
    db.prepare(`SELECT MAX(delivered_s) AS at FROM orders WHERE chain IN (${scope}) AND status = 'delivered'`).bind(...chains).first<number>('at'),
    db.prepare(`SELECT id, status, created_s, valid_until FROM orders WHERE chain IN (${scope}) AND
      ((status = 'signing' AND created_s + ? < ?) OR (status = 'signed' AND COALESCE(valid_until, created_s + ?) + ? < ?))
      ORDER BY created_s, id LIMIT 1`).bind(...chains, deadline, now, deadline, deadline, now)
      .first<Omit<NonNullable<Activity['oldest_stuck_order']>, 'deadline_s'>>(),
    db.prepare(`SELECT source, amount FROM orders WHERE chain IN (${scope}) AND source IN ('near', 'usdc') AND
      ((status IN ('open', 'exit_pending') AND (? = 1 OR created_s + ? <= ?)) OR
      (status = 'signed' AND COALESCE(valid_until, created_s + ?) + ? < ?))`)
      .bind(...chains, kill ? 1 : 0, deadline, now, deadline, deadline, now).all<{ source: 'near' | 'usdc'; amount: string }>(),
  ]);
  const amounts = { orders: pending.results.length, usdc: '0', near: '0' };
  for (const order of pending.results) amounts[order.source] = String(BigInt(amounts[order.source]) + BigInt(order.amount));
  return { last_cron_s: cron, last_delivery_s: delivery, oldest_stuck_order: stuck ? { ...stuck, deadline_s: deadline } : null, pending_refunds: amounts };
}
