/**
 * Deploys and configures the desk from shared/deployments.ts. Reads state over NEAR RPC, then plans only what's
 * missing: deploy and `new` (policy and the Chain Signatures attester address), the policy's oracles, the prompt in
 * shared/judgePrompt.ts, the menu, and the signer from the latest passing attestations/ evidence (under 24 h old).
 *
 * Without --yes it prints the plan and changes nothing. With --yes it runs each step through the `near` CLI, which
 * signs with your keychain; this script never reads a key.
 *
 *   DESK_OWNER=<account> pnpm deploy:desk [testnet|mainnet] [--yes]
 *   Optional: DESK_TREASURY (testnet defaults to DESK_OWNER), DESK_USDC_TOKEN (mainnet), NEAR_CLI (default `near`).
 *   Build first: cargo near build non-reproducible-wasm --manifest-path near/desk/Cargo.toml, then from near/:
 *     wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
 *       target/near/desk/desk.wasm -o target/near/desk/desk.opt.wasm
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { keccak256 } from 'viem';
import type { DeskChain, DeskPolicy, DeskPrompt } from '../shared/desk.ts';
import { DEPLOYMENTS } from '../shared/deployments.ts';
import { JUDGE_PROMPT } from '../shared/judgePrompt.ts';

const network = process.argv.includes('mainnet') ? 'mainnet' : 'testnet';
const yes = process.argv.includes('--yes');
const RPC = { testnet: 'https://rpc.testnet.near.org', mainnet: 'https://rpc.mainnet.near.org' }[network];
const WASM = new URL('../near/target/near/desk/desk.opt.wasm', import.meta.url);
const WASM_LIMIT = 300_000;
const ATTESTER_PATH = 'rein-attester-v1';
const EVIDENCE_MAX_AGE_MS = 24 * 3600 * 1000;
const CHAINS: DeskChain[] = ['monad-testnet', 'monad', 'base', 'base-sepolia'];
const GWEI = 10n ** 9n;

const m = DEPLOYMENTS[network];
const owner = process.env.DESK_OWNER;
const treasury = process.env.DESK_TREASURY ?? (network === 'testnet' ? owner : undefined);
const usdcToken = network === 'mainnet' ? (process.env.DESK_USDC_TOKEN ?? null) : null;
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
if (!m.desk || !m.agent) fail(`shared/deployments.ts has no desk or agent for ${network} yet`);
if (!owner) fail('usage: DESK_OWNER=<account> pnpm deploy:desk [testnet|mainnet] [--yes]');
if (!treasury) fail('mainnet needs DESK_TREASURY');
if (network === 'mainnet' && !usdcToken) fail('mainnet needs DESK_USDC_TOKEN');
const desk = m.desk!;

/** Mirrors Policy::testnet and Policy::mainnet in near/desk/src/types.rs, with the manifest's oracles. */
function policy(): DeskPolicy {
  const perChain = <T>(f: (c: DeskChain) => T) =>
    Object.fromEntries(CHAINS.map((c) => [c, f(c)])) as Record<DeskChain, T>;
  const test = network === 'testnet';
  return {
    spacing_s: test ? 60 : 600,
    per_vault_max: test ? 30 : 4,
    global_max: test ? 200 : 40,
    watch_daily_max: test ? 200 : 4,
    deadline_s: 1800,
    doc_max_age_s: 300,
    exit_confirm_min_s: 30,
    exit_confirm_max_s: 300,
    max_open_paid: 500,
    price_usdc: '1000000',
    price_near: String((test ? 100n : 300n) * 10n ** 21n),
    split_treasury_bps: 7000,
    split_agent_bps: 3000,
    kill: false,
    usdc_token: usdcToken,
    agent: m.agent!,
    treasury: treasury!,
    oracle: perChain((c) => m.oracles[c] ?? null),
    gas_limit: perChain((c) => (c === 'monad-testnet' || c === 'base-sepolia' ? 400_000 : 1_000_000)),
    max_fee_cap: perChain((c) => String((c.startsWith('base') ? 5n : 500n) * GWEI)),
    signer: test ? 'v1.signer-prod.testnet' : 'v1.signer',
  };
}

async function rpc<T>(params: Record<string, unknown>): Promise<T | null> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'deploy-desk',
      method: 'query',
      params: { finality: 'final', ...params },
    }),
  });
  const body = (await res.json()) as { result?: T & { result?: number[] }; error?: unknown };
  return body.result ?? null;
}
async function view<T>(account: string, method: string, args: object = {}): Promise<T | null> {
  const r = await rpc<{ result: number[] }>({
    request_type: 'call_function',
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return r ? (JSON.parse(Buffer.from(r.result).toString('utf8')) as T) : null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const hex = n.toString(16).padStart(2, '0');
  const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const zeros = s.length - s.replace(/^1+/, '').length;
  return new Uint8Array([...new Uint8Array(zeros), ...bytes]);
}
/** The EVM address Chain Signatures derives for the desk's attester path. */
async function derivedAddress(signer: string): Promise<`0x${string}`> {
  const key = await view<string>(signer, 'derived_public_key', {
    path: ATTESTER_PATH,
    predecessor: desk,
    domain_id: 0,
  });
  if (!key?.startsWith('secp256k1:')) fail(`${signer} returned no derived key for ${desk}`);
  const raw = base58(key!.slice('secp256k1:'.length));
  if (raw.length !== 64) fail(`unexpected derived key length ${raw.length}`);
  return `0x${keccak256(raw).slice(-40)}`;
}

async function latestSigner(): Promise<string | null> {
  const dir = new URL('../attestations/', import.meta.url);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.reverse()) {
    const e = JSON.parse(await readFile(new URL(f, dir), 'utf8')) as {
      ok: boolean;
      at: string;
      signer: string;
      model: string;
    };
    if (!e.ok || e.model !== JUDGE_PROMPT.model) continue;
    return Date.now() - Date.parse(e.at) < EVIDENCE_MAX_AGE_MS ? e.signer : null;
  }
  return null;
}

const sorted = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, sorted(x)]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// What's there now.
const want = policy();
const attester = await derivedAddress(want.signer);
const account = await rpc<{ code_hash: string }>({ request_type: 'view_account', account_id: desk });
const signer = await latestSigner();
const wasm = await stat(WASM).catch(() => null);

console.log(`desk ${desk} on ${network}, owner ${owner}, agent ${want.agent}, treasury ${want.treasury}`);
console.log(`attester (Chain Signatures, path ${ATTESTER_PATH}): ${attester}`);
for (const c of CHAINS.filter((c) => c in m.oracles)) {
  console.log(
    `oracle ${c}: ${want.oracle[c] ?? 'NOT DEPLOYED (posts to it are refused)'}; menu: ${(m.menu[c] ?? []).length} vaults`,
  );
}
console.log(`model signer: ${signer ?? 'NO passing attestation in the last 24 h: run pnpm verify:signer first'}`);
if (!account) fail(`\n${desk} doesn't exist on ${network}; create it first (near account create-account ...)`);
const deployed = account!.code_hash !== '11111111111111111111111111111111';

const near = process.env.NEAR_CLI ?? 'near';
const tail = ['network-config', network, 'sign-with-keychain', 'send'];
const call = (method: string, args: object, signerId = owner!) => [
  'contract',
  'call-function',
  'as-transaction',
  desk,
  method,
  'json-args',
  JSON.stringify(args),
  'prepaid-gas',
  '30.0 Tgas',
  'attached-deposit',
  '0 NEAR',
  'sign-as',
  signerId,
  ...tail,
];
const steps: { what: string; args: string[] }[] = [];

if (!deployed) {
  if (!wasm) fail(`no ${WASM.pathname}; build the desk first`);
  if (wasm!.size > WASM_LIMIT) fail(`desk.opt.wasm is ${wasm!.size} bytes, over ${WASM_LIMIT}`);
  steps.push({
    what: `deploy desk.opt.wasm (${wasm!.size} bytes) and call new`,
    args: [
      'contract',
      'deploy',
      desk,
      'use-file',
      WASM.pathname,
      'with-init-call',
      'new',
      'json-args',
      JSON.stringify({ owner, policy: want, derived_address: attester }),
      'prepaid-gas',
      '100.0 Tgas',
      'attached-deposit',
      '0 NEAR',
      ...tail,
    ],
  });
} else {
  const live = await view<string>(desk, 'derived_address');
  if (live?.toLowerCase() !== attester) fail(`the deployed desk's attester ${live} isn't ${attester}`);
  if (!same(await view(desk, 'policy'), want))
    steps.push({ what: 'set_policy', args: call('set_policy', { policy: want }) });
}
const prompt = deployed ? await view<DeskPrompt>(desk, 'prompt') : null;
if (!same(prompt, JUDGE_PROMPT))
  steps.push({ what: `set_prompt (${JUDGE_PROMPT.model})`, args: call('set_prompt', JUDGE_PROMPT) });
for (const c of CHAINS.filter((c) => (m.menu[c] ?? []).length > 0)) {
  const on = new Set(deployed ? ((await view<string[]>(desk, 'menu', { chain: c })) ?? []) : []);
  for (const vault of m.menu[c]!) {
    if (!on.has(vault.toLowerCase()))
      steps.push({ what: `set_menu ${c} ${vault}`, args: call('set_menu', { chain: c, vault, on: true }) });
  }
}
const signers = deployed ? ((await view<string[]>(desk, 'signers')) ?? []) : [];
if (signer && !signers.map((s) => s.toLowerCase()).includes(signer)) {
  steps.push({ what: `set_signer ${signer}`, args: call('set_signer', { address: signer, on: true }) });
}

if (steps.length === 0) {
  console.log('\nnothing to do: the desk matches the manifest');
  process.exit(0);
}
console.log(`\n${yes ? 'running' : 'plan (rerun with --yes to apply)'}:`);
for (const [i, s] of steps.entries()) {
  console.log(`${i + 1}. ${s.what}`);
  if (!yes) continue;
  const r = spawnSync(near, s.args, { stdio: 'inherit' });
  if (r.status !== 0) fail(`step ${i + 1} failed (${r.status ?? r.error?.message}); nothing after it ran`);
}
if (yes) console.log(`\ndone. Fund ${attester} with gas on each chain that has an oracle.`);
