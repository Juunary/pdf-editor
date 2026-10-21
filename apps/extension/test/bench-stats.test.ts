import { describe, expect, it } from 'vitest';
import { compareRuns, judgeTarget, percentile, summarize } from '../src/viewer/bench-stats.js';

describe('bench-stats', () => {
  it('nearest-rank 백분위', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(10);
    expect(percentile(xs, 0.95)).toBe(19);
    expect(percentile([5], 0.95)).toBe(5);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('summarize 는 정렬하지 않은 입력을 받는다', () => {
    const s = summarize([30, 10, 20]);
    expect(s).toMatchObject({ n: 3, p50: 20, p95: 30, max: 30, mean: 20 });
  });

  it('목표 판정: 500쪽 초과 문서의 열기·저장은 판정하지 않는다', () => {
    const s = summarize([1000, 1600]);
    expect(judgeTarget('open', s, 492)).toEqual({ target: 1500, p95: 1600, pass: false });
    expect(judgeTarget('open', s, 900)).toBeNull();
    expect(judgeTarget('nav', summarize([100, 200]), 900)?.pass).toBe(true);
    expect(judgeTarget('nav', summarize([]), 10)).toBeNull();
  });

  it('회귀: 직전 대비 +20% 초과만 표시한다', () => {
    const rows = compareRuns({ a: 100, b: 100, c: 0 }, { a: 121, b: 119, c: 5, d: 9 });
    expect(rows.map((r) => [r.key, r.regression])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});
