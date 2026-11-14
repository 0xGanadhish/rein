import { createPublicClient } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { CHAINS } from '../src/broadcast';
import { readTransport, type Env } from '../src/env';

const env = { RPC_MONAD: 'https://primary.example', RPC_BASE: 'https://base.example' } as Env;

afterEach(() => vi.unstubAllGlobals());

it('monad_read_falls_back_when_the_configured_rpc_rate_limits', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith('https://primary.example')) return new Response('{"error":"rate limited"}', { status: 429 });
    return Response.json({ jsonrpc: '2.0', id: 1, result: '0x2a' });
  });
  const client = createPublicClient({ chain: CHAINS.monad, transport: readTransport(env, 'monad') });
  expect(await client.getBlockNumber()).toBe(42n);
  expect(seen[0]).toContain('primary.example');
  expect(seen.length).toBe(2);
});

it('base_reads_use_only_the_configured_rpc', async () => {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response('{"error":"rate limited"}', { status: 429 });
  });
  const client = createPublicClient({ chain: CHAINS.base, transport: readTransport(env, 'base') });
  await expect(client.getBlockNumber()).rejects.toThrow();
  expect(new Set(seen)).toEqual(new Set(['https://base.example/']));
});
