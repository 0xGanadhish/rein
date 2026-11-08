import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Ledger } from '@/lib/ledger';
import { Books } from './Summary';

const business: Ledger['business'] = {
  desk: {
    sales_near: '3000000000000000000000000',
    sales_usdc: '5000000',
    sales_x402_usdc: '1000000',
    refunds: 2,
    open_paid: 1,
    inference_tokens_in: 0,
    inference_tokens_out: 0,
    gas_wei: { 'monad-testnet': '0', monad: '0', base: '0', 'base-sepolia': '0' },
    paid_treasury: { near: '700000000000000000000000', usdc: '2100000' },
    paid_agent: { near: '300000000000000000000000', usdc: '900000' },
    owed: '1000000',
    owed_near: '0',
    watch_orders: 0,
    as_of: 1_793_774_400,
  },
  judge_calls: 4,
  judge_cost_usd_micros: 148,
  orders: [],
  watch: { asked: 0, opened: 0 },
  settled_revenue: {
    near: '1000000000000000000000000',
    usdc: '3000000',
    x402_usdc: '500000',
    source: 'desk_split_totals_and_x402_journal',
  },
  refunds: { authorized_orders: 2, mirrored_amounts: { near: '0', usdc: '2000000' }, paid_amounts: null },
  unpaid_liabilities: { usdc: '1000000', near: '0', x402_credit_usdc: '250000', x402_pending_usdc: '0' },
  gas_per_chain: { monad: { cost_wei: '61200000000000000', cost_is_lower_bound: true } },
  inference: { known_cost_usd_micros: 148, calls_with_unknown_usage: 0 },
  margin: {
    usdc_less_inference_micros: '2999852',
    near_yocto: '1000000000000000000000000',
    includes_native_gas: false,
  },
  positive_margin: null,
  margin_unavailable_reason: 'Native gas has no USD valuation; NEAR transaction fees are not measured.',
  x402_unsettled_usdc: '1000000',
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Books', () => {
  it('business_panel_shows_sales_refunds_inference_gas_margin_split_kill_switch', () => {
    const t = text(renderToStaticMarkup(<Books business={business} kill />));
    expect(t).toContain('Paid by customers 3.00 NEAR · 5.00 USDC');
    expect(t).toContain('Revenue at delivery 1.00 NEAR · 3.00 USDC · x402 0.50 USDC');
    expect(t).toContain('Split, treasury / agent 2.10 / 0.90 USDC');
    expect(t).toContain('Refunds authorized 2');
    expect(t).toContain('Owed, not yet transferred 1.00 USDC · 0.00 NEAR');
    expect(t).toContain('x402, not yet settled 1.00 USDC');
    expect(t).toContain('x402 credits, not yet redeemed 0.25 USDC');
    expect(t).toContain('Model cost $0.0001');
    expect(t).toContain('Gas, at least monad 0.06 MON');
    expect(t).toContain('Margin before gas 2.99 USDC');
    expect(t).toContain('Native gas has no USD valuation');
    expect(t).toContain('Kill switch On');
  });

  it('owed_row_hidden_until_the_desk_is_read', () => {
    const unread = { ...business, unpaid_liabilities: { ...business.unpaid_liabilities, usdc: null, near: null } };
    expect(text(renderToStaticMarkup(<Books business={unread} kill />))).not.toContain('Owed, not yet transferred');
  });
});
