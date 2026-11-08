/**
 * One paid judgement on the testnet desk, end to end: pays 0.1 NEAR to judge a menu vault that's open now, kicks the
 * Worker, waits for delivery, and prints the proof: the NEAR order, the doc the model read, its answer, the TEE signer
 * and signature, the oracle post on Monad testnet, and the Ledger. Exits non-zero if it isn't delivered in 120 s.
 *
 *   pnpm demo [chain]        (default monad-testnet; needs REIN_API_URL and KICK_TOKEN)
 *   Optional: DEMO_BUYER (default rein-buyer.testnet, created from the faucet if missing), NEAR_CLI (default `near`).
 * The buyer signs with your keychain; this script never reads a key.
 */
import { spawnSync } from 'node:child_process';
import type { DeskChain, DeskPolicy } from '../shared/desk.ts';
import { DEPLOYMENTS } from '../shared/deployments.ts';

const TIMEOUT_MS = 120_000;
/** Keeps watching past the target so a slow delivery still prints its proof (and still exits non-zero). */
const GIVE_UP_MS = 300_000;
const RPC = 'https://rpc.testnet.fastnear.com';
const NEARBLOCKS_API = 'https://api-testnet.nearblocks.io/v3';
const NEARBLOCKS = 'https://testnet.nearblocks.io';
const TX_EXPLORER: Partial<Record<DeskChain, string>> = {
  'monad-testnet': 'https://testnet.monadscan.com/tx/',
  'base-sepolia': 'https://sepolia.basescan.org/tx/',
};

const chain = (process.argv[2] ?? 'monad-testnet') as DeskChain;
const m = DEPLOYMENTS.testnet;
const desk = m.desk!;
const api = process.env.REIN_API_URL;
const kickToken = process.env.KICK_TOKEN;
const buyer = process.env.DEMO_BUYER ?? 'rein-buyer.testnet';
const near = process.env.NEAR_CLI ?? 'near';
const started = Date.now();
const fail = (msg: string): never => {
  console.error(`\nFAIL ${msg} (${Math.round((Date.now() - started) / 1000)} s)`);
  process.exit(1);
};
if (!api || !kickToken) fail('needs REIN_API_URL and KICK_TOKEN');
if (!(chain in m.oracles) || !m.oracles[chain]) fail(`no oracle for ${chain} in shared/deployments.ts`);

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'demo', method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string } } };
  if (!body.result) throw new Error(body.error?.cause?.name ?? `${method} failed`);
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
const exists = (id: string) =>
  rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }).then(
    () => true,
    () => false,
  );
const nearCli = (args: string[]) => {
  const r = spawnSync(near, args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. A funded buyer.
if (!(await exists(buyer))) {
  console.log(`creating ${buyer} from the testnet faucet`);
  const r = nearCli([
    'account',
    'create-account',
    'sponsor-by-faucet-service',
    buyer,
    'autogenerate-new-keypair',
    'save-to-keychain',
    'network-config',
    'testnet',
    'create',
  ]);
  if (!r.ok) fail(`couldn't create ${buyer}`);
}

// 2. Pay to judge a menu vault the desk will take now (it refuses one posted within spacing_s).
const policy = await view<DeskPolicy>('policy');
const vaults = await view<string[]>('menu', { chain });
if (vaults.length === 0) fail(`the desk has no ${chain} vaults on its menu`);
let orderId: number | null = null;
let orderTx = '';
for (const vault of [...vaults].sort(() => Math.random() - 0.5)) {
  const deposit = `${policy.price_near} yoctoNEAR`;
  console.log(`ordering a judgement of ${vault} on ${chain} for ${deposit} as ${buyer}`);
  const r = nearCli([
    'contract',
    'call-function',
    'as-transaction',
    desk,
    'request_judgement',
    'json-args',
    JSON.stringify({ chain, vault }),
    'prepaid-gas',
    '30.0 Tgas',
    'attached-deposit',
    deposit,
    'sign-as',
    buyer,
    'network-config',
    'testnet',
    'sign-with-keychain',
    'send',
  ]);
  if (r.ok) {
    orderId = Number(/^\s*(\d+)\s*$/m.exec(r.stdout)?.[1] ?? NaN);
    orderTx = /Transaction ID:\s*(\w+)/.exec(r.out)?.[1] ?? '';
    break;
  }
  console.log(`  refused: ${/Smart contract panicked: ([^\n"]+)/.exec(r.out)?.[1] ?? 'see near CLI output'}`);
}
if (orderId === null || Number.isNaN(orderId)) fail('no vault accepted an order');
console.log(`order ${orderId}: ${NEARBLOCKS}/txns/${orderTx}`);

// 3. Kick the Worker and wait for delivery.
type Receipt = {
  status: string;
  post_tx: string | null;
  posts: { chain: string; id: number; verdict: string; confidence_bps: number; risk_bps: number; doc: string | null }[];
  judge_calls: { signing_address: string }[];
};
const kick = () =>
  fetch(new URL('/v1/kick', api), { method: 'POST', headers: { authorization: `Bearer ${kickToken}` } }).catch(
    () => null,
  );
// Delivery is timed on the desk itself; the Worker's copy catches up on its next mirror pass.
let delivered = false;
let lastStatus = '';
let lastKick = 0;
while (Date.now() - started < GIVE_UP_MS) {
  if (Date.now() - lastKick > 20_000) {
    lastKick = Date.now();
    void kick();
  }
  const status = await view<{ status: string } | null>('get_order', { order_id: orderId }).then(
    (o) => o?.status ?? '',
    () => lastStatus,
  );
  if (status !== lastStatus) console.log(`  status: ${(lastStatus = status)}`);
  if (status === 'delivered') {
    delivered = true;
    break;
  }
  if (['refunded', 'rejected', 'post_failed'].includes(status)) fail(`order ${orderId} ended ${status}`);
  await sleep(5_000);
}
if (!delivered) fail(`order ${orderId} not delivered in ${GIVE_UP_MS / 1000} s (last status: ${lastStatus || 'none'})`);
const elapsed = Math.round((Date.now() - started) / 1000);

// The receipt's doc and post come from the Worker's mirror, up to a cron interval later.
let receipt: Receipt | null = null;
for (const end = Date.now() + 90_000; Date.now() < end; await sleep(5_000)) {
  if (Date.now() - lastKick > 20_000) {
    lastKick = Date.now();
    void kick();
  }
  const res = await fetch(new URL(`/v1/orders/${orderId}`, api)).catch(() => null);
  const r = res?.ok ? ((await res.json()) as Receipt) : null;
  if (r?.post_tx && r.posts.length > 0) {
    receipt = r;
    break;
  }
}
if (!receipt) fail(`order ${orderId} delivered in ${elapsed} s, but the Worker hasn't mirrored its post yet`);

// 4. The signed answer, from the desk's fulfil transaction.
let answer: string | null = null;
let signature: string | null = null;
let fulfilTx: string | null = null;
try {
  const list = (await (await fetch(`${NEARBLOCKS_API}/accounts/${m.agent}/txns?per_page=25`)).json()) as {
    data: { transaction_hash: string; signer_account_id: string }[];
  };
  for (const t of list.data ?? []) {
    const tx = await rpc<{
      transaction: { actions: { FunctionCall?: { method_name: string; args: string } }[] };
    }>('tx', { tx_hash: t.transaction_hash, sender_account_id: t.signer_account_id, wait_until: 'NONE' });
    const call = tx.transaction.actions[0]?.FunctionCall;
    if (call?.method_name !== 'fulfil') continue;
    const args = JSON.parse(Buffer.from(call.args, 'base64').toString());
    if (Number(args.order_id) !== orderId) continue;
    ({ response: answer, signature } = args as { response: string; signature: string });
    fulfilTx = t.transaction_hash;
    break;
  }
} catch {
  // The explorer can lag a few seconds behind; the receipt links still hold the proof.
}

const post = receipt!.posts.find((p) => p.chain === chain);
const signer = receipt!.judge_calls.at(-1)?.signing_address ?? null;
const answerText = answer ? (JSON.parse(answer).choices?.[0]?.message?.content ?? answer) : null;
console.log(`
delivered in ${elapsed} s${elapsed * 1000 > TIMEOUT_MS ? ` (over the ${TIMEOUT_MS / 1000} s target)` : ''}

NEAR order     ${NEARBLOCKS}/txns/${orderTx}
doc            ${post?.doc ?? '(not mirrored yet)'}
answer         ${answerText ?? '(see the fulfil transaction)'}
verdict        ${post ? `${post.verdict}, confidence ${post.confidence_bps / 100}%, risk ${post.risk_bps / 100}%` : '-'}
TEE signer     ${signer ?? '-'}
signature      ${signature ?? '-'}
fulfil         ${fulfilTx ? `${NEARBLOCKS}/txns/${fulfilTx}` : `${NEARBLOCKS}/address/${desk}`}
oracle post    ${TX_EXPLORER[chain] ?? ''}${receipt!.post_tx}
receipt        ${new URL(`/v1/orders/${orderId}`, api)}
Ledger         ${new URL('/v1/ledger?network=testnet', api)}`);
process.exit(elapsed * 1000 > TIMEOUT_MS ? 1 : 0);
