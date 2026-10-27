/**
 * Pure geometry for vector path editing (M4 contract 4.5, D2): path flattening, hit testing, point numbering, box handle transform.
 * Does not depend on the DOM. Coordinates are in page space (pt, y down).
 */
import type { HandleName } from './edit-geometry.js';
import type {
  Matrix,
  PathEditability,
  PathInfo,
  PathSegment,
  Point,
  Rect,
} from '@pdf-editor/shared-types';

export const HANDLE_NAMES: readonly HandleName[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Line hit tolerance distance (screen px, contract 4.5). */
export const STROKE_HIT_PX = 4;
/** Number of subdivisions for flattening a curve. */
const CURVE_STEPS = 12;
/** Minimum box size (pt). */
export const MIN_BOX = 1;

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function applyMatrix(m: Matrix, p: Point): Point {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** The PathInfo group and classification of the same path (one paint operation). In the `B` family, two PathInfos make one candidate. */
export interface PathCandidate {
  paintSeq: number;
  infos: PathInfo[];
  editability: PathEditability;
  bbox: Rect;
}

/** Groups only paths that are edit targets (in the classification list) as candidates. A PathInfo without classification (clip, etc.) is excluded. */
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

/** Page-space path flattened into subpaths (vertex sequences). */
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

/** Minimum distance to the line (pt). For a closed path, the last → first edge is counted too. */
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

/** Fill inside test (an open subpath is treated as closed). If not evenOdd, the nonzero winding rule. */
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

/** Path-space line width → page-space pt (√|det| of the CTM, contract 4.3). */
export function pageLineWidth(info: PathInfo): number {
  if (info.lineWidth === null) return 0;
  const det = Math.abs(info.ctm[0] * info.ctm[3] - info.ctm[1] * info.ctm[2]);
  return info.lineWidth * Math.sqrt(det);
}

/**
 * Whether a candidate hits point p. A stroke (stroke family) hits within min(tolerance, …); a fill hits inside.
 * tolPt = the pt corresponding to 4 screen px. Half the line width is also added to the hit (clicks inside a thick line).
 * If there are no segments (not included in the extraction), approximated by the inside of the box.
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

/** The smallest of the hit candidates (the one painted later if equal). null if none. */
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

/** Move. */
export function translateBox(box: Rect, dx: number, dy: number): Rect {
  return [box[0] + dx, box[1] + dy, box[2] + dx, box[3] + dy];
}

/**
 * Box handle drag: the box with an edge or corner moved by (dx, dy). At a corner with keepRatio, keeps the original aspect ratio
 * and fixes the opposite corner. Edge handles do not use ratio locking. Guarantees the minimum size (MIN_BOX).
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

/** Size/translation affine that maps box from → to (no rotation). An axis of size 0 only translates. */
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

/** Box after the transform (a transform without rotation). */
export function transformRect(m: Matrix, r: Rect): Rect {
  const a = applyMatrix(m, [r[0], r[1]]);
  const b = applyMatrix(m, [r[2], r[3]]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** One point for point editing. index is the `PathEdit.points` number (a 0-based number counting segments from the start). */
export interface PathPoint {
  index: number;
  kind: 'anchor' | 'control';
  /** Page-space position. */
  p: Point;
  /** For a control point, the position of the connected vertex (used to draw the handle line). */
  anchor?: Point;
}

/**
 * Point numbering rule (shared-types edit.ts): M and L are 1 each, C is 2 control points + 1 endpoint, Z is 0.
 * Counted from 0 (assumed because the contract has no starting number, docs/m4-viewer-ui.md contract mismatch #1).
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

const SAME_POINT = 1e-9;
const sameSpot = (a: Point, b: Point) =>
  Math.abs(a[0] - b[0]) <= SAME_POINT * Math.max(1, Math.abs(a[0])) &&
  Math.abs(a[1] - b[1]) <= SAME_POINT * Math.max(1, Math.abs(a[1]));

/**
 * The attached control point to move together when moving vertex `index`. For `v` (first control point = previous vertex) and `y` (second control point = endpoint), the model shows
 * the control point overlapping the vertex at the same place. Moving only the vertex would break the overlap and change the operator to `c` (M4 review L3),
 * so the overlapping control point is moved too, keeping `v` and `y`. Not applicable when a control point is dragged directly (empty list).
 */
export function companionPoints(points: readonly PathPoint[], index: number): PathPoint[] {
  const moved = points.find((p) => p.index === index);
  if (!moved || moved.kind !== 'anchor') return [];
  return points.filter(
    (c) =>
      c.kind === 'control' &&
      c.anchor !== undefined &&
      sameSpot(c.p, c.anchor) &&
      sameSpot(c.anchor, moved.p),
  );
}

/** Edit value with one point moved to `to` (point-level edit, one point at a time). */
export function pointEdit(index: number, to: Point): { index: number; to: Point }[] {
  return [{ index, to }];
}
