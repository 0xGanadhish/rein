import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from '../middleware';

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));
const { publicConfig } = await import('./config');

afterEach(() => {
  jar.clear();
  vi.unstubAllEnvs();
});

describe('network switch', () => {
  it('network_switch_changes_desk_and_api', async () => {
    vi.stubEnv('DATA_SOURCE', '');
    vi.stubEnv('NEAR_NETWORK', '');
    expect(await publicConfig()).toMatchObject({
      network: 'testnet',
      desk: 'rein-desk.testnet',
      api: 'https://api-testnet.reinfi.xyz',
    });

    // The switch links to ?network=mainnet; the middleware keeps the page and sets the cookie.
    const res = middleware(new NextRequest('https://reinfi.xyz/judge?vault=0xabc&network=mainnet'));
    expect(res.headers.get('location')).toBe('https://reinfi.xyz/judge?vault=0xabc');
    expect(res.cookies.get('rein-network')?.value).toBe('mainnet');

    jar.set('rein-network', 'mainnet');
    expect(await publicConfig()).toMatchObject({
      network: 'mainnet',
      desk: 'rein-desk.near',
      api: 'https://api.reinfi.xyz',
    });

    vi.stubEnv('REIN_API_URL_MAINNET', 'https://api.reinfi.xyz');
    expect((await publicConfig()).api).toBe('https://api.reinfi.xyz');

    jar.set('rein-network', 'devnet');
    expect((await publicConfig()).network).toBe('testnet');
    expect(middleware(new NextRequest('https://reinfi.xyz/ledger?network=devnet')).headers.get('location')).toBeNull();
  });
});
