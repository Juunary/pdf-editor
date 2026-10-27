import { describe, expect, it } from 'vitest';
import { compareRuns, judgeTarget, percentile, summarize } from '../src/viewer/bench-stats.js';

describe('bench-stats', () => {
  it('nearest-rank percentile', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(10);
    expect(percentile(xs, 0.95)).toBe(19);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('summarize accepts unsorted input', () => {
    const s = summarize([30, 10, 20]);
    expect(s).toMatchObject({ n: 3, p50: 20, p95: 30, max: 30, mean: 20 });
  });

  it('target check: open and save are not judged for documents over 500 pages', () => {
    const s = summarize([1000, 1600]);
    expect(judgeTarget('open', s, 492)).toEqual({ target: 1500, p95: 1600, pass: false });
    expect(judgeTarget('open', s, 900)).toBeNull();
    expect(judgeTarget('nav', summarize([100, 200]), 900)?.pass).toBe(true);
    expect(judgeTarget('nav', summarize([]), 10)).toBeNull();
  });

  it('regression: only flags more than +20% over the previous record', () => {
    const rows = compareRuns({ a: 100, b: 100, c: 0 }, { a: 121, b: 119, c: 5, d: 9 });
    expect(rows.map((r) => [r.key, r.regression])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});
