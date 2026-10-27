/** Page navigation calculation (pure functions). Page numbers are 1-based on screen and internal indices are 0-based. */

export function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.trunc(index)));
}

/** Previous/next navigation. Stays in place when out of range. */
export function stepPage(current: number, delta: number, pageCount: number): number {
  return clampPage(current + delta, pageCount);
}

/**
 * Input box string (1-based) to a page index. null if not an integer or outside 1–pageCount.
 * Whitespace is allowed; input mixed with signs, decimal points or letters is rejected.
 */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < 1 || n > pageCount) return null;
  return n - 1;
}

export function canStep(current: number, delta: number, pageCount: number): boolean {
  const next = current + delta;
  return next >= 0 && next < pageCount;
}

/** Disabled state of the left/right arrows and toolbar buttons. On the first page previous is disabled; on the last page next is. */
export function navDisabled(current: number, pageCount: number): { prev: boolean; next: boolean } {
  return { prev: !canStep(current, -1, pageCount), next: !canStep(current, 1, pageCount) };
}

/**
 * Horizontal space of one row of left/right arrows (CSS px). A slot is button width 48 + gaps 3·3 on both sides = 54 (style.css `.pe-arrow-slot`), and 2 px of slack is added so that
 * rounding the page bitmap width up (at most 1 px) does not cause horizontal overflow. The viewer subtracts both shares from the available width.
 */
export const PAGE_ARROW_GUTTER = 56;

/** Minimum page CSS width (same as the default minWidth of `fitWidthScale`). */
export const MIN_PAGE_CSS_WIDTH = 320;
/** Sum of the document area's left/right margins (same as the default margin of `fitWidthScale` = inner margin 16·16 of the document area). */
export const PAGE_AREA_MARGIN = 32;

/**
 * Arrow placement. side: slots outside the page on the left and right (they do not overlap the page). overlay: in a narrow window with no room for side slots, the slots are removed
 * from the layout (width 0) and the two arrows float overlapping the page edges, inside the left and right edges of the document area (user decision 2026-10-26 change:
 * overlap if overlap is unavoidable, docs/m5-release.md 10.3).
 */
export type PageArrowPlacement = 'side' | 'overlay';

export interface PageArrowLayout {
  placement: PageArrowPlacement;
  /** Available width used for fit-to-page (`ViewerEnvironment.availableWidth`). For side, the side slot shares are subtracted. */
  availableWidth: number;
}

/**
 * Decides the arrow placement and the fit-to-page width from the document-area width (clientWidth of the scroll box, including inner padding and excluding the scrollbar).
 * If the minimum page width remains after subtracting two side-slot shares and the margin (width ≥ 320 + 2×56 + 32 = 464), side; otherwise overlay (the slot shares are not subtracted, so
 * the page becomes that much wider). The indicator (set by mount as `data-pe-arrows`) and fit-to-page (the host's getEnvironment) use the same function.
 */
export function pageArrowLayout(containerWidth: number): PageArrowLayout {
  const side = containerWidth - 2 * PAGE_ARROW_GUTTER - PAGE_AREA_MARGIN >= MIN_PAGE_CSS_WIDTH;
  return side
    ? { placement: 'side', availableWidth: containerWidth - 2 * PAGE_ARROW_GUTTER }
    : { placement: 'overlay', availableWidth: containerWidth };
}
