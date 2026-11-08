import type { Network } from './ledger';

export const NEAR_RPC: Record<Network, string> = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
};

/** A NEAR contract view call over JSON-RPC, at final finality. Works in the browser and on the server. */
export async function view<T>(network: Network, contract: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(NEAR_RPC[network], {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'rein',
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: contract,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = (await res.json()) as { result?: { result?: number[] }; error?: { message?: string } };
  if (!body.result?.result) throw new Error(`${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(body.result.result))) as T;
}
