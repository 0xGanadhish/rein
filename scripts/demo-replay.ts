/**
 * Shows that a delivered oracle post can't be used twice or late. For real delivered posts on one chain it
 *   1. re-sends the original signed transaction, which the chain refuses because its nonce is spent, and
 *   2. runs the same `post` call from the desk's attester address, which the oracle itself refuses:
 *      `StateAlreadyPosted` while the post is still inside its validity window, `PostExpired` after it.
 * The desk never signs a second transaction for the same reading, so the oracle's refusal is shown by simulation.
 * No key and no gas are needed. Results are appended to docs/replay.log.
 *
 *   pnpm demo:replay [chain]        (default monad-testnet; needs REIN_API_URL and that chain's RPC)
 */
import { appendFile, mkdir } from 'node:fs/promises';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeFunctionData,
  http,
  keccak256,
  parseAbi,
  serializeTransaction,
  type Hex,
  type Transaction,
} from 'viem';
import { DEPLOYMENTS } from '../shared/deployments.ts';

const ABI = parseAbi([
  'function post(address vault, uint8 verdict, uint16 confidenceBps, uint16 riskBps, bytes32 stateHash, uint64 validUntil) returns (uint256)',
  'error StateAlreadyPosted()',
  'error PostExpired()',
  'error NotAttester()',
  'error VaultNotRegistered()',
]);
const RPC_ENV: Record<string, string> = {
  'monad-testnet': 'RPC_MONAD_TESTNET',
  'base-sepolia': 'RPC_BASE_SEPOLIA',
  monad: 'RPC_MONAD',
  base: 'RPC_BASE',
};
const LOG = new URL('../docs/replay.log', import.meta.url);

const chain = process.argv[2] ?? 'monad-testnet';
const network = chain in DEPLOYMENTS.testnet.oracles ? 'testnet' : 'mainnet';
const oracle = DEPLOYMENTS[network].oracles[chain as keyof (typeof DEPLOYMENTS)['testnet']['oracles']];
const rpc = process.env[RPC_ENV[chain] ?? ''];
const api = process.env.REIN_API_URL;
if (!RPC_ENV[chain] || !oracle || !rpc || !api) {
  console.error(
    `usage: pnpm demo:replay [${Object.keys(RPC_ENV).join('|')}]\n` +
      `needs the chain's oracle in shared/deployments.ts, ${RPC_ENV[chain] ?? 'its RPC'} and REIN_API_URL`,
  );
  process.exit(1);
}
const client = createPublicClient({ transport: http(rpc) });

const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(new URL(path, api));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
};

/** The raw signed bytes of a mined transaction, checked against its hash. */
function rawOf(tx: Transaction): Hex {
  if (tx.type !== 'eip1559') throw new Error(`${tx.hash}: expected a type-2 transaction, got ${tx.type}`);
  const raw = serializeTransaction(
    {
      type: 'eip1559',
      chainId: tx.chainId!,
      nonce: tx.nonce,
      to: tx.to!,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas!,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
      accessList: tx.accessList,
    },
    { r: tx.r, s: tx.s, yParity: tx.yParity! },
  );
  if (keccak256(raw) !== tx.hash) throw new Error(`${tx.hash}: rebuilt transaction doesn't match its hash`);
  return raw;
}

const short = (e: unknown) => (e instanceof BaseError ? e.shortMessage : String(e)).split('\n')[0];

async function replay(orderId: number, tx: Transaction, validUntil: bigint, now: bigint): Promise<string[]> {
  const lines = [
    `order ${orderId} · ${chain} tx ${tx.hash} · valid until ${new Date(Number(validUntil) * 1000).toISOString()}`,
  ];
  try {
    await client.sendRawTransaction({ serializedTransaction: rawOf(tx) });
    lines.push('  resend signed tx: ACCEPTED (unexpected)');
  } catch (e) {
    lines.push(`  resend signed tx: refused by the chain: ${short(e)}`);
  }
  const expected = now > validUntil ? 'PostExpired' : 'StateAlreadyPosted';
  let got = 'no revert';
  try {
    const { args } = decodeFunctionData({ abi: ABI, data: tx.input });
    await client.simulateContract({ address: tx.to!, abi: ABI, functionName: 'post', args, account: tx.from });
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    got = revert instanceof ContractFunctionRevertedError ? (revert.data?.errorName ?? short(e)) : short(e);
  }
  lines.push(`  same post from the attester: ${got} (expected ${expected})${got === expected ? '' : '  MISMATCH'}`);
  return lines;
}

const ledger = await getJson<{ recent: { chain: string; order_id: number | null }[] }>(`/v1/ledger?network=${network}`);
const ids = [...new Set(ledger.recent.filter((p) => p.chain === chain && p.order_id !== null).map((p) => p.order_id!))];
const now = (await client.getBlock()).timestamp;
type Candidate = { id: number; tx: Transaction; validUntil: bigint };
let fresh: Candidate | null = null;
let stale: Candidate | null = null;
for (const id of ids.slice(0, 50)) {
  if (fresh && stale) break;
  const order = await getJson<{ status: string; post_tx: Hex | null }>(`/v1/orders/${id}`);
  if (order.status !== 'delivered' || !order.post_tx) continue;
  const tx = await client.getTransaction({ hash: order.post_tx });
  const validUntil = decodeFunctionData({ abi: ABI, data: tx.input }).args[5];
  if (validUntil >= now && !fresh) fresh = { id, tx, validUntil };
  if (validUntil < now && !stale) stale = { id, tx, validUntil };
}

const out = [`# ${new Date().toISOString()} · ${chain} · oracle ${oracle}`];
for (const [label, pick] of [
  ['still inside its validity window', fresh],
  ['past its validity window', stale],
] as const) {
  if (pick) out.push(...(await replay(pick.id, pick.tx, pick.validUntil, now)));
  else out.push(`no delivered post ${label} yet${label.startsWith('still') ? ': run pnpm demo, then this' : ''}`);
}
console.log(out.join('\n'));
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
await appendFile(LOG, `${out.join('\n')}\n\n`);
process.exit(out.some((l) => l.includes('MISMATCH') || l.includes('ACCEPTED')) || !fresh || !stale ? 1 : 0);
