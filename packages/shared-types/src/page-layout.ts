/**
 * Page layout (M2, PLAN.md 3.4 "logical document model"). Built by layout-recon from the PageModel (docs/m2-contract.md).
 * The DocumentModel in PLAN.md is a collection of per-page PageLayouts. All geometry is in page space (geometry.ts).
 */
import type { RGB, Rect } from './geometry.js';

export type ParagraphRole =
  | 'body'
  | 'heading'
  | 'list-item'
  | 'caption'
  | 'header' // page header (running head, etc.)
  | 'footer' // page footer (page number, etc.)
  | 'footnote'
  | 'other';

/** A run of characters with the same style within a paragraph. start and end are LayoutParagraph.chars positions [start, end). */
export interface StyleRun {
  start: number;
  end: number;
  fontId: number;
  size: number;
  bold: boolean;
  italic: boolean;
  color: RGB | null;
}

export interface LayoutParagraph {
  id: number;
  bbox: Rect;
  /** PageModel.lines indices, in reading order. */
  lines: number[];
  /** PageModel.chars indices, in reading order (line order → order within a line). */
  chars: number[];
  /**
   * Paragraph text. Within a line: characters + spaceAfter spaces; between lines: a single space (joined directly if the line ends with "-").
   * Line breaks within a paragraph are treated as layout results and not kept (docs/m2-contract.md 2.3).
   */
  text: string;
  role: ParagraphRole;
  /** PageLayout.columns index. -1 for header, footer, in-table and figure label paragraphs. */
  column: number;
  /** LayoutTable.id if the paragraph is inside a table. */
  table: number | null;
  /** LayoutFigure.id if it is text inside a figure (axis labels, etc.). */
  figure: number | null;
  /** Baseline spacing (pt). null for a single line. M3 reflow input. */
  lineHeight: number | null;
  /** First-line indent (pt, relative to the left edge of the second and later lines. 0 for a single line). */
  firstLineIndent: number;
  align: 'left' | 'right' | 'center' | 'justify' | 'unknown';
  styleRuns: StyleRun[];
  /** The paragraph id if the paragraph continues in another column on the same page, otherwise null. */
  continuesTo: number | null;
}

export interface LayoutColumn {
  id: number;
  bbox: Rect;
}

export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: Rect;
  /** PageModel.lines indices inside the cell (reading order). */
  lines: number[];
  /** LayoutParagraph ids inside the cell. */
  paragraphs: number[];
}

export interface LayoutTable {
  id: number;
  bbox: Rect;
  rows: number;
  cols: number;
  /** Row boundary y (rows+1 entries, top→bottom), column boundary x (cols+1 entries, left→right). */
  rowBounds: number[];
  colBounds: number[];
  cells: TableCell[];
  /** lines: found by ruling lines, text: found by text alignment. */
  strategy: 'lines' | 'text';
  /**
   * PageModel.paths indices used as rules or background rectangles inside the table box (ascending; excluded from figure detection). The `lines` strategy finds the grid from these paths.
   * It is the basis for the path-deletion warning `table-rule-removed` (docs/m4-pdf-ops.md section 6 #5).
   */
  paths: number[];
}

export interface LayoutFigure {
  id: number;
  bbox: Rect;
  kind: 'image' | 'vector';
  /** PageModel.images and paths indices. */
  images: number[];
  paths: number[];
  /** LayoutParagraph ids of text inside the figure (axis labels, etc.). */
  labels: number[];
}

export interface LayoutItemRef {
  kind: 'paragraph' | 'table' | 'figure';
  id: number;
}

export interface PageLayout {
  pageIndex: number;
  bounds: Rect;
  columns: LayoutColumn[];
  paragraphs: LayoutParagraph[];
  tables: LayoutTable[];
  figures: LayoutFigure[];
  /**
   * Top-level reading order (header → body → footer). Paragraphs inside tables and figures are not included (tables go row-major by cell, figures by
   * labels order). Header and footer paragraphs are distinguished by role.
   */
  readingOrder: LayoutItemRef[];
  /** Lines not put into any paragraph (lines without visible characters). */
  unassignedLines: number[];
  warnings: string[];
  reconMs: number;
}

/** DocumentModel from PLAN.md: a collection of page layouts. */
export interface DocumentModel {
  pages: PageLayout[];
}
