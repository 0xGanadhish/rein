import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LedgerPost } from '@/lib/ledger';
import { Calls } from './Calls';

const post: LedgerPost = {
  chain: 'monad-testnet', id: 9, vault: '0x00000000000000000000000000000000000000aa', verdict: 'EXIT',
  confidence_bps: 9400, risk_bps: 8100, posted_at: 1_793_774_400, order_id: 3, input_check: 'match',
  resolved: true, adverse: true, reasons: 1, repeat: false,
  doc: 'rein-v1|order=3|chain=monad-testnet|block=123', signer: '0x4c1f7a20d9e3b5a6c8f0e2d4b6a8c0e2f4b39e02',
};
const row = (html: string, id: number) => html.match(new RegExp(`<tr[^>]*data-post="${id}"[\\s\\S]*?</tr>`))?.[0] ?? '';

describe('ledger calls', () => {
  it('verdict_row_shows_doc_answer_signer_input_check_grade', () => {
    const r = row(renderToStaticMarkup(<Calls posts={[post]} />), 9);
    expect(r).toContain('rein-v1|order=3|chain=monad-testnet|block=123');
    expect(r).toContain('EXIT');
    expect(r).toContain('94.0%');
    expect(r).toContain('81.0%');
    expect(r).toContain('0x4c1f…9e02');
    expect(r).toContain('match');
    expect(r).toMatch(/Adverse/);
  });

  it('mismatch_is_flagged', () => {
    const html = renderToStaticMarkup(<Calls posts={[post, { ...post, id: 10, input_check: 'mismatch' }]} />);
    expect(row(html, 9)).not.toContain('data-mismatch');
    expect(row(html, 10)).toContain('data-mismatch="true"');
    expect(row(html, 10)).toContain('Input mismatch');
  });
});
