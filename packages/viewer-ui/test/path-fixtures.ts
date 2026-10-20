/**
 * 테스트용 합성 패스(PageModel.paths·PathEditability). 단위 시험과 Playwright 하니스가 함께 쓴다.
 * 이 파일은 타입 import 외에 다른 import 를 두지 않는다(하니스가 JS 로 바꿔 싣는다).
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

export function makePath(
  paintSeq: number,
  rect: Rect,
  options: Partial<PathInfo> = {},
): PathInfo {
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
