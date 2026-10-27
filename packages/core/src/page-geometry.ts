import type * as mupdf from 'mupdf';
import type { Matrix, Point, Rect } from '@pdf-editor/shared-types';

/** /Rotate with inheritance applied (0, 90, 180 or 270). */
export function pageRotation(page: mupdf.PDFPage): number {
  const rotate = page.getObject().getInheritable('Rotate');
  return rotate.isNumber() ? ((rotate.asNumber() % 360) + 360) % 360 : 0;
}

/** Transforms a point by an affine matrix. */
export function transformPoint(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Bounding rectangle of the four corners of a rectangle transformed by a matrix. */
export function transformRect(rect: Rect, m: Matrix): Rect {
  const corners = [
    transformPoint(m, rect[0], rect[1]),
    transformPoint(m, rect[2], rect[1]),
    transformPoint(m, rect[0], rect[3]),
    transformPoint(m, rect[2], rect[3]),
  ];
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Intersection of two rectangles. Collapses to zero area if they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  return [x0, y0, Math.max(x0, Math.min(a[2], b[2])), Math.max(y0, Math.min(a[3], b[3]))];
}
