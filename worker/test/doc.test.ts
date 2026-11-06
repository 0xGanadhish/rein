import { describe, expect, it } from 'vitest';
import { buildDoc, type VaultReading } from '../src/doc';
import type { DeskOrder } from '../src/deskTypes';

const order: DeskOrder = {
  id: 12, source: 'near', payer: 'alice.testnet', chain: 'base',
  vault: '0x00000000000000000000000000000000000000aa', amount: '1000000', created_s: 1793774000, status: 'open', exit_pending_s: null, valid_until: null,
};
const reading: VaultReading = {
  block: 41_234_567n, name: 'Steakhouse USDC', pps: 1_043_211n, totalAssets: 98_765_432_100n,
  liquidityPct: 37.25, apyBps: 812, apyBpsPrev: 790, utilBps: 6275,
};

describe('buildDoc', () => {
  it('doc_fields_in_order', () => {
    expect(buildDoc(order, reading, { netOutPct1h: -1.5 }, 1793774225)).toBe(
      'rein-v1|order=12|chain=base|vault=0x00000000000000000000000000000000000000aa|at=1793774225|block=41234567'
        + '|pps=1043211|assets=98765432100|liquidity=37.25|apy_bps=812|apy_bps_prev=790|util_bps=6275'
        + '|net_out_pct_1h=-1.50|name=Steakhouse USDC',
    );
  });

  it('doc_has_no_quote_or_backslash', () => {
    const doc = buildDoc(order, { ...reading, name: 'Evil "Vault" \\ \u00e9\n|x' }, { netOutPct1h: 0 }, 1793774225);
    expect(doc).not.toMatch(/["\\]/);
    expect(doc).toMatch(/^[\x20-\x7e]+$/);
    expect(doc.endsWith('|name=Evil Vault  x')).toBe(true);
  });
});
