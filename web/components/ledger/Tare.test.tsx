import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerScore } from '../../../shared/score';
import { readTareScore } from '@/lib/tare';
import { TareComparison } from './Tare';

const bands: LedgerScore['bands'] = [
  { band: '<80', n: 58, hitRate: 0.7758 },
  { band: '80-89', n: 12, hitRate: 0.8333 },
  { band: '90-94', n: 0, hitRate: null },
  { band: '95-100', n: 0, hitRate: null },
];
const tare: LedgerScore = { n: 70, brier: 0.3394, early: false, bands };
const rein: LedgerScore = { n: 12, brier: 0.0812, early: true, bands };

afterEach(() => vi.unstubAllGlobals());

describe('tare comparison', () => {
  it('tare_comparison_labelled_not_signature_checked', () => {
    const html = renderToStaticMarkup(<TareComparison tare={tare} rein={rein} />);
    expect(html).toContain('Tare · Jev, not signature-checked');
    expect(html).toContain('0.339');
    expect(html).toContain('70');
    expect(html).toContain('0.081');
    expect(html).toContain('https://tarefi.xyz');
  });

  it('tare_api_down_hides_comparison', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await readTareScore()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    expect(await readTareScore()).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ n: 'x' })));
    expect(await readTareScore()).toBeNull();
    expect(renderToStaticMarkup(<TareComparison tare={null} rein={rein} />)).toBe('');
  });
});
