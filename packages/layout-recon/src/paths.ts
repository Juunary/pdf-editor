/**
 * Path normalization (contract section 3, step 2). Moves `PathInfo.segments` (path space) into page space and
 * splits them into horizontal/vertical segments (rule candidates), fill rectangles, and other shapes. Clip paths are discarded.
 */
import type { PageModel, Point, RGB, Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { matrixScale, transformPoint } from './geom.js';

export interface Rule {
  orient: 'h' | 'v';
  /** h: y fixed (y0 = y1), x0 < x1. v: x fixed (x0 = x1), y0 < y1. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Thickness in page space (pt). */
  width: number;
  /** PageModel.paths index. */
  path: number;
  /** Whether it came from a fill rectangle with thickness at or below C.thinBoxMax. */
  fromBox: boolean;
}

export interface FilledBox {
  bbox: Rect;
  path: number;
  color: RGB | null;
}

export interface Shape {
  bbox: Rect;
  path: number;
  /** Whether it contains curves or diagonal lines. */
  complex: boolean;
}

export interface PathSummary {
  rules: Rule[];
  boxes: FilledBox[];
  shapes: Shape[];
}

const EPS = 0.5;

function rectOf(pts: Point[]): Rect | null {
  // Whether the closed 4 points (drop the last if equal to the first) form an axis-aligned rectangle.
  const p = pts.slice();
  if (p.length === 5 && Math.abs(p[0]![0] - p[4]![0]) < EPS && Math.abs(p[0]![1] - p[4]![1]) < EPS)
    p.pop();
  if (p.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = p[i]!;
    const b = p[(i + 1) % 4]!;
    if (Math.abs(a[0] - b[0]) > EPS && Math.abs(a[1] - b[1]) > EPS) return null;
  }
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function pushLine(
  out: Rule[],
  a: Point,
  b: Point,
  w: number,
  path: number,
  fromBox: boolean,
): boolean {
  if (Math.abs(a[1] - b[1]) <= EPS && Math.abs(a[0] - b[0]) > EPS) {
    const y = (a[1] + b[1]) / 2;
    out.push({
      orient: 'h',
      x0: Math.min(a[0], b[0]),
      x1: Math.max(a[0], b[0]),
      y0: y,
      y1: y,
      width: w,
      path,
      fromBox,
    });
    return true;
  }
  if (Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) > EPS) {
    const x = (a[0] + b[0]) / 2;
    out.push({
      orient: 'v',
      y0: Math.min(a[1], b[1]),
      y1: Math.max(a[1], b[1]),
      x0: x,
      x1: x,
      width: w,
      path,
      fromBox,
    });
    return true;
  }
  return false;
}

function boxToRule(r: Rect, path: number): Rule {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  if (h <= w) {
    const y = (r[1] + r[3]) / 2;
    return { orient: 'h', x0: r[0], x1: r[2], y0: y, y1: y, width: h, path, fromBox: true };
  }
  const x = (r[0] + r[2]) / 2;
  return { orient: 'v', y0: r[1], y1: r[3], x0: x, x1: x, width: w, path, fromBox: true };
}

export function summarizePaths(model: PageModel): PathSummary {
  const rules: Rule[] = [];
  const boxes: FilledBox[] = [];
  const shapes: Shape[] = [];
  model.paths.forEach((info, index) => {
    if (info.op === 'clip' || info.op === 'clip-stroke' || !info.segments) return;
    const stroke = info.op === 'stroke';
    const lw = stroke ? Math.max((info.lineWidth ?? 1) * matrixScale(info.ctm), 0.1) : 0;
    // Split into subpaths.
    const subpaths: { pts: Point[]; closed: boolean; curve: boolean }[] = [];
    let cur: { pts: Point[]; closed: boolean; curve: boolean } | null = null;
    for (const s of info.segments) {
      if (s.type === 'M') {
        cur = { pts: [transformPoint(info.ctm, s.p)], closed: false, curve: false };
        subpaths.push(cur);
      } else if (s.type === 'L') {
        cur?.pts.push(transformPoint(info.ctm, s.p));
      } else if (s.type === 'C') {
        if (cur) {
          cur.curve = true;
          cur.pts.push(transformPoint(info.ctm, s.p3));
        }
      } else if (cur) cur.closed = true;
    }
    let complex = false;
    const before = rules.length;
    for (const sp of subpaths) {
      if (sp.curve) {
        complex = true;
        continue;
      }
      // A stroke is treated as a rectangle only if the path is closed (an open "ㄷ"-shaped path has 3 edges). Fills are implicitly closed.
      const closedShape = !stroke || sp.closed || sp.pts.length === 5;
      const r = sp.pts.length >= 4 && closedShape ? rectOf(sp.pts) : null;
      if (r) {
        const w = r[2] - r[0];
        const h = r[3] - r[1];
        if (Math.min(w, h) <= C.thinBoxMax && Math.max(w, h) > C.thinBoxMax) {
          rules.push(
            boxToRule(
              stroke ? [r[0] - lw / 2, r[1] - lw / 2, r[2] + lw / 2, r[3] + lw / 2] : r,
              index,
            ),
          );
        } else if (stroke) {
          pushLine(rules, [r[0], r[1]], [r[2], r[1]], lw, index, false);
          pushLine(rules, [r[0], r[3]], [r[2], r[3]], lw, index, false);
          pushLine(rules, [r[0], r[1]], [r[0], r[3]], lw, index, false);
          pushLine(rules, [r[2], r[1]], [r[2], r[3]], lw, index, false);
        } else if (w > C.thinBoxMax && h > C.thinBoxMax) {
          boxes.push({ bbox: r, path: index, color: info.color?.rgb ?? null });
        }
        continue;
      }
      if (!stroke) {
        // Non-rectangular fill: shape.
        if (sp.pts.length > 2) complex = true;
        continue;
      }
      const pts = sp.closed ? [...sp.pts, sp.pts[0]!] : sp.pts;
      for (let i = 1; i < pts.length; i++) {
        if (!pushLine(rules, pts[i - 1]!, pts[i]!, lw, index, false)) {
          const a = pts[i - 1]!;
          const b = pts[i]!;
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) > EPS) complex = true;
        }
      }
    }
    if (complex) {
      // A path mixing diagonals and curves is treated as a shape including its segments (chart line series, etc.).
      rules.length = before;
      shapes.push({ bbox: info.bbox, path: index, complex: true });
    } else if (rules.length === before && boxes.at(-1)?.path !== index) {
      shapes.push({ bbox: info.bbox, path: index, complex: false });
    }
  });
  return { rules, boxes, shapes };
}
