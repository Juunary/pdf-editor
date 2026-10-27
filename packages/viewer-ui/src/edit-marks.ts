/**
 * Pure computation for the editability overlay (M4 contract D6): the list of borders to draw (paragraphs, cells, paths) and finding the mark under the mouse.
 * Small paths (short side < 1pt and long side < 4pt) are excluded, and if there are more than 2,000, only the 2,000 largest are kept.
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
  /** Limit-reason texts (display language; an empty list if editable). */
  reasons: string[];
  /** Paragraph id or paintSeq. */
  id: number;
}

export interface Marks {
  marks: Mark[];
  /** Number of paths not drawn because of the count limit or size. */
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

/** The mark under a point. The smallest box within the tolerance tol (pt) (paths are thin lines, so a path wins at equal size). */
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
 * Border positions when drawn together with the layout overlay (user request 2026-10-22, the single "레이아웃·편집 표시" button).
 * So as not to overlap the layout box at the same place, a paragraph is drawn outside by gap and a table cell inside by gap (so it does not overlap neighboring cell borders).
 * If a cell is too small to shrink inward, the original box is used; paths are unchanged (thin lines remain readable even when overlapping). Unit pt.
 */
export function markFrame(m: Mark, gap: number): Rect {
  const [x0, y0, x1, y1] = m.bbox;
  if (gap <= 0 || m.kind === 'path') return m.bbox;
  if (m.kind === 'paragraph') return [x0 - gap, y0 - gap, x1 + gap, y1 + gap];
  if (x1 - x0 <= 2 * gap || y1 - y0 <= 2 * gap) return m.bbox;
  return [x0 + gap, y0 + gap, x1 - gap, y1 - gap];
}

/** Tooltip text: "표 셀 · 편집 가능" or "패스 · 제한: 사유…" (display language). */
export function markTip(m: Mark, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  const head = t.markKinds[m.kind];
  return m.editable
    ? t.markEditable(head)
    : t.markLimited(head, m.reasons.length > 0 ? m.reasons.join(' / ') : t.markNoReason);
}
