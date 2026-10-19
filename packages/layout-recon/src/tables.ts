/**
 * 표 검출(계약 3절 3단계). 괘선 전략과 정렬 전략.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import type { LineFeature } from './features.js';
import type { PathSummary } from './paths.js';

export interface DetectedCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: Rect;
  /** 셀 안 줄(LineFeature.index = PageModel.lines 인덱스), 위→아래·왼쪽→오른쪽. */
  lines: number[];
}

export interface DetectedTable {
  bbox: Rect;
  /** rows+1 개, 위→아래. */
  rowBounds: number[];
  /** cols+1 개, 왼쪽→오른쪽. */
  colBounds: number[];
  /** 덮는 셀만(병합 셀은 하나). 빈 셀도 넣는다. */
  cells: DetectedCell[];
  strategy: 'lines' | 'text';
  /** 표 괘선·배경으로 쓴 PageModel.paths 인덱스(도형 검출에서 뺀다). */
  paths: number[];
}

/**
 * 표를 찾는다. 반환한 표들의 셀 줄은 서로 겹치지 않는다(줄 하나는 최대 한 셀).
 * `lines` 는 가로 줄(horizontal)만 넘어온다.
 */
export function detectTables(
  _model: PageModel,
  _lines: readonly LineFeature[],
  _paths: PathSummary,
): DetectedTable[] {
  return [];
}
