/**
 * Shows the desk refusing tampered readings. It takes the latest delivered testnet order's real reading (doc, model
 * response and TEE signature, from its `fulfil` transaction) and asks the desk's `check_reading` view about altered
 * copies:
 *   - one character of the answer changed       -> unknown signer (the signature now recovers to another address)
 *   - a doc containing `"`                      -> bad doc
 *   - the real reading replayed on another order -> wrong order
 *   - the same text signed by a throwaway key     -> unknown signer
 *   - a signature with a corrupted recovery byte  -> bad signature
 * The untouched reading is checked too, as a control: its signature passes, so only its age can refuse it.
 * It's a view call: no key and no gas, so anyone can run it. Results are appended to docs/tamper.log.
 *
 *   pnpm demo:tamper
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { DeskPrompt } from '../shared/desk.ts';
import { DEPLOYMENTS } from '../shared/deployments.ts';

const RPC = 'https://rpc.testnet.fastnear.com';
const NEARBLOCKS_API = 'https://api-testnet.nearblocks.io/v3';
const LOG = new URL('../docs/tamper.log', import.meta.url);
const desk = DEPLOYMENTS.testnet.desk!;
const agent = DEPLOYMENTS.testnet.agent!;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tamper', method, params }),
  });
  const body = (await res.json()) as { result?: T };
  if (!body.result) throw new Error(`${method} failed`);
  return body.result;
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
const check = (order_id: number, doc: string, response: string, signature: string) =>
  view<string>('check_reading', { order_id, doc, response, signature });

// The latest delivered order's reading, as the agent submitted it in `fulfil`.
type Reading = { order: number; doc: string; response: string; signature: string; tx: string };
const list = (await (await fetch(`${NEARBLOCKS_API}/accounts/${agent}/txns?per_page=50`)).json()) as {
  data: { transaction_hash: string; signer_account_id: string }[];
};
let reading: Reading | null = null;
for (const t of list.data ?? []) {
  const tx = await rpc<{ transaction: { actions: { FunctionCall?: { method_name: string; args: string } }[] } }>('tx', {
    tx_hash: t.transaction_hash,
    sender_account_id: t.signer_account_id,
    wait_until: 'NONE',
  });
  const call = tx.transaction.actions[0]?.FunctionCall;
  if (call?.method_name !== 'fulfil') continue;
  const a = JSON.parse(Buffer.from(call.args, 'base64').toString()) as {
    order_id: number | string;
    doc: string;
    response: string;
    signature: string;
  };
  const order = Number(a.order_id);
  if ((await view<{ status: string } | null>('get_order', { order_id: order }))?.status !== 'delivered') continue;
  reading = { order, doc: a.doc, response: a.response, signature: a.signature, tx: t.transaction_hash };
  break;
}
if (!reading) {
  console.error('no delivered testnet order yet: run pnpm demo first');
  process.exit(1);
}
const { order, doc, response, signature } = reading;
const other = order > 0 ? order - 1 : order + 1;

// One character of the answer: the first digit of confidence_bps, bumped by one.
const at = response.search(/confidence_bps\\?":\s*\d/);
const digit = at < 0 ? -1 : response.slice(at).search(/\d/) + at;
const tamperedResponse =
  digit < 0 ? response : `${response.slice(0, digit)}${(Number(response[digit]) + 1) % 10}${response.slice(digit + 1)}`;

// The same signed text, signed by a key nobody approved.
const prompt = await view<DeskPrompt>('prompt');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const text = `${prompt.model}:${sha(prompt.prefix + doc + prompt.suffix)}:${sha(response)}`;
const throwaway = privateKeyToAccount(generatePrivateKey());
const throwawaySig = await throwaway.signMessage({ message: text });

const corrupted = `${signature.slice(0, -2)}1d`;

const cases: { name: string; expected: string; got: () => Promise<string> }[] = [
  {
    name: 'control: the untouched reading',
    expected: 'stale doc',
    got: () => check(order, doc, response, signature),
  },
  {
    name: 'one character of the answer changed',
    expected: 'unknown signer',
    got: () => check(order, doc, tamperedResponse, signature),
  },
  {
    name: 'a doc containing "',
    expected: 'bad doc',
    got: () => check(order, doc.replace('|name=', '|name="'), response, signature),
  },
  {
    name: `the real reading replayed on order ${other}`,
    expected: 'wrong order',
    got: () => check(other, doc, response, signature),
  },
  {
    name: `signed by a throwaway key ${throwaway.address}`,
    expected: 'unknown signer',
    got: () => check(order, doc, response, throwawaySig),
  },
  {
    name: 'signature with a corrupted recovery byte',
    expected: 'bad signature',
    got: () => check(order, doc, response, corrupted),
  },
];

const out = [`# ${new Date().toISOString()} · ${desk} · order ${order} · fulfil ${reading.tx}`];
let mismatch = false;
for (const c of cases) {
  const got = await c.got();
  // A reading checked within doc_max_age_s of its doc is still fresh, so the control may pass outright.
  const ok = got === c.expected || (c.name.startsWith('control') && got === 'ok');
  if (!ok) mismatch = true;
  out.push(`${ok ? 'ok  ' : 'MISMATCH'} ${c.name}: ${got}${ok ? '' : ` (expected ${c.expected})`}`);
}
console.log(out.join('\n'));
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await appendFile(LOG, `${out.join('\n')}\n\n`);
process.exit(mismatch ? 1 : 0);
