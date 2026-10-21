/**
 * 벤치마크 통계·목표 판정·회귀 표시(계약 D1, 1.1). 순수 함수만 둔다.
 */

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** 오름차순 배열의 가장 가까운 순위(nearest-rank) 백분위. */
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

/** 지표별 p95 목표(ms, D1). 쪽 판정은 첫 진입(`judge`)과 캐시 재사용(`judgeReuse`)을 따로 둔다. */
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

/** 열기·저장 목표는 500쪽 이하 문서에만 적용한다. */
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

/** 메모리 기준(1.1): 추가 WASM 힙 ≤ 64 MiB, 탭 메모리 증가 ≤ 150 MiB. */
export const MEM_LIMITS_MIB = { wasmHeap: 64, tab: 150 } as const;

export interface RegressionRow {
  key: string;
  prev: number;
  cur: number;
  ratio: number;
  regression: boolean;
}

/** 직전 기록 대비 +20% 를 넘는 지표를 회귀로 표시한다(판정 아님). 값은 p95(ms) 맵. */
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
