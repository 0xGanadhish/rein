import { maxUint256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { inputCheck } from '../src/inputCheck';

const doc = (f: { pps?: string; assets?: string; liquidity?: string } = {}) =>
  `rein-v1|order=12|chain=base|vault=0x00000000000000000000000000000000000000aa|at=1793774225|block=100|pps=${f.pps ?? '1050000'}|assets=${f.assets ?? '5000000000'}|liquidity=${f.liquidity ?? '33.30'}|apy_bps=500|apy_bps_prev=480|util_bps=6670|net_out_pct_1h=0.50|name=Steakhouse USDC`;
const post = { ppsAtPost: 1_050_000n, assetsAtPost: 5_000_000_000n, liquidityAtPost: 1_665_000_000n };

describe('inputCheck', () => {
  it('within_tolerance_matches', () => {
    expect(inputCheck(doc(), post)).toBe('match');
    // 0.1% on share price, 2% on assets and on liquidity, either way.
    expect(inputCheck(doc({ pps: '1051050', assets: '5100000000', liquidity: '33.96' }), post)).toBe('match');
    expect(inputCheck(doc({ pps: '1048950', assets: '4900000000', liquidity: '32.64' }), post)).toBe('match');
    expect(inputCheck(doc({ liquidity: 'na' }), { ...post, liquidityAtPost: maxUint256 })).toBe('match');
  });

  it('pps_off_by_more_than_0_1pct_mismatches', () => {
    expect(inputCheck(doc({ pps: '1051051' }), post)).toBe('mismatch');
    expect(inputCheck(doc({ pps: '1048949' }), post)).toBe('mismatch');
  });

  it('assets_off_by_more_than_2pct_mismatches', () => {
    expect(inputCheck(doc({ assets: '5100000001' }), post)).toBe('mismatch');
    expect(inputCheck(doc({ assets: '4899999999' }), post)).toBe('mismatch');
    // Liquidity has the same 2% band, and a doc without it can't stand for a vault with an adapter.
    expect(inputCheck(doc({ liquidity: '34.00' }), post)).toBe('mismatch');
    expect(inputCheck(doc({ liquidity: 'na' }), post)).toBe('mismatch');
  });

  it('malformed_doc_is_unknown', () => {
    expect(inputCheck('', post)).toBe('unknown');
    expect(inputCheck(doc().replace('rein-v1', 'rein-v0'), post)).toBe('unknown');
    expect(inputCheck(doc({ pps: '1.05' }), post)).toBe('unknown');
    expect(inputCheck(doc({ liquidity: 'lots' }), post)).toBe('unknown');
    expect(inputCheck(doc().replace(/\|assets=\d+/, ''), post)).toBe('unknown');
    expect(inputCheck(doc().replace('|name=', '|name'), post)).toBe('unknown');
  });
});
