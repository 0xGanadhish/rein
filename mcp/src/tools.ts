import type { DeskChain, DeskOrder, DeskPolicy } from '../../shared/desk';
import { DEPLOYMENTS } from '../../shared/deployments';
import { armTxs, depositTxs, disarmTxs, type UnsignedTx } from '../../shared/guardianTx';
import type { McpToolSet, Payer, ReinReader, ToolContext, ToolResult, VerdictRecord } from './types';

const CHAINS: DeskChain[] = ['monad-testnet', 'monad', 'base', 'base-sepolia'];
const EXPLORERS: Record<DeskChain, string> = {
  'monad-testnet': 'https://testnet.monadscan.com',
  monad: 'https://monadscan.com',
  base: 'https://basescan.org',
  'base-sepolia': 'https://sepolia.basescan.org',
};
interface Post {
  chain: DeskChain;
  vault: string;
  order_id: number | null;
  verdict: 'HOLD' | 'EXIT' | 'MOVE' | number;
  confidence_bps: number;
  risk_bps: number;
  posted_at: number;
  state_hash?: string | null;
  resolved: boolean | number;
  adverse: boolean | number | null;
  reasons: number | string[] | null;
  resolved_at?: number | null;
}
interface Receipt extends DeskOrder {
  posts?: Post[];
  post_tx?: string | null;
}
function result(data: object, text: string, isError = false): ToolResult {
  return { structuredContent: { ...data }, content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}
function record(receipt: Receipt): VerdictRecord | null {
  const post = receipt.posts?.at(-1);
  if (!post) return null;
  const verdict = typeof post.verdict === 'number' ? (['HOLD', 'EXIT', 'MOVE'] as const)[post.verdict] : post.verdict;
  if (!verdict) throw new Error('Unknown verdict');
  const network = receipt.chain === 'base' || receipt.chain === 'monad' ? 'mainnet' : 'testnet';
  const tx = receipt.post_tx ?? null;
  const bits = typeof post.reasons === 'number' ? post.reasons : 0;
  return {
    order_id: receipt.id,
    chain: receipt.chain,
    vault: receipt.vault,
    verdict,
    confidence_bps: post.confidence_bps,
    risk_bps: post.risk_bps,
    reasons: Array.isArray(post.reasons)
      ? post.reasons
      : ['share price fell', 'assets fell', 'liquidity under 5%', 'vault reads failed'].filter(
          (_, i) => bits & (1 << i),
        ),
    posted_tx: tx,
    oracle: DEPLOYMENTS[network].oracles[receipt.chain] ?? null,
    state_hash: post.state_hash ?? null,
    valid_until: receipt.valid_until ?? null,
    explorer_url: tx ? `${EXPLORERS[receipt.chain]}/tx/${tx}` : null,
    grade: post.resolved ? { adverse: !!post.adverse, resolved_at: post.resolved_at ?? null } : null,
  };
}

export function makeTools(
  reader: ReinReader,
  payer: Payer,
  opts: { now(): number; sleep(ms: number): Promise<void>; waitCapS?: number; pollS?: number },
): McpToolSet {
  const waitCapS = opts.waitCapS ?? 240;
  const pollS = opts.pollS ?? 3;
  if (waitCapS < 0 || pollS <= 0) throw new Error('Invalid polling interval');
  const chainSchema = { type: 'string', enum: CHAINS };
  const vaultSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' };
  const definitions = [
    {
      name: 'list_vaults',
      description: 'Browse vault menus, prices, spacing and next allowed times for free.',
      properties: { chain: chainSchema },
    },
    {
      name: 'latest_verdict',
      description: 'Read the latest public verdict for a vault for free.',
      properties: { chain: chainSchema, vault: vaultSchema },
      required: ['chain', 'vault'],
    },
    {
      name: 'get_verdict',
      description:
        'Buy a fresh onchain verdict; without remote payment, returns x402 requirements. Resume pending payments with the same payment.',
      properties: { chain: chainSchema, vault: vaultSchema, payment: { type: 'string' } },
      required: ['chain', 'vault'],
    },
    {
      name: 'order_status',
      description: 'Read an order status and its delivered verdict for free.',
      properties: { order_id: { type: 'integer', minimum: 0 } },
      required: ['order_id'],
    },
    {
      name: 'ledger',
      description: 'Read public graded posts and the scoring summary for free.',
      properties: { chain: chainSchema, limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
    {
      name: 'guardian_transactions',
      description:
        'Build unsigned transactions to deposit into a vault and arm or disarm Guardian. Your wallet signs; Rein never holds funds.',
      properties: {
        action: { type: 'string', enum: ['deposit', 'arm', 'disarm'] },
        chain: { type: 'string', enum: ['base', 'monad'] },
        vault: vaultSchema,
        owner: vaultSchema,
        amount_usdc: { type: 'string' },
        shares: { type: 'string', pattern: '^[0-9]+$' },
        min_confidence_bps: { type: 'integer', minimum: 8000, maximum: 9900 },
        max_age_s: { type: 'integer', minimum: 60, maximum: 3600 },
      },
      required: ['action', 'chain', 'vault'],
    },
  ];
  function guardianTransactions(args: Record<string, unknown>): ToolResult {
    const chain = args.chain;
    if (chain !== 'base' && chain !== 'monad') throw new Error('chain must be base or monad');
    const address = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${what} address required`);
      return v as `0x${string}`;
    };
    const vault = address(args.vault, 'vault');
    let transactions: UnsignedTx[];
    if (args.action === 'deposit') {
      const owner = address(args.owner, 'owner');
      transactions = depositTxs({ chain, vault, owner, amount: String(args.amount_usdc ?? '') });
    } else if (args.action === 'arm') {
      if (typeof args.shares !== 'string' || !/^\d+$/.test(args.shares))
        throw new Error('shares must be a whole number');
      transactions = armTxs({
        chain,
        vault,
        shares: BigInt(args.shares),
        minConfidenceBps: Number(args.min_confidence_bps),
        maxAgeS: Number(args.max_age_s),
      });
    } else if (args.action === 'disarm') {
      transactions = disarmTxs({ chain, vault });
    } else throw new Error('action must be deposit, arm or disarm');
    return result(
      {
        chain,
        guardian: DEPLOYMENTS.mainnet.guardians[chain] ?? null,
        transactions,
        note: "Send these in order from the owner's wallet. For arm, pass the shares you hold after the deposit mines.",
      },
      `${transactions.length} unsigned transaction(s): ${transactions.map((t) => t.summary).join('; ')}.`,
    );
  }
  async function recent(chain?: DeskChain): Promise<Post[]> {
    const payload = (await reader.ledger(chain, 200)) as { recent: Post[] };
    return payload.recent.filter((p) => !chain || p.chain === chain);
  }
  async function status(id: number): Promise<ToolResult> {
    const receipt = (await reader.order(id)) as Receipt | null;
    const order = receipt ?? ((await reader.getOrder(id)) as DeskOrder | null);
    if (!order) return result({ error: 'no such order', order_id: id }, `Order ${id}: no such order.`, true);
    if (['rejected', 'refunded', 'post_failed'].includes(order.status)) {
      return result(
        { order_id: id, status: order.status, error: 'refund is automatic' },
        `Order ${id}: ${order.status}; the refund is automatic.`,
        true,
      );
    }
    const verdict = order.status === 'delivered' && receipt ? record(receipt) : null;
    return verdict
      ? result(verdict, `Order ${id}: ${verdict.verdict} (${verdict.confidence_bps} bps confidence).`)
      : result(
          { order_id: id, status: order.status, pending: true },
          `Order ${id}: ${order.status}; resume with order_status.`,
        );
  }
  async function run(name: string, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    if (name === 'guardian_transactions') return guardianTransactions(args);
    const chain = args.chain as DeskChain | undefined;
    if (chain !== undefined && !CHAINS.includes(chain)) throw new Error('Invalid chain');
    const vault = typeof args.vault === 'string' ? args.vault.toLowerCase() : '';
    if (['get_verdict', 'latest_verdict'].includes(name) && (!chain || !/^0x[0-9a-f]{40}$/.test(vault)))
      throw new Error('chain and vault address required');
    if (name === 'ledger') {
      const limit = args.limit === undefined ? 200 : args.limit;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200)
        throw new Error('limit must be an integer from 1 to 200');
      const data = await reader.ledger(chain, Number(limit));
      return result(data as object, 'Public Ledger: graded posts and scoring summary.');
    }
    if (name === 'order_status') {
      if (!Number.isSafeInteger(args.order_id) || Number(args.order_id) < 0)
        throw new Error('order_id must be a nonnegative integer');
      return status(Number(args.order_id));
    }
    if (name === 'latest_verdict') {
      const post = (await recent(chain))
        .filter((p) => p.vault.toLowerCase() === vault)
        .sort((a, b) => b.posted_at - a.posted_at)[0];
      if (post?.order_id != null) return status(post.order_id);
      return result({ verdict: null }, 'No public verdict for this vault.');
    }
    const policy = (await reader.policy()) as DeskPolicy;
    const posts = await recent(chain);
    const nextAllowed = (c: DeskChain, v: string) =>
      Math.max(
        0,
        ...posts
          .filter((p) => p.chain === c && p.vault.toLowerCase() === v.toLowerCase())
          .map((p) => p.posted_at + policy.spacing_s),
      );
    if (name === 'list_vaults') {
      const menus = [];
      for (const c of chain ? [chain] : CHAINS) {
        const vaults = await reader.menu(c);
        menus.push({ chain: c, vaults: vaults.map((v) => ({ vault: v, nextAllowedS: nextAllowed(c, v) })) });
      }
      return result(
        {
          menus,
          price_near: policy.price_near,
          price_usdc: policy.price_usdc,
          spacing_s: policy.spacing_s,
          kill: policy.kill,
        },
        'Vault menus with NEAR/USDC prices and spacing.',
      );
    }
    if (policy.kill) return result({ refused: 'kill switch on' }, 'Refused: kill switch on.');
    if (!(await reader.menu(chain!)).some((v) => v.toLowerCase() === vault))
      return result({ refused: 'vault not on menu' }, 'Refused: vault not on menu.');
    const nextAllowedS = nextAllowed(chain!, vault);
    if (nextAllowedS > opts.now())
      return result({ refused: 'spacing', nextAllowedS }, `Refused: spacing; next allowed at ${nextAllowedS}.`);
    if (args.payment !== undefined && typeof args.payment !== 'string') throw new Error('payment must be a string');
    const bought = await payer.buy(chain!, vault, args.payment as string | undefined);
    if ('refused' in bought) return result(bought, `Refused: ${bought.refused}.`);
    if ('paymentRequired' in bought)
      return result(
        { payment_required: true, accepts: bought.accepts },
        'Payment required: use the x402 requirements and call get_verdict with payment.',
      );
    if ('paymentPending' in bought)
      return result(
        { pending: true, payment_ref: bought.paymentRef, order_id: null },
        'Payment is still settling; call get_verdict again with the same payment; the same payment is never charged twice.',
      );
    const id = bought.orderId;
    const deadline = opts.now() + waitCapS;
    await reader.nudge(id);
    let previous = '';
    for (;;) {
      const order = (await reader.getOrder(id)) as DeskOrder | null;
      const current = order?.status ?? 'unknown';
      if (current !== previous) {
        await context?.progress?.(current);
        previous = current;
      }
      if (['rejected', 'refunded', 'post_failed'].includes(current))
        return result(
          { order_id: id, status: current, error: 'refund is automatic' },
          `Order ${id}: ${current}; the refund is automatic.`,
          true,
        );
      if (current === 'delivered') {
        const delivered = await status(id);
        if (!delivered.structuredContent.pending) return delivered;
      }
      if (opts.now() >= deadline)
        return result(
          { order_id: id, status: current, pending: true },
          `Order ${id}: ${current}; resume with order_status.`,
        );
      await opts.sleep(Math.min(pollS, deadline - opts.now()) * 1000);
    }
  }
  return definitions.map((d) => ({
    ...d,
    inputSchema: { type: 'object', properties: d.properties, ...(d.required ? { required: d.required } : {}) },
    async handler(args, context) {
      try {
        return await run(d.name, args, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Tool failed';
        return result({ error: message }, message, true);
      }
    },
  }));
}
