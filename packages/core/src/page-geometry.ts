import type * as mupdf from 'mupdf';
import type { Matrix, Point, Rect } from '@pdf-editor/shared-types';

/** 상속을 반영한 /Rotate(0·90·180·270). */
export function pageRotation(page: mupdf.PDFPage): number {
  const rotate = page.getObject().getInheritable('Rotate');
  return rotate.isNumber() ? ((rotate.asNumber() % 360) + 360) % 360 : 0;
}

/** 점을 아핀 행렬로 옮긴다. */
export function transformPoint(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 사각형을 행렬로 옮긴 네 꼭짓점의 경계 사각형. */
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

/** 두 사각형의 교집합. 겹치지 않으면 넓이 0 으로 접는다. */
export function intersectRect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  return [x0, y0, Math.max(x0, Math.min(a[2], b[2])), Math.max(y0, Math.min(a[3], b[3]))];
}
