/** 사각형·행렬 계산(페이지 공간). */
import type { Matrix, Point, Rect } from '@pdf-editor/shared-types';

export const width = (r: Rect): number => r[2] - r[0];
export const height = (r: Rect): number => r[3] - r[1];
export const area = (r: Rect): number => Math.max(0, width(r)) * Math.max(0, height(r));

export function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

export function unionAll(rs: readonly Rect[]): Rect | null {
  if (rs.length === 0) return null;
  let u = rs[0]!;
  for (let i = 1; i < rs.length; i++) u = union(u, rs[i]!);
  return u;
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const r: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
}

/** x 구간 겹침 길이(음수면 간격). */
export const overlapX = (a: Rect, b: Rect): number => Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
export const overlapY = (a: Rect, b: Rect): number => Math.min(a[3], b[3]) - Math.max(a[1], b[1]);

export function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  if (!i) return 0;
  const ia = area(i);
  return ia / (area(a) + area(b) - ia);
}

/** a 가 b 안에 있는지(tol 만큼 여유). */
export const containsRect = (outer: Rect, inner: Rect, tol = 0): boolean =>
  inner[0] >= outer[0] - tol &&
  inner[1] >= outer[1] - tol &&
  inner[2] <= outer[2] + tol &&
  inner[3] <= outer[3] + tol;

export const center = (r: Rect): Point => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

export const containsPoint = (r: Rect, p: Point, tol = 0): boolean =>
  p[0] >= r[0] - tol && p[0] <= r[2] + tol && p[1] >= r[1] - tol && p[1] <= r[3] + tol;

export const expand = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];

export const transformPoint = (m: Matrix, p: Point): Point => [
  p[0] * m[0] + p[1] * m[2] + m[4],
  p[0] * m[1] + p[1] * m[3] + m[5],
];

/** 행렬의 등방 배율(선 폭 환산용). */
export const matrixScale = (m: Matrix): number => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
}

/**
 * 균일 격자 공간 색인(사각형). 질의 사각형과 같은 칸에 걸친 항목 번호를 돌려준다(겹침 여부는 호출자가 확인).
 * 많은 채움 사각형·경로가 있는 쪽에서 쌍별 비교(O(n²))를 피한다.
 */
export class GridIndex {
  readonly #cells = new Map<number, number[]>();
  readonly #cell: number;

  constructor(cell = 24) {
    this.#cell = cell;
  }

  #keys(r: Rect, fn: (key: number) => void): void {
    const c = this.#cell;
    const x0 = Math.floor(r[0] / c);
    const x1 = Math.floor(r[2] / c);
    const y0 = Math.floor(r[1] / c);
    const y1 = Math.floor(r[3] / c);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) fn((y + 4096) * 8192 + (x + 4096));
  }

  insert(id: number, r: Rect): void {
    this.#keys(r, (k) => {
      const list = this.#cells.get(k);
      if (list) list.push(id);
      else this.#cells.set(k, [id]);
    });
  }

  query(r: Rect): number[] {
    const seen = new Set<number>();
    this.#keys(r, (k) => {
      for (const id of this.#cells.get(k) ?? []) seen.add(id);
    });
    return [...seen];
  }

  /**
   * 후보마다 fn 을 한 번 부른다(집합을 만들지 않는다). `stamp` 는 항목 수 이상 길이의 배열로, 호출마다
   * 다른 `mark` 값을 넘긴다(같은 질의 안 중복 제거용).
   */
  forEach(r: Rect, stamp: Int32Array, mark: number, fn: (id: number) => void): void {
    this.#keys(r, (k) => {
      const list = this.#cells.get(k);
      if (!list) return;
      for (const id of list) {
        if (stamp[id] === mark) continue;
        stamp[id] = mark;
        fn(id);
      }
    });
  }
}
