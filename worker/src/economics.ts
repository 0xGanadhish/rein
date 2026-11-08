import type { DeskAmounts, DeskStats } from '../../shared/desk';

interface MoneyOrder {
  id: number;
  source: string;
  status: string;
  amount: string;
  chain: string;
}
const zero = (): DeskAmounts => ({ near: '0', usdc: '0' });
const PER_ORDER_MARGIN_LIMIT = 200;
function add(to: DeskAmounts, source: string, amount: string) {
  if (source === 'near' || source === 'usdc') to[source] = String(BigInt(to[source]) + BigInt(amount));
}

/** No exchange-rate guesses: native fees and model USD cost remain separate from revenue. */
export async function economics(db: D1Database, stats: DeskStats | null) {
  const [orders, calls, attempts, executor, x402] = await Promise.all([
    db.prepare('SELECT id, source, status, amount, chain FROM orders ORDER BY id DESC').all<MoneyOrder>(),
    db.prepare('SELECT order_id, cost_usd_micros, credits_usd_micros, tokens_in, tokens_out FROM judge_calls').all<{
      order_id: number;
      cost_usd_micros: number;
      credits_usd_micros: number | null;
      tokens_in: number | null;
      tokens_out: number | null;
    }>(),
    db
      .prepare('SELECT order_id, chain, gas_wei, receipt_status FROM broadcast_attempts')
      .all<{ order_id: number; chain: string; gas_wei: string | null; receipt_status: string | null }>(),
    db
      .prepare(
        `SELECT f.chain, f.gas_wei, p.order_id FROM executor_fees f LEFT JOIN posts p
      ON p.chain = f.chain AND p.id = f.verdict_id`,
      )
      .all<{ chain: string; gas_wei: string; order_id: number | null }>(),
    db
      .prepare(
        `SELECT p.id, p.amount, p.state, p.settlement_status, a.order_id, a.amount AS order_amount, a.status AS attempt_status
      FROM x402_payments p LEFT JOIN x402_attempts a ON a.payment_id = p.id`,
      )
      .all<{
        id: string;
        amount: string;
        state: string;
        settlement_status: string;
        order_id: number | null;
        order_amount: string | null;
        attempt_status: string | null;
      }>(),
  ]);
  const delivered = zero(),
    opened = zero(),
    refunds = zero();
  let refundOrders = 0;
  let x402Revenue = 0n,
    x402Credits = 0n,
    x402Pending = 0n,
    x402Accounted = 0n;
  const paymentsSeen = new Set<string>();
  const x402Orders = new Map<number, { settled: boolean; revenue: string }>();
  for (const payment of x402.results) {
    const paid = payment.settlement_status === 'settled';
    if (payment.order_id !== null) {
      x402Orders.set(payment.order_id, {
        settled: paid,
        revenue: paid && payment.attempt_status === 'delivered' ? payment.amount : '0',
      });
      if (paid) x402Accounted += BigInt(payment.order_amount!);
    }
    if (paymentsSeen.has(payment.id)) continue;
    paymentsSeen.add(payment.id);
    if (!paid) continue;
    if (payment.state === 'delivered') x402Revenue += BigInt(payment.amount);
    else if (payment.state === 'credit') x402Credits += BigInt(payment.amount);
    else if (payment.state === 'ready' || payment.state === 'running') x402Pending += BigInt(payment.amount);
  }
  const reportedX402 = BigInt(
    stats?.sales_x402_usdc ??
      String(orders.results.filter((o) => o.source === 'x402').reduce((sum, o) => sum + BigInt(o.amount), 0n)),
  );
  const x402Unsettled = reportedX402 > x402Accounted ? reportedX402 - x402Accounted : 0n;
  const gas: Record<string, bigint> = {},
    failedGas: Record<string, bigint> = {},
    executorGas: Record<string, bigint> = {};
  const orderGas = new Map<number, bigint>();
  for (const fee of executor.results) {
    const wei = BigInt(fee.gas_wei);
    executorGas[fee.chain] = (executorGas[fee.chain] ?? 0n) + wei;
    if (fee.order_id !== null) orderGas.set(fee.order_id, (orderGas.get(fee.order_id) ?? 0n) + wei);
  }
  for (const a of attempts.results) {
    if (a.gas_wei === null) continue;
    const wei = BigInt(a.gas_wei);
    gas[a.chain] = (gas[a.chain] ?? 0n) + wei;
    orderGas.set(a.order_id, (orderGas.get(a.order_id) ?? 0n) + wei);
    if (a.receipt_status === 'reverted') failedGas[a.chain] = (failedGas[a.chain] ?? 0n) + wei;
  }
  const costByOrder = new Map<number, number>();
  let cost = 0,
    credits = 0,
    creditsKnown = true,
    unknownUsage = 0;
  for (const c of calls.results) {
    cost += c.cost_usd_micros;
    costByOrder.set(c.order_id, (costByOrder.get(c.order_id) ?? 0) + c.cost_usd_micros);
    if (c.credits_usd_micros === null) creditsKnown = false;
    else credits += c.credits_usd_micros;
    if (c.tokens_in === null || c.tokens_out === null) unknownUsage++;
  }
  for (const o of orders.results) {
    add(opened, o.source, o.amount);
    if (o.status === 'delivered') add(delivered, o.source, o.amount);
    if (['refunded', 'rejected', 'post_failed'].includes(o.status)) {
      add(refunds, o.source, o.amount);
      refundOrders++;
    }
  }
  const perOrder = orders.results.slice(0, PER_ORDER_MARGIN_LIMIT).map((o) => {
    const revenue = zero();
    if (o.status === 'delivered') add(revenue, o.source, o.amount);
    if (o.source === 'x402' && o.status === 'delivered') revenue.usdc = x402Orders.get(o.id)?.revenue ?? '0';
    const inference = costByOrder.get(o.id) ?? 0;
    return {
      order_id: o.id,
      chain: o.chain,
      status: o.status,
      revenue,
      judge_cost_usd_micros: inference,
      gas_wei: String(orderGas.get(o.id) ?? 0n),
      margin: {
        usdc_less_inference_micros: String(BigInt(revenue.usdc) - BigInt(inference)),
        near_yocto: revenue.near,
        native_gas_wei: String(orderGas.get(o.id) ?? 0n),
        near_gas_yocto: null,
      },
      positive_margin: null,
      margin_unavailable_reason: 'Native gas has no USD valuation; NEAR transaction fees are not measured.',
      x402_settled: o.source === 'x402' ? (x402Orders.get(o.id)?.settled ?? false) : null,
    };
  });
  // Split totals, unlike gross sales, accrue only on delivery. They include transfers still owed.
  const settled = stats
    ? {
        near: String(BigInt(stats.paid_agent.near) + BigInt(stats.paid_treasury.near)),
        usdc: String(BigInt(stats.paid_agent.usdc) + BigInt(stats.paid_treasury.usdc)),
      }
    : delivered;
  const chainGas: Record<
    string,
    {
      desk_wei: string | null;
      observed_wei: string;
      executor_wei: string;
      cost_wei: string;
      reverted_wei: string;
      cost_is_lower_bound: boolean;
    }
  > = {};
  for (const chain of new Set([
    ...Object.keys(stats?.gas_wei ?? {}),
    ...Object.keys(gas),
    ...Object.keys(executorGas),
  ])) {
    const desk = stats?.gas_wei[chain as keyof DeskStats['gas_wei']] ?? null;
    const observed = gas[chain] ?? 0n;
    // The journal overlaps desk totals: never add the same receipt twice.
    const total = desk !== null && BigInt(desk) > observed ? BigInt(desk) : observed;
    chainGas[chain] = {
      desk_wei: desk,
      observed_wei: String(observed),
      executor_wei: String(executorGas[chain] ?? 0n),
      cost_wei: String(total + (executorGas[chain] ?? 0n)),
      reverted_wei: String(failedGas[chain] ?? 0n),
      cost_is_lower_bound: true,
    };
  }
  return {
    settled_revenue: {
      ...settled,
      x402_usdc: String(x402Revenue),
      source: stats ? 'desk_split_totals_and_x402_journal' : 'mirrored_deliveries_and_x402_journal',
    },
    opened_orders: {
      n: orders.results.length,
      amounts: opened,
      desk_gross: stats ? { near: stats.sales_near, usdc: stats.sales_usdc } : null,
    },
    refunds: { authorized_orders: stats?.refunds ?? refundOrders, mirrored_amounts: refunds, paid_amounts: null },
    unpaid_liabilities: {
      usdc: stats?.owed ?? null,
      near: stats?.owed_near ?? null,
      x402_credit_usdc: String(x402Credits),
      x402_pending_usdc: String(x402Pending),
    },
    gas_per_chain: chainGas,
    inference: {
      underlying_cost_usd_micros: unknownUsage === 0 ? cost : null,
      known_cost_usd_micros: cost,
      credits_usd_micros: creditsKnown ? credits : null,
      cash_cost_usd_micros: creditsKnown && unknownUsage === 0 ? cost - credits : null,
      calls_with_unknown_usage: unknownUsage,
    },
    margin: {
      usdc_less_inference_micros: String(BigInt(settled.usdc) + x402Revenue - BigInt(cost)),
      near_yocto: settled.near,
      includes_native_gas: false,
    },
    positive_margin: null,
    margin_unavailable_reason: 'Native gas has no USD valuation; NEAR transaction fees are not measured.',
    self_funding: false,
    self_funding_reason:
      'NEAR and USDC receipts do not replenish EVM native gas; no automatic conversion is configured.',
    x402_unsettled_usdc: String(x402Unsettled),
    per_order_margin: perOrder,
    per_order_margin_truncated: orders.results.length > PER_ORDER_MARGIN_LIMIT,
  };
}
