import { describe, expect, it } from 'vitest';
import { newCalls, REPEAT_WINDOW_S, scoreLedger, type CallRow, type ScoreRow } from './score';

const T0 = 1_793_774_400;
const row = (vault: string, verdict: CallRow['verdict'], postedAt: number, chain = 'base'): CallRow & ScoreRow =>
  ({ chain, vault, verdict, postedAt, confidenceBps: 9000, riskBps: 9000, resolved: true, adverse: true });

describe('newCalls', () => {
  it('140_exits_30s_apart_count_once', () => {
    const rows = Array.from({ length: 140 }, (_, i) => row('0xaa', 'EXIT', T0 + 30 * i));
    // The burst runs 70 minutes, but each post is 30 s after the last.
    expect(rows.at(-1)!.postedAt - rows[0].postedAt).toBeGreaterThan(REPEAT_WINDOW_S);
    expect(newCalls(rows)).toEqual([rows[0]]);
    expect(scoreLedger(newCalls(rows)).n).toBe(1);
    // Order of the input doesn't matter.
    expect(newCalls([...rows].reverse())).toEqual([rows[0]]);
  });

  it('same_verdict_after_an_hour_is_new', () => {
    const rows = [row('0xaa', 'HOLD', T0), row('0xaa', 'HOLD', T0 + REPEAT_WINDOW_S - 1), row('0xaa', 'HOLD', T0 + 2 * REPEAT_WINDOW_S - 1)];
    expect(newCalls(rows)).toEqual([rows[0], rows[2]]);
  });

  it('different_verdict_is_new', () => {
    const rows = [row('0xaa', 'HOLD', T0), row('0xaa', 'EXIT', T0 + 30), row('0xaa', 'EXIT', T0 + 60), row('0xaa', 'HOLD', T0 + 90)];
    expect(newCalls(rows)).toEqual([rows[0], rows[1], rows[3]]);
  });

  it('vaults_independent', () => {
    const rows = [
      row('0xaa', 'EXIT', T0), row('0xbb', 'EXIT', T0 + 30), row('0xAA', 'EXIT', T0 + 60),
      row('0xaa', 'EXIT', T0 + 90, 'monad'), row('0xbb', 'EXIT', T0 + 120),
    ];
    expect(newCalls(rows)).toEqual([rows[0], rows[1], rows[3]]);
  });
});
