/**
 * 편집 가능 표시(M4 계약 D6)의 순수 계산: 그릴 테두리 목록(문단·셀·패스)과 마우스 아래 표시 찾기.
 * 패스는 작은 것(짧은 변 < 1pt 이고 긴 변 < 4pt)을 빼고, 2,000 개를 넘으면 큰 순서로 2,000 개만 남긴다.
 */
import type { PageEditability, Point, Rect } from '@pdf-editor/shared-types';
import { limitLabel } from './edit-labels.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';

export const MAX_PATH_MARKS = 2000;
const SMALL_SHORT = 1;
const SMALL_LONG = 4;

export type MarkKind = 'paragraph' | 'cell' | 'path';

export interface Mark {
  kind: MarkKind;
  bbox: Rect;
  editable: boolean;
  /** 제한 사유 문구(화면 언어, 편집 가능이면 빈 목록). */
  reasons: string[];
  /** 문단 id 또는 paintSeq. */
  id: number;
}

export interface Marks {
  marks: Mark[];
  /** 개수 상한이나 크기 때문에 그리지 않은 패스 수. */
  pathsSkipped: number;
}

const area = (r: Rect): number => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);

export function isSmallPath(bbox: Rect): boolean {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  return Math.min(w, h) < SMALL_SHORT && Math.max(w, h) < SMALL_LONG;
}

export function buildMarks(
  editability: PageEditability,
  maxPaths = MAX_PATH_MARKS,
  t: ViewerStrings = VIEWER_STRINGS.ko,
): Marks {
  const labels = (reasons: readonly string[]) => reasons.map((r) => limitLabel(r, t));
  const marks: Mark[] = [];
  for (const p of editability.paragraphs) {
    marks.push({
      kind: p.cell ? 'cell' : 'paragraph',
      bbox: p.bbox,
      editable: p.editable,
      reasons: p.editable ? [] : labels(p.reasons),
      id: p.paragraphId,
    });
  }
  const kept = editability.paths.filter((p) => !isSmallPath(p.bbox));
  const sorted =
    kept.length > maxPaths ? [...kept].sort((a, b) => area(b.bbox) - area(a.bbox)) : kept;
  const shown = sorted.slice(0, maxPaths);
  for (const p of shown) {
    marks.push({
      kind: 'path',
      bbox: p.bbox,
      editable: p.editable,
      reasons: p.editable ? [] : labels(p.reasons),
      id: p.paintSeq,
    });
  }
  return { marks, pathsSkipped: editability.paths.length - shown.length };
}

/** 점 아래의 표시. 허용 거리 tol(pt) 안에서 가장 작은 상자(패스는 가는 선이라 같은 크기면 패스 우선). */
export function markAt(marks: readonly Mark[], p: Point, tol = 0): Mark | null {
  let best: Mark | null = null;
  for (const m of marks) {
    const [x0, y0, x1, y1] = m.bbox;
    if (p[0] < x0 - tol || p[0] > x1 + tol || p[1] < y0 - tol || p[1] > y1 + tol) continue;
    if (!best || area(m.bbox) < area(best.bbox)) best = m;
  }
  return best;
}

/**
 * 레이아웃 오버레이와 함께 그릴 때의 테두리 위치(사용자 요청 2026-10-22, "레이아웃·편집 표시" 한 버튼).
 * 레이아웃 상자와 같은 자리에 겹치지 않게 문단은 gap 만큼 바깥, 표 셀은 gap 만큼 안쪽(이웃 셀 테두리와 겹치지 않게)에
 * 그린다. 셀이 너무 작아 안쪽으로 줄일 수 없으면 원래 상자, 패스는 그대로(가는 선이라 겹쳐도 읽힌다). 단위 pt.
 */
export function markFrame(m: Mark, gap: number): Rect {
  const [x0, y0, x1, y1] = m.bbox;
  if (gap <= 0 || m.kind === 'path') return m.bbox;
  if (m.kind === 'paragraph') return [x0 - gap, y0 - gap, x1 + gap, y1 + gap];
  if (x1 - x0 <= 2 * gap || y1 - y0 <= 2 * gap) return m.bbox;
  return [x0 + gap, y0 + gap, x1 - gap, y1 - gap];
}

/** 툴팁 문구: "표 셀 · 편집 가능" 또는 "패스 · 제한: 사유…"(화면 언어). */
export function markTip(m: Mark, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  const head = t.markKinds[m.kind];
  return m.editable
    ? t.markEditable(head)
    : t.markLimited(head, m.reasons.length > 0 ? m.reasons.join(' / ') : t.markNoReason);
}
