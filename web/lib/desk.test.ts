import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOrder } from './desk';

const live = { id: 7, source: 'near', payer: 'alice.testnet', chain: 'monad-testnet', vault: '0xabc', amount: '1', created_s: 1_000,
  status: 'open', exit_pending_s: null, valid_until: null };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('readOrder', () => {
  it('paid_order_before_mirror_shows_pending_indexing', async () => {
    vi.stubEnv('REIN_API_URL', 'https://api.rein.test');
    vi.stubEnv('DESK_ACCOUNT', 'desk.rein.testnet');
    vi.stubGlobal('fetch', async (url: string | URL) => String(url).startsWith('https://api.rein.test')
      ? new Response('{"error":"not found"}', { status: 404 })
      : Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(live))] } }));
    const order = await readOrder(7);
    expect(order).toMatchObject({ id: 7, status: 'open', indexing: true, posts: [], judge_calls: [] });
  });
});
