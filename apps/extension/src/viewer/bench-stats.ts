/**
 * Benchmark statistics, target checks and regression flags (contract D1, 1.1). Contains pure functions only.
 */

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile of an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function summarize(samples: readonly number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? NaN,
    mean: sorted.length > 0 ? sum / sorted.length : NaN,
  };
}

/** Per-metric p95 targets (ms, D1). Page classification has separate targets for first entry (`judge`) and cache reuse (`judgeReuse`). */
export const TARGETS_MS = {
  open: 1500,
  nav: 300,
  edit: 100,
  path: 150,
  judge: 1000,
  judgeReuse: 200,
  save: 3000,
} as const;

export type TargetKey = keyof typeof TARGETS_MS;

/** Open and save targets apply only to documents of 500 pages or fewer. */
export const PAGE_LIMITED_TARGETS: readonly TargetKey[] = ['open', 'save'];
export const PAGE_LIMIT = 500;

export interface Verdict {
  target: number;
  p95: number;
  pass: boolean;
}

export function judgeTarget(key: TargetKey, summary: Summary, pageCount: number): Verdict | null {
  if (PAGE_LIMITED_TARGETS.includes(key) && pageCount > PAGE_LIMIT) return null;
  if (summary.n === 0) return null;
  const target = TARGETS_MS[key];
  return { target, p95: summary.p95, pass: summary.p95 <= target };
}

/** Memory baseline (1.1): extra WASM heap ≤ 64 MiB, tab memory increase ≤ 150 MiB. */
export const MEM_LIMITS_MIB = { wasmHeap: 64, tab: 150 } as const;

export interface RegressionRow {
  key: string;
  prev: number;
  cur: number;
  ratio: number;
  regression: boolean;
}

/** Flags metrics exceeding +20% over the previous record as regressions (not a pass/fail judgment). The value is a map of p95 (ms). */
export function compareRuns(
  prev: Readonly<Record<string, number>>,
  cur: Readonly<Record<string, number>>,
  threshold = 0.2,
): RegressionRow[] {
  const rows: RegressionRow[] = [];
  for (const [key, value] of Object.entries(cur)) {
    const before = prev[key];
    if (before === undefined || !(before > 0) || !Number.isFinite(value)) continue;
    const ratio = value / before;
    rows.push({ key, prev: before, cur: value, ratio, regression: ratio > 1 + threshold });
  }
  return rows;
}
