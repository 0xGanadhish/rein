/** Compare Ledger forecasts with deterministic baselines: pnpm baseline <url-or-file> or --check. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newCalls, scoreLedger } from '../shared/score.ts';
import type { LedgerPost } from '../web/lib/ledger.ts';

const LABELS = [
  'Rein',
  'coin (p=0.5)',
  'base rate (hindsight constant)',
  'rule: EXIT iff util_bps ≥ 9500 or liquidity < 2% (p .9/.1)',
];

function ruleProbability(doc: string | null): number {
  if (typeof doc !== 'string') throw new Error('Scored Ledger row lacks doc; rule baseline unavailable');
  const util = /(?:^|\|)util_bps=(-?\d+)(?:\||$)/.exec(doc);
  const liquidity = /(?:^|\|)liquidity=(na|\d+\.\d{2})(?:\||$)/.exec(doc);
  if (!util || !liquidity) throw new Error('Scored doc lacks buildDoc util_bps or liquidity');
  // Unavailable liquidity is not evidence of low liquidity; utilization still applies. APY is not an input.
  return Number(util[1]) >= 9500 || (liquidity[1] !== 'na' && Number(liquidity[1]) < 2) ? 0.9 : 0.1;
}

function compare(rows: LedgerPost[]): { n: number; brier: number | null }[] {
  const calls = newCalls(rows.map((row) => ({ ...row, postedAt: row.posted_at }))).filter(
    (row) => !row.repeat && row.resolved && row.adverse !== null,
  );
  const scored = calls.map((row) => {
    if (!Number.isFinite(row.risk_bps)) throw new Error(`Scored Ledger row ${row.id} lacks risk_bps`);
    return {
      verdict: row.verdict,
      confidenceBps: row.confidence_bps,
      riskBps: row.risk_bps,
      resolved: row.resolved,
      adverse: row.adverse,
    };
  });
  const rate = calls.length === 0 ? 0 : calls.filter((row) => row.adverse).length / calls.length;
  return [
    scoreLedger(scored),
    scoreLedger(scored.map((row) => ({ ...row, riskBps: 5000 }))),
    scoreLedger(scored.map((row) => ({ ...row, riskBps: rate * 10000 }))),
    scoreLedger(scored.map((row, i) => ({ ...row, riskBps: ruleProbability(calls[i].doc) * 10000 }))),
  ];
}

async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3) throw new Error('Usage: pnpm baseline <url-or-file|--check>');
  const check = source === '--check';
  const input = check
    ? await readFile(new URL('./fixtures/baseline-sample.json', import.meta.url), 'utf8')
    : /^https?:\/\//.test(source)
      ? await fetch(source).then((response) => {
          if (!response.ok) throw new Error(`Ledger HTTP ${response.status}`);
          return response.text();
        })
      : await readFile(source, 'utf8');
  const payload = JSON.parse(input) as { recent: LedgerPost[] };
  assert.ok(Array.isArray(payload.recent), 'Ledger must contain recent rows');
  const scores = compare(payload.recent);
  if (check) {
    const expected = ['0.065000', '0.250000', '0.240000', '0.170000'];
    scores.forEach((score, i) => {
      assert.equal(score.n, 10, `${LABELS[i]} N`);
      assert.equal(score.brier?.toFixed(6), expected[i], `${LABELS[i]} Brier`);
    });
    const doc = payload.recent[0].doc!;
    assert.ok(doc.includes('|apy_bps=na|'));
    assert.equal(ruleProbability(doc), 0.1, 'na_apy_is_not_zero');
    for (const apy of ['0', '500', '-100']) {
      assert.equal(ruleProbability(doc.replace('|apy_bps=na|', `|apy_bps=${apy}|`)), 0.1, 'na_apy_is_not_zero');
    }
    console.log('--check PASS (including na_apy_is_not_zero)');
  }
  console.log('| Forecast | N scored | Brier (lower is better) |');
  console.log('| --- | ---: | ---: |');
  scores.forEach((score, i) => console.log(`| ${LABELS[i]} | ${score.n} | ${score.brier?.toFixed(6) ?? 'na'} |`));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Baseline comparison failed');
  process.exitCode = 1;
});
