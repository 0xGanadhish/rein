import type { DeskChain } from '../../shared/desk';
import type { ReinReader } from './types';

/** Public, unsigned desk view; uses only Web-standard APIs. */
export async function deskView<T>(rpcUrl: string, desk: string, method: string, args: object = {}): Promise<T> {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rein-mcp',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: desk,
        method_name: method,
        args_base64: btoa(String.fromCharCode(...bytes)),
      },
    }),
  });
  if (!response.ok) throw new Error(`Desk view ${method} failed (${response.status})`);
  const body = (await response.json()) as { error?: unknown; result?: { result: number[] } };
  if (body.error || !body.result) throw new Error(`Desk view ${method} failed`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}

export function httpReader(apiUrl: string, rpcUrl: string, desk: string): ReinReader {
  async function api(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(new URL(path, apiUrl), init);
    if (response.status === 404 && path.startsWith('/v1/orders/')) return null;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `Rein API failed (${response.status})`);
    }
    return response.json();
  }
  return {
    async ledger(chain?: DeskChain, limit = 200) {
      const network = chain ? (chain === 'base' || chain === 'monad' ? 'mainnet' : 'testnet') : undefined;
      const body = (await api(`/v1/ledger${network ? `?network=${network}` : ''}`)) as {
        recent: { chain: DeskChain }[];
      };
      return { ...body, recent: body.recent.filter((p) => !chain || p.chain === chain).slice(0, limit) };
    },
    order: (id) => api(`/v1/orders/${id}`),
    policy: () => deskView(rpcUrl, desk, 'policy'),
    menu: (chain) => deskView<string[]>(rpcUrl, desk, 'menu', { chain }),
    getOrder: (id) => deskView(rpcUrl, desk, 'get_order', { order_id: id }),
    async nudge(id) {
      await api(`/v1/orders/${id}/nudge`, { method: 'POST' });
    },
  };
}
