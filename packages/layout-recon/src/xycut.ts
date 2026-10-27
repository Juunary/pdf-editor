/**
 * Reading order (contract section 3, step 6): recursive XY-cut over item boxes. If a vertical empty band (at least C.gutterMin) exists, cut vertically first;
 * otherwise cut horizontally. If neither is possible, sort top→bottom, left→right.
 */
import type { Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';

export interface CutItem {
  bbox: Rect;
}

export interface CutResult {
  /** Item indices, in reading order. */
  order: number[];
  /** Per-item group number of the innermost vertical cut. -1 if outside any vertical cut. */
  group: number[];
}

/** Merges the ranges [lo, hi] and returns empty band positions (gap ≥ minGap). */
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
