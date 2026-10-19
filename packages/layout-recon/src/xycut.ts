/**
 * 읽기 순서(계약 3절 6단계): 항목 상자에 재귀 XY-cut. 세로 빈 띠(C.gutterMin 이상)가 있으면 세로로 먼저,
 * 없으면 가로로 자른다. 둘 다 없으면 위→아래, 왼쪽→오른쪽으로 정렬한다.
 */
import type { Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';

export interface CutItem {
  bbox: Rect;
}

export interface CutResult {
  /** 항목 인덱스, 읽기 순서. */
  order: number[];
  /** 항목별 가장 안쪽 세로 자르기 묶음 번호. 세로 자르기 밖이면 -1. */
  group: number[];
}

/** 구간 [lo, hi] 들을 합쳐 빈 띠 위치(간격 ≥ minGap)를 돌려준다. */
function gaps(intervals: [number, number, number][], minGap: number): number[] {
  const s = [...intervals].sort((a, b) => a[0] - b[0]);
  const cuts: number[] = [];
  let hi = s[0]![1];
  for (let i = 1; i < s.length; i++) {
    const [lo, h] = s[i]!;
    if (lo - hi >= minGap) cuts.push((lo + hi) / 2);
    hi = Math.max(hi, h);
  }
  return cuts;
}

export function xyCut(items: readonly CutItem[]): CutResult {
  const order: number[] = [];
  const group = items.map(() => -1);
  let nextGroup = 0;
  const visit = (ids: number[]): void => {
    if (ids.length <= 1) {
      order.push(...ids);
      return;
    }
    const xs = gaps(
      ids.map((i) => [items[i]!.bbox[0], items[i]!.bbox[2], i]),
      C.gutterMin,
    );
    if (xs.length) {
      const bands = [...xs, Infinity];
      const parts: number[][] = bands.map(() => []);
      for (const i of ids) {
        const cx = (items[i]!.bbox[0] + items[i]!.bbox[2]) / 2;
        parts[bands.findIndex((x) => cx < x)]!.push(i);
      }
      for (const p of parts) {
        if (!p.length) continue;
        const g = nextGroup++;
        for (const i of p) group[i] = g;
        visit(p);
      }
      return;
    }
    const ys = gaps(
      ids.map((i) => [items[i]!.bbox[1], items[i]!.bbox[3], i]),
      0.5,
    );
    if (ys.length) {
      const bands = [...ys, Infinity];
      const parts: number[][] = bands.map(() => []);
      for (const i of ids) {
        const cy = (items[i]!.bbox[1] + items[i]!.bbox[3]) / 2;
        parts[bands.findIndex((y) => cy < y)]!.push(i);
      }
      for (const p of parts) if (p.length) visit(p);
      return;
    }
    order.push(
      ...[...ids].sort(
        (a, b) => items[a]!.bbox[1] - items[b]!.bbox[1] || items[a]!.bbox[0] - items[b]!.bbox[0],
      ),
    );
  };
  visit(items.map((_, i) => i));
  return { order, group };
}
