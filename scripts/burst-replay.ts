/**
 * Replays the 15 Oct burst: 140 `submit_watch_request` calls on one vault, sent at once. The desk takes one order per
 * vault at a time and spaces posts, so one call opens an order and the other 139 are refused. Each outcome comes from
 * its transaction's status. The summary is appended to docs/burst-replay.log.
 *
 *   pnpm burst:replay [vault]        (testnet; default: the first menu vault the desk would take an order for now)
 *
 * One key's calls must execute in nonce order, and a load-balanced RPC delivers a fast burst out of order, so the burst
 * is split across LANES temporary function-call keys, each sending its share one call at a time. The script makes the
 * keys in memory and prints the `near` commands that add them to the agent account (you sign those; this script never
 * holds a full-access key). It waits until every key is on chain, sends the burst, then prints the commands that
 * delete the keys again. The private keys never leave this process.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { DEPLOYMENTS } from '../shared/deployments.ts';

const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { KeyPair } = require('@near-js/crypto');
const { KeyPairSigner } = require('@near-js/signers');
const { actionCreators, createTransaction } = require('@near-js/transactions');

const CALLS = 140;
const LANES = 20;
const CHAIN = 'monad-testnet';
const RPC = 'https://rpc.testnet.fastnear.com';
const KEY_WAIT_MS = 15 * 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOG = new URL('../docs/burst-replay.log', import.meta.url);
const desk = DEPLOYMENTS.testnet.desk!;
const agent = DEPLOYMENTS.testnet.agent!;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'burst', method, params }),
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(1_000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
    return body.result;
  }
}
async function view<T>(method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: desk,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(r.result).toString('utf8')) as T;
}
type AccessKey = { nonce: number; block_hash: string };
const accessKey = (publicKey: string) =>
  rpc<AccessKey>('query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: agent,
    public_key: publicKey,
  });
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const hex = n.toString(16);
  return Uint8Array.from(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'));
}

// Temporary keys, in memory only.
const lanes = Array.from({ length: LANES }, () => {
  const keyPair = KeyPair.fromRandom('ed25519');
  return {
    signer: new KeyPairSigner(keyPair),
    publicKey: keyPair.getPublicKey(),
    id: keyPair.getPublicKey().toString(),
  };
});
console.log(`Add the ${LANES} temporary keys (each limited to submit_watch_request on ${desk}, 0.1 NEAR allowance):\n`);
for (const l of lanes)
  console.log(
    `near account add-key ${agent} grant-function-call-access --allowance '0.1 NEAR' --contract-account-id ${desk} ` +
      `--function-names submit_watch_request use-manually-provided-public-key ${l.id} network-config testnet sign-with-keychain send`,
  );
console.log('\nwaiting for all keys to appear on chain...');
for (const end = Date.now() + KEY_WAIT_MS; ;) {
  const keys = await rpc<{ keys: { public_key: string }[] }>('query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: agent,
  });
  const have = new Set(keys.keys.map((k) => k.public_key));
  const missing = lanes.filter((l) => !have.has(l.id)).length;
  if (missing === 0) break;
  if (Date.now() > end) {
    console.error(`${missing} key(s) still missing after ${KEY_WAIT_MS / 60_000} min; giving up`);
    process.exit(1);
  }
  await sleep(5_000);
}
const deleteCommands = () =>
  `\nDelete the temporary keys:\n\n${lanes
    .map((l) => `near account delete-keys ${agent} public-keys ${l.id} network-config testnet sign-with-keychain send`)
    .join('\n')}\n`;

// A vault the desk would take an order for right now.
let vault = process.argv[2]?.toLowerCase();
if (!vault) {
  for (const v of await view<string[]>('menu', { chain: CHAIN })) {
    if ((await view<string>('check_x402_request', { chain: CHAIN, vault: v })) === 'ok') {
      vault = v;
      break;
    }
  }
}
if (!vault) {
  console.error(`no ${CHAIN} menu vault is open for an order right now; retry in a minute`);
  console.log(deleteCommands());
  process.exit(1);
}
const before = await view<number>('next_order_id');

// Signed up front, so the burst itself is only sends. Each lane waits for its previous call to be included before
// sending the next, which keeps that key's nonces in order; the lanes run side by side.
type Outcome = { kind: 'order'; id: number } | { kind: 'refused'; reason: string } | { kind: 'lost'; reason: string };
const args = Buffer.from(JSON.stringify({ chain: CHAIN, vault }));
const signedLanes = await Promise.all(
  lanes.map(async (l, lane) => {
    const access = await accessKey(l.id);
    const share = Math.floor(CALLS / LANES) + (lane < CALLS % LANES ? 1 : 0);
    const txs: string[] = [];
    for (let i = 0; i < share; i++) {
      const tx = createTransaction(
        agent,
        l.publicKey,
        desk,
        BigInt(access.nonce + 1 + i),
        [actionCreators.functionCall('submit_watch_request', args, 30_000_000_000_000n, 0n)],
        base58(access.block_hash),
      );
      const [, signed] = await l.signer.signTransaction(tx);
      txs.push(Buffer.from(signed.encode()).toString('base64'));
    }
    return txs;
  }),
);
console.log(`sending ${CALLS} submit_watch_request calls for ${vault} on ${CHAIN} across ${LANES} keys`);
const startedAt = new Date();
const outcomes = (
  await Promise.all(
    signedLanes.map(async (txs) => {
      const out: Outcome[] = [];
      for (const signed of txs) {
        const r = await rpc<{ status?: { SuccessValue?: string; Failure?: unknown } }>('send_tx', {
          signed_tx_base64: signed,
          wait_until: 'EXECUTED_OPTIMISTIC',
        }).catch((e: Error) => ({ error: e.message }) as const);
        if ('error' in r) {
          // A function-call failure is in the status, not an RPC error; an RPC error means the call never ran.
          out.push({ kind: 'lost', reason: r.error.slice(0, 120) });
        } else if (r.status?.SuccessValue !== undefined)
          out.push({ kind: 'order', id: Number(Buffer.from(r.status.SuccessValue, 'base64').toString()) });
        else {
          const panic = /Smart contract panicked: ([^"\\]+)/.exec(JSON.stringify(r.status?.Failure))?.[1];
          out.push({ kind: 'refused', reason: panic ?? 'failed without a desk reason' });
        }
      }
      return out;
    }),
  )
).flat();
const sentMs = Date.now() - startedAt.getTime();

const orders = outcomes.filter((o) => o.kind === 'order') as { id: number }[];
const tally = (kind: Outcome['kind']) => {
  const m = new Map<string, number>();
  for (const o of outcomes) if (o.kind === kind && 'reason' in o) m.set(o.reason, (m.get(o.reason) ?? 0) + 1);
  return [...m].map(([r, n]) => `${n} × ${r}`);
};
const refused = outcomes.filter((o) => o.kind === 'refused').length;
const lost = outcomes.filter((o) => o.kind === 'lost').length;
const ok = orders.length === 1 && refused === CALLS - 1;
const out = [
  `# ${startedAt.toISOString()} · ${desk} · ${CHAIN} ${vault} · ${CALLS} calls across ${LANES} keys in ${(sentMs / 1000).toFixed(1)} s`,
  `orders opened: ${orders.length}${orders.length ? ` (${orders.map((o) => o.id).join(', ')})` : ''} · next_order_id ${before} -> ${await view<number>('next_order_id')}`,
  `refused by the desk: ${refused}`,
  ...tally('refused').map((l) => `  ${l}`),
  ...(lost ? [`never executed: ${lost}`, ...tally('lost').map((l) => `  ${l}`)] : []),
  ok ? 'as expected: 1 order, 139 refused' : 'NOT the expected 1 order and 139 refusals',
];
console.log(out.join('\n'));
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await appendFile(LOG, `${out.join('\n')}\n\n`);
console.log(deleteCommands());
process.exit(ok ? 0 : 1);
