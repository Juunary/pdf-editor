/**
 * 벡터 패스 편집의 순수 기하(M4 계약 4.5, D2): 패스 평탄화·맞음 판정·점 번호·상자 핸들 변환.
 * DOM 에 의존하지 않는다. 좌표는 페이지 공간(pt, y 아래)이다.
 */
import type {
  Matrix,
  PathEditability,
  PathInfo,
  PathSegment,
  Point,
  Rect,
} from '@pdf-editor/shared-types';

export type HandleName = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const HANDLE_NAMES: readonly HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 선 맞음 허용 거리(화면 px, 계약 4.5). */
export const STROKE_HIT_PX = 4;
/** 곡선 평탄화 분할 수. */
const CURVE_STEPS = 12;
/** 상자 최소 크기(pt). */
export const MIN_BOX = 1;

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function applyMatrix(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** 같은 패스(칠하기 연산 하나)의 PathInfo 묶음과 판정. `B` 계열은 PathInfo 2개가 한 후보다. */
export interface PathCandidate {
  paintSeq: number;
  infos: PathInfo[];
  editability: PathEditability;
  bbox: Rect;
}

/** 편집 대상(판정 목록에 있는) 패스만 후보로 묶는다. 판정이 없는 PathInfo(클립 등)는 뺀다. */
export function buildCandidates(
  paths: readonly PathInfo[],
  editability: readonly PathEditability[],
): PathCandidate[] {
  const bySeq = new Map<number, PathEditability>();
  for (const e of editability) bySeq.set(e.paintSeq, e);
  const out = new Map<number, PathCandidate>();
  for (const info of paths) {
    const e = bySeq.get(info.paintSeq);
    if (!e) continue;
    const cur = out.get(info.paintSeq);
    if (cur) cur.infos.push(info);
    else
      out.set(info.paintSeq, {
        paintSeq: info.paintSeq,
        infos: [info],
        editability: e,
        bbox: e.bbox,
      });
  }
  return [...out.values()];
}

/** 하위 경로(꼭짓점 열)로 평탄화한 페이지 공간 경로. */
export interface FlatSubpath {
  points: Point[];
  closed: boolean;
}

export function flattenPath(info: PathInfo): FlatSubpath[] {
  const segs = info.segments;
  if (!segs) return [];
  const out: FlatSubpath[] = [];
  let cur: FlatSubpath | null = null;
  let last: Point = [0, 0];
  const tp = (p: Point): Point => applyMatrix(info.ctm, p);
  for (const s of segs) {
    if (s.type === 'M') {
      cur = { points: [tp(s.p)], closed: false };
      out.push(cur);
      last = tp(s.p);
    } else if (s.type === 'L') {
      if (!cur) {
        cur = { points: [tp(s.p)], closed: false };
        out.push(cur);
      } else cur.points.push(tp(s.p));
      last = tp(s.p);
    } else if (s.type === 'C') {
      const p0 = last;
      const p1 = tp(s.p1);
      const p2 = tp(s.p2);
      const p3 = tp(s.p3);
      if (!cur) {
        cur = { points: [p0], closed: false };
        out.push(cur);
      }
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS;
        const u = 1 - t;
        cur.points.push([
          u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
        ]);
      }
      last = p3;
    } else if (cur) {
      cur.closed = true;
      last = cur.points[0]!;
    }
  }
  return out;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 선까지의 최소 거리(pt). 닫힌 경로는 마지막 → 처음 변도 센다. */
export function distanceToStroke(subpaths: readonly FlatSubpath[], p: Point): number {
  let best = Infinity;
  for (const sp of subpaths) {
    const pts = sp.points;
    for (let i = 0; i + 1 < pts.length; i++)
      best = Math.min(best, distToSegment(p, pts[i]!, pts[i + 1]!));
    if (sp.closed && pts.length > 1) {
      best = Math.min(best, distToSegment(p, pts[pts.length - 1]!, pts[0]!));
    }
    if (pts.length === 1) best = Math.min(best, Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]));
  }
  return best;
}

/** 채움 안쪽 판정(열린 하위 경로는 닫힌 것으로 본다). evenOdd 가 아니면 0 아닌 감김 규칙. */
export function insideFill(subpaths: readonly FlatSubpath[], p: Point, evenOdd: boolean): boolean {
  let winding = 0;
  let crossings = 0;
  for (const sp of subpaths) {
    const pts = sp.points;
    const n = pts.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      if (a[1] <= p[1] === b[1] <= p[1]) continue;
      const x = a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (x > p[0]) {
        crossings++;
        winding += b[1] > a[1] ? 1 : -1;
      }
    }
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0;
}

/** 경로 공간 선 두께 → 페이지 공간 pt(CTM 의 √|det|, 계약 4.3). */
export function pageLineWidth(info: PathInfo): number {
  if (info.lineWidth === null) return 0;
  const det = Math.abs(info.ctm[0] * info.ctm[3] - info.ctm[1] * info.ctm[2]);
  return info.lineWidth * Math.sqrt(det);
}

/**
 * 한 후보가 점 p 에 맞는가. 선(stroke 계열)은 min(허용거리, …) 안, 채움은 안쪽.
 * tolPt = 화면 4px 에 해당하는 pt. 선 폭의 절반도 맞음에 더한다(굵은 선 안쪽 클릭).
 * segments 가 없으면(추출에 포함하지 않음) 상자 안쪽으로 근사한다.
 */
export function candidateHit(c: PathCandidate, p: Point, tolPt: number): boolean {
  for (const info of c.infos) {
    if (info.op === 'clip') continue;
    if (!info.segments) {
      const [x0, y0, x1, y1] = info.bbox;
      if (p[0] >= x0 - tolPt && p[0] <= x1 + tolPt && p[1] >= y0 - tolPt && p[1] <= y1 + tolPt) {
        return true;
      }
      continue;
    }
    const flat = flattenPath(info);
    if (info.op === 'fill' && insideFill(flat, p, info.evenOdd)) return true;
    if (info.op === 'stroke' || info.op === 'clip-stroke') {
      if (distanceToStroke(flat, p) <= tolPt + pageLineWidth(info) / 2) return true;
    }
  }
  return false;
}

const area = (r: Rect): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

/** 맞는 후보 중 가장 작은 것(같으면 나중에 칠한 것). 없으면 null. */
export function pickPath(
  candidates: readonly PathCandidate[],
  p: Point,
  tolPt: number,
): PathCandidate | null {
  let best: PathCandidate | null = null;
  for (const c of candidates) {
    if (!candidateHit(c, p, tolPt)) continue;
    if (
      !best ||
      area(c.bbox) < area(best.bbox) ||
      (area(c.bbox) === area(best.bbox) && c.paintSeq > best.paintSeq)
    ) {
      best = c;
    }
  }
  return best;
}

export function unionRect(rects: readonly Rect[]): Rect {
  let [x0, y0, x1, y1] = rects[0] ?? [0, 0, 0, 0];
  for (const r of rects) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[2]);
    y1 = Math.max(y1, r[3]);
  }
  return [x0, y0, x1, y1];
}

/** 이동. */
export function translateBox(box: Rect, dx: number, dy: number): Rect {
  return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
}

/**
 * 상자 핸들 끌기: 변·모서리를 (dx, dy) 옮긴 상자. 모서리에서 keepRatio 면 원래 가로세로 비율을 유지하고
 * 반대 모서리를 고정한다. 변 핸들은 비율 고정을 쓰지 않는다. 최소 크기(MIN_BOX)를 보장한다.
 */
export function resizeBox(
  box: Rect,
  handle: HandleName,
  dx: number,
  dy: number,
  keepRatio: boolean,
): Rect {
  let [x0, y0, x1, y1] = box;
  const w = box[2] - box[0];
  const h = box[3] - box[1];
  if (handle.includes('w')) x0 = Math.min(x0 + dx, x1 - MIN_BOX);
  if (handle.includes('e')) x1 = Math.max(x1 + dx, x0 + MIN_BOX);
  if (handle.includes('n')) y0 = Math.min(y0 + dy, y1 - MIN_BOX);
  if (handle.includes('s')) y1 = Math.max(y1 + dy, y0 + MIN_BOX);
  if (keepRatio && handle.length === 2 && w > 0 && h > 0) {
    const sx = (x1 - x0) / w;
    const sy = (y1 - y0) / h;
    const s = Math.max(sx, sy);
    const nw = Math.max(w * s, MIN_BOX);
    const nh = Math.max(h * s, MIN_BOX);
    if (handle.includes('w')) x0 = x1 - nw;
    else x1 = x0 + nw;
    if (handle.includes('n')) y0 = y1 - nh;
    else y1 = y0 + nh;
  }
  return [x0, y0, x1, y1];
}

/** 상자 from → to 로 보내는 크기·이동 아핀(회전 없음). 크기 0 인 축은 이동만. */
export function boxTransform(from: Rect, to: Rect): Matrix {
  const w = from[2] - from[0];
  const h = from[3] - from[1];
  const sx = w > 1e-9 ? (to[2] - to[0]) / w : 1;
  const sy = h > 1e-9 ? (to[3] - to[1]) / h : 1;
  return [sx, 0, 0, sy, to[0] - from[0] * sx, to[1] - from[1] * sy];
}

export function isIdentity(m: Matrix, eps = 1e-9): boolean {
  return IDENTITY.every((v, i) => Math.abs(m[i]! - v) <= eps);
}

/** 변환 뒤 상자(회전 없는 변환). */
export function transformRect(m: Matrix, r: Rect): Rect {
  const a = applyMatrix(m, [r[0], r[1]]);
  const b = applyMatrix(m, [r[2], r[3]]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** 점 편집용 점 하나. index 는 `PathEdit.points` 번호(segments 를 앞에서부터 센 0 기준 번호). */
export interface PathPoint {
  index: number;
  kind: 'anchor' | 'control';
  /** 페이지 공간 위치. */
  p: Point;
  /** 제어점이면 이어진 꼭짓점의 위치(손잡이 선을 그리는 데 쓴다). */
  anchor?: Point;
}

/**
 * 점 번호 규칙(shared-types edit.ts): M·L 은 1개, C 는 제어점 2개 + 끝점 1개, Z 는 0개.
 * 0 기준으로 센다(계약에 시작 번호가 없어 가정, docs/m4-viewer-ui.md 계약 불일치 #1).
 */
export function pathPoints(info: PathInfo): PathPoint[] {
  const segs: PathSegment[] = info.segments ?? [];
  const out: PathPoint[] = [];
  let index = 0;
  let prev: Point = [0, 0];
  const tp = (p: Point): Point => applyMatrix(info.ctm, p);
  for (const s of segs) {
    if (s.type === 'M' || s.type === 'L') {
      const p = tp(s.p);
      out.push({ index: index++, kind: 'anchor', p });
      prev = p;
    } else if (s.type === 'C') {
      const p1 = tp(s.p1);
      const p2 = tp(s.p2);
      const p3 = tp(s.p3);
      out.push({ index: index++, kind: 'control', p: p1, anchor: prev });
      out.push({ index: index++, kind: 'control', p: p2, anchor: p3 });
      out.push({ index: index++, kind: 'anchor', p: p3 });
      prev = p3;
    }
  }
  return out;
}

/** 점 하나를 `to` 로 옮긴 편집 값(점 단위 편집, 한 번에 한 점). */
export function pointEdit(index: number, to: Point): { index: number; to: Point }[] {
  return [{ index, to }];
}
