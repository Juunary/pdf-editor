/**
 * Synthetic paths for tests (PageModel.paths, PathEditability). Shared by unit tests and the Playwright harness.
 * This file has no imports other than type imports (the harness converts it to JS and loads it).
 */
import type { PathEditability, PathInfo, PathSegment, Rect } from '@pdf-editor/shared-types';

export function rectSegments(r: Rect): PathSegment[] {
  return [
    { type: 'M', p: [r[0], r[1]] },
    { type: 'L', p: [r[2], r[1]] },
    { type: 'L', p: [r[2], r[3]] },
    { type: 'L', p: [r[0], r[3]] },
    { type: 'Z' },
  ];
}

export function makePath(paintSeq: number, rect: Rect, options: Partial<PathInfo> = {}): PathInfo {
  return {
    paintSeq,
    op: 'fill',
    evenOdd: false,
    bbox: rect,
    ctm: [1, 0, 0, 1, 0, 0],
    color: { space: 'DeviceRGB', values: [1, 0, 0], rgb: [1, 0, 0] },
    alpha: 1,
    lineWidth: null,
    segments: rectSegments(rect),
    ...options,
  };
}

export function makeEditability(
  pathIndex: number,
  info: PathInfo,
  options: Partial<PathEditability> = {},
): PathEditability {
  return {
    pathIndex,
    paintSeq: info.paintSeq,
    bbox: info.bbox,
    editable: true,
    reasons: [],
    ...options,
  };
}
