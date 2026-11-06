import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeskChain, DeskOrder, DeskPolicy } from '../../shared/desk';
import type { ScoreVerdict } from '../../shared/score';
import { publicConfig } from './config';
import type { Network } from './ledger';
import { view } from './near';

/** The chains a desk on each NEAR network posts to (worker/src/deskTypes.ts). */
export const NETWORK_CHAINS: Record<Network, DeskChain[]> = { testnet: ['monad-testnet'], mainnet: ['monad', 'base'] };

export interface DeskInfo {
  policy: DeskPolicy;
  menu: Partial<Record<DeskChain, string[]>>;
}

/** One oracle post of an order, from the Worker's `/v1/orders/:id`. */
export interface OrderPost {
  chain: DeskChain;
  id: number;
  verdict: ScoreVerdict;
  confidence_bps: number;
  risk_bps: number;
  state_hash: string;
  posted_at: number;
  input_check: 'match' | 'mismatch' | 'unknown';
  resolved: number;
  adverse: number | null;
  reasons: number | null;
  /** The reading the model judged; null when the Worker didn't keep it. */
  doc: string | null;
}

export interface OrderDetail extends DeskOrder {
  posts: OrderPost[];
  judge_calls: { at: number; signing_address: string }[];
}

const fixturesDir = () => process.env.FIXTURES_DIR ?? join(process.cwd(), 'fixtures');
const fixture = async <T>(name: string): Promise<T> => JSON.parse(await readFile(join(fixturesDir(), name), 'utf8')) as T;

async function api<T>(path: string): Promise<T | null> {
  const base = process.env.REIN_API_URL;
  if (!base) throw new Error('REIN_API_URL is not set.');
  const res = await fetch(new URL(path, base), { next: { revalidate: 15 } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The desk answered ${res.status}.`);
  return (await res.json()) as T;
}

/** The desk's policy and menu, from the contract or fixtures. Null when no desk is configured or it can't be read. */
export async function readDesk(): Promise<DeskInfo | null> {
  const cfg = publicConfig();
  if (cfg.sample) return fixture<DeskInfo>(`desk.${cfg.network}.json`);
  if (!cfg.desk) return null;
  const desk = cfg.desk;
  try {
    const chains = NETWORK_CHAINS[cfg.network];
    const [policy, ...menus] = await Promise.all([
      view<DeskPolicy>(cfg.network, desk, 'policy'),
      ...chains.map((chain) => view<string[]>(cfg.network, desk, 'menu', { chain })),
    ]);
    return { policy, menu: Object.fromEntries(chains.map((c, i) => [c, menus[i]])) };
  } catch {
    return null;
  }
}

/** An order with its posts. The status comes from the desk itself when it can be read, since the Worker mirrors it once a minute. */
export async function readOrder(id: number): Promise<OrderDetail | null> {
  const cfg = publicConfig();
  if (cfg.sample) return (await fixture<OrderDetail[]>('orders.json')).find((o) => o.id === id) ?? null;
  const order = await api<OrderDetail>(`/v1/orders/${id}`);
  if (order && cfg.desk) {
    const live = await view<DeskOrder | null>(cfg.network, cfg.desk, 'get_order', { order_id: id }).catch(() => null);
    if (live) order.status = live.status;
  }
  return order;
}

/** A payer's orders, newest first. */
export async function readOrders(payer: string): Promise<DeskOrder[]> {
  if (publicConfig().sample) {
    return (await fixture<OrderDetail[]>('orders.json')).filter((o) => o.payer === payer).sort((a, b) => b.id - a.id);
  }
  return (await api<{ orders: DeskOrder[] }>(`/v1/orders?payer=${encodeURIComponent(payer)}&limit=50`))?.orders ?? [];
}
