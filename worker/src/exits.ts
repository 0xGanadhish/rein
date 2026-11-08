import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DeskChain } from '../../shared/desk';
import { guardianAbi, oracleAbi } from './abis';
import { CHAINS, ORACLES } from './broadcast';
import { NETWORK_CHAINS } from './deskTypes';
import { rpcFor, type Env, type NearNetwork } from './env';

export const PARTIAL_FOLLOWUP_S = 30;
const BLOCK_PAGE = 2_000n;
const OWNER_PAGE = 20;
const VERDICT_PAGE = 4;
const JOBS_PER_CHAIN = 4;

export interface ExitJob {
  chain: DeskChain;
  vault: Address;
  owner: Address;
  verdict_id: number;
  attempt: number;
  confidence_bps: number;
  posted_at: number;
}
export interface ExitReceipt {
  status: 'success' | 'reverted';
  gasWei: bigint;
  shares: bigint;
  assets: bigint;
  remainingShares: bigint;
}
export interface ExitRule {
  enabled: boolean;
  minConfidenceBps: number;
  maxAge: number;
  enabledAt: number;
  floor: number;
}
export interface ExitDeps {
  now(): number;
  guardian(chain: DeskChain): { address: Address; fromBlock: bigint } | null;
  head(chain: DeskChain): Promise<bigint>;
  enables(chain: DeskChain, from: bigint, to: bigint): Promise<{ owner: Address; vault: Address }[]>;
  rule(job: ExitJob): Promise<ExitRule>;
  latest(chain: DeskChain, vault: Address): Promise<number>;
  simulate(job: ExitJob): Promise<string | null>;
  prepare(job: ExitJob): Promise<{ raw: Hex; hash: Hex }>;
  broadcast(chain: DeskChain, raw: Hex): Promise<void>;
  receipt(job: ExitJob, hash: Hex): Promise<ExitReceipt | null>;
}

export function realExitDeps(env: Env): ExitDeps {
  const configured = JSON.parse(env.GUARDIANS ?? '{}') as Partial<
    Record<DeskChain, { address: Address; fromBlock: string }>
  >;
  // Clients and the account are constructed only for configured chains, never for a disabled exit worker.
  const client = (chain: DeskChain) =>
    createPublicClient({
      chain: CHAINS[chain],
      transport: http(rpcFor(env, chain), { retryCount: 0, timeout: 5_000 }),
    });
  const guardian = (chain: DeskChain) => {
    const c = configured[chain];
    if (!c) return null;
    if (!isAddress(c.address) || !/^\d+$/.test(c.fromBlock))
      throw new Error(`invalid Guardian configuration for ${chain}`);
    return { address: c.address, fromBlock: BigInt(c.fromBlock) };
  };
  const address = (chain: DeskChain) => {
    const c = guardian(chain);
    if (!c) throw new Error(`no Guardian configured for ${chain}`);
    return c.address;
  };
  const gas = async (chain: DeskChain) => {
    // The floor is checked after verdict, balance and allowance reads, not at entry.
    const floor = await client(chain).readContract({
      address: address(chain),
      abi: guardianAbi,
      functionName: 'MIN_EXIT_GAS',
    });
    return floor + 300_000n;
  };
  return {
    now: () => Math.floor(Date.now() / 1000),
    guardian,
    head: (chain) => client(chain).getBlockNumber(),
    async enables(chain, fromBlock, toBlock) {
      const logs = await client(chain).getLogs({
        address: address(chain),
        event: guardianAbi.find((e) => e.type === 'event' && e.name === 'Enabled')!,
        fromBlock,
        toBlock,
        strict: true,
      });
      return logs.map((log) => ({ owner: log.args.owner!, vault: log.args.vault! }));
    },
    async rule(job) {
      const c = client(job.chain);
      const [rule, floor, oracle] = await Promise.all([
        c.readContract({
          address: address(job.chain),
          abi: guardianAbi,
          functionName: 'rules',
          args: [job.owner, job.vault],
        }),
        c.readContract({
          address: address(job.chain),
          abi: guardianAbi,
          functionName: 'verdictFloor',
          args: [job.owner, job.vault],
        }),
        c.readContract({ address: address(job.chain), abi: guardianAbi, functionName: 'oracle' }),
      ]);
      if (oracle.toLowerCase() !== ORACLES[job.chain]?.toLowerCase()) throw new Error('Guardian oracle mismatch');
      return {
        enabled: rule[0],
        minConfidenceBps: rule[1],
        maxAge: rule[2],
        enabledAt: Number(rule[3]),
        floor: Number(floor),
      };
    },
    async latest(chain, vault) {
      const oracle = ORACLES[chain];
      if (!oracle) throw new Error(`no oracle configured for ${chain}`);
      return Number(
        await client(chain).readContract({ address: oracle, abi: oracleAbi, functionName: 'latest', args: [vault] }),
      );
    },
    async simulate(job) {
      try {
        await client(job.chain).simulateContract({
          address: address(job.chain),
          abi: guardianAbi,
          functionName: 'exit',
          args: [job.vault, job.owner],
          account: privateKeyToAccount(env.EXECUTOR_KEY as Hex).address,
          gas: await gas(job.chain),
        });
        return null;
      } catch (error) {
        const revert =
          error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
        if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? 'ExitReverted';
        throw error;
      }
    },
    async prepare(job) {
      const account = privateKeyToAccount(env.EXECUTOR_KEY as Hex);
      const chain: Chain = CHAINS[job.chain];
      const wallet = createWalletClient({
        chain,
        account,
        transport: http(rpcFor(env, job.chain), { retryCount: 0, timeout: 5_000 }),
      });
      const request = await wallet.prepareTransactionRequest({
        account,
        to: address(job.chain),
        data: encodeFunctionData({ abi: guardianAbi, functionName: 'exit', args: [job.vault, job.owner] }),
        gas: await gas(job.chain),
      });
      const raw = await wallet.signTransaction(request);
      return { raw, hash: keccak256(raw) };
    },
    async broadcast(chain, serializedTransaction) {
      await client(chain).sendRawTransaction({ serializedTransaction });
    },
    async receipt(job, hash) {
      let r;
      try {
        r = await client(job.chain).getTransactionReceipt({ hash });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      const gasWei = r.gasUsed * r.effectiveGasPrice + ('l1Fee' in r ? BigInt(r.l1Fee ?? 0) : 0n);
      const event = parseEventLogs({ abi: guardianAbi, eventName: 'Exited', logs: r.logs }).find(
        (log) =>
          log.address.toLowerCase() === address(job.chain).toLowerCase() &&
          log.args.owner.toLowerCase() === job.owner &&
          log.args.vault.toLowerCase() === job.vault &&
          log.args.verdictId === BigInt(job.verdict_id),
      );
      // A newer verdict may win the race between simulation and mining. Count the fee, but don't report a matching exit.
      return {
        status: r.status === 'success' && event ? 'success' : 'reverted',
        gasWei,
        shares: event?.args.shares ?? 0n,
        assets: event?.args.assets ?? 0n,
        remainingShares: event?.args.remainingShares ?? 0n,
      };
    },
  };
}

/** EVM chain is the queue namespace: oracle verdict IDs overlap across chains. */
export async function queueExits(env: Env, network: DeskChain, verdictId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO exit_verdicts (chain, verdict_id)
    SELECT chain, id FROM posts WHERE chain = ? AND id = ? AND verdict = 1`,
  )
    .bind(network, verdictId)
    .run();
}

/** Runs under the same executor lock as grading. A pending signed exit reserves the chain's nonce. */
export async function runExits(
  env: Env,
  network: NearNetwork,
  deps: ExitDeps,
): Promise<{ worked: number; failed: number }> {
  const db = env.DB;
  const now = deps.now();
  const tally = { worked: 0, failed: 0 };
  for (const chain of NETWORK_CHAINS[network]) {
    const config = deps.guardian(chain);
    if (!config) continue;
    try {
      const saved = await db
        .prepare('SELECT guardian, next_block FROM guardian_scans WHERE chain = ?')
        .bind(chain)
        .first<{ guardian: string; next_block: number }>();
      if (saved && saved.guardian !== config.address.toLowerCase())
        throw new Error('Guardian deployment changed; use a separate database');
      const from = saved ? BigInt(saved.next_block) : config.fromBlock;
      const head = await deps.head(chain);
      const to = from + BLOCK_PAGE - 1n < head ? from + BLOCK_PAGE - 1n : head;
      if (from <= to) {
        const owners = await deps.enables(chain, from, to);
        await db.batch([
          ...owners.map((o) =>
            db
              .prepare('INSERT OR IGNORE INTO guardian_owners (chain, vault, owner) VALUES (?, ?, ?)')
              .bind(chain, o.vault.toLowerCase(), o.owner.toLowerCase()),
          ),
          db
            .prepare(
              `INSERT INTO guardian_scans (chain, guardian, next_block) VALUES (?, ?, ?)
            ON CONFLICT (chain) DO UPDATE SET next_block = excluded.next_block`,
            )
            .bind(chain, config.address.toLowerCase(), Number(to + 1n)),
        ]);
      }
      // Don't finalize fan-out until discovery has caught up with the chain.
      if (to >= head) {
        const { results: verdicts } = await db
          .prepare(
            'SELECT verdict_id, owner_cursor FROM exit_verdicts WHERE chain = ? AND queued = 0 ORDER BY verdict_id LIMIT ?',
          )
          .bind(chain, VERDICT_PAGE)
          .all<{ verdict_id: number; owner_cursor: number }>();
        for (const verdict of verdicts) {
          const { results: owners } = await db
            .prepare(
              `SELECT g.id, g.owner, g.vault FROM guardian_owners g JOIN posts p ON p.chain = g.chain AND p.vault = g.vault
            WHERE g.chain = ? AND p.id = ? AND g.id > ? ORDER BY g.id LIMIT ?`,
            )
            .bind(chain, verdict.verdict_id, verdict.owner_cursor, OWNER_PAGE)
            .all<{ id: number; owner: string; vault: string }>();
          await db.batch([
            ...owners.map((o) =>
              db
                .prepare(
                  `INSERT OR IGNORE INTO exits (chain, vault, owner, verdict_id, status, next_at) VALUES (?, ?, ?, ?, 'queued', ?)`,
                )
                .bind(chain, o.vault, o.owner, verdict.verdict_id, now),
            ),
            db
              .prepare('UPDATE exit_verdicts SET owner_cursor = ?, queued = ? WHERE chain = ? AND verdict_id = ?')
              .bind(
                owners.at(-1)?.id ?? verdict.owner_cursor,
                owners.length < OWNER_PAGE ? 1 : 0,
                chain,
                verdict.verdict_id,
              ),
          ]);
        }
      }
      const { results: jobs } = await db
        .prepare(
          `SELECT e.*, p.confidence_bps, p.posted_at FROM exits e JOIN posts p ON p.chain = e.chain AND p.id = e.verdict_id
        WHERE e.chain = ? AND e.next_at <= ? ORDER BY (e.status = 'sending') DESC, e.next_at, e.verdict_id, e.owner LIMIT ?`,
        )
        .bind(chain, now, JOBS_PER_CHAIN)
        .all<ExitJob>();
      for (const job of jobs) {
        try {
          let attempt = await db
            .prepare(
              'SELECT raw_tx, tx_hash FROM exit_attempts WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ? AND attempt = ?',
            )
            .bind(chain, job.vault, job.owner, job.verdict_id, job.attempt)
            .first<{ raw_tx: Hex; tx_hash: Hex }>();
          if (!attempt) {
            const rule = await deps.rule(job);
            const latest = await deps.latest(chain, job.vault);
            const reason = !rule.enabled
              ? 'NotEnabled'
              : latest !== job.verdict_id
                ? 'VerdictSuperseded'
                : rule.minConfidenceBps > job.confidence_bps
                  ? 'BelowThreshold'
                  : now - job.posted_at > rule.maxAge
                    ? 'StaleVerdict'
                    : job.posted_at < rule.enabledAt
                      ? 'VerdictPredatesEnable'
                      : job.verdict_id <= rule.floor
                        ? 'VerdictAlreadyUsed'
                        : await deps.simulate(job);
            if (reason) {
              await db
                .prepare(
                  "UPDATE exits SET status = 'skipped', error = ?, next_at = NULL WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ?",
                )
                .bind(reason, chain, job.vault, job.owner, job.verdict_id)
                .run();
              tally.worked++;
              continue;
            }
            const pending = await db
              .prepare('SELECT 1 FROM exit_attempts WHERE chain = ? AND settled = 0')
              .bind(chain)
              .first();
            if (pending) continue;
            const signed = await deps.prepare(job);
            // This transaction commits the bytes and nonce ownership BEFORE any network send.
            await db.batch([
              db
                .prepare(
                  'INSERT INTO exit_attempts (chain, vault, owner, verdict_id, attempt, raw_tx, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .bind(chain, job.vault, job.owner, job.verdict_id, job.attempt, signed.raw, signed.hash),
              db
                .prepare(
                  "UPDATE exits SET status = 'sending' WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ?",
                )
                .bind(chain, job.vault, job.owner, job.verdict_id),
            ]);
            attempt = { raw_tx: signed.raw, tx_hash: signed.hash };
          }
          // Check before rebroadcast: an RPC timeout may have hidden a successful send.
          let receipt = await deps.receipt(job, attempt.tx_hash);
          if (!receipt) {
            await db
              .prepare('UPDATE exits SET next_at = ? WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ?')
              .bind(now + 30, chain, job.vault, job.owner, job.verdict_id)
              .run();
            await deps.broadcast(chain, attempt.raw_tx);
            receipt = await deps.receipt(job, attempt.tx_hash);
          }
          if (!receipt) continue;
          const partial = receipt.status === 'success' && receipt.shares > 0n && receipt.remainingShares > 0n;
          await db.batch([
            db
              .prepare(
                "INSERT OR IGNORE INTO executor_fees (chain, hash, kind, gas_wei, verdict_id) VALUES (?, ?, 'exit', ?, ?)",
              )
              .bind(chain, attempt.tx_hash, String(receipt.gasWei), job.verdict_id),
            db
              .prepare('UPDATE exit_attempts SET settled = 1 WHERE chain = ? AND tx_hash = ?')
              .bind(chain, attempt.tx_hash),
            db
              .prepare(
                `UPDATE exits SET status = ?, assets = ?, remaining_shares = ?, next_at = ?, attempt = attempt + ?, error = ?
              WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ?`,
              )
              .bind(
                receipt.status === 'reverted' ? 'failed' : partial ? 'partial' : 'confirmed',
                String(receipt.assets),
                String(receipt.remainingShares),
                partial ? now + PARTIAL_FOLLOWUP_S : null,
                partial ? 1 : 0,
                receipt.status === 'reverted' ? 'ExitRevertedOrSuperseded' : null,
                chain,
                job.vault,
                job.owner,
                job.verdict_id,
              ),
          ]);
          tally.worked++;
          if (receipt.status === 'reverted') tally.failed++;
        } catch {
          // RPC errors can contain credentials. Keep only a fixed diagnostic; preserve signed bytes for recovery.
          await db
            .prepare(
              'UPDATE exits SET error = ?, next_at = ? WHERE chain = ? AND vault = ? AND owner = ? AND verdict_id = ?',
            )
            .bind('ExitAttemptUnavailable', now + 30, chain, job.vault, job.owner, job.verdict_id)
            .run();
          tally.failed++;
        }
      }
    } catch {
      console.error(JSON.stringify({ msg: 'exit_chain_unavailable', chain }));
      tally.failed++;
    }
  }
  return tally;
}
