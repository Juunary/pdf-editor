/**
 * Paragraph editing (M3, docs/m3-contract.md). Common types for edit plans, reflow summaries, drafts, logs and undo.
 * Geometry is in page space (geometry.ts), lengths in pt. Text positions are UTF-16 offsets into the string formed by concatenating TextRun.text.
 */
import type { Matrix, Point, RGB, Rect } from './geometry.js';
import type { PaintColor } from './page-model.js';
import type { RenderedPage } from './rpc.js';
import type { ChangeKind, SaveMethod } from './save.js';
import type { EditLimitReason } from './source-map.js';

/**
 * The paragraph being edited. Log reapplication runs in the same order, so it is referenced by glyphSeq in the state at application time.
 * When a block edited in the same session is edited again, its edit id is placed in editedBlock (contract 5.2).
 */
export interface ParagraphTarget {
  pageIndex: number;
  /** CharInfo.glyphSeq of the PageModel at application time (LayoutParagraph.chars order). */
  glyphSeqs: number[];
  editedBlock: string | null;
  /** Original paragraph bbox. */
  bbox: Rect;
  /** Cell position if the paragraph is inside a table cell (M4; absent or null means a flow paragraph; optional field for M3 log compatibility). */
  cell?: { table: number; row: number; col: number } | null;
}

/**
 * Character style. M3 has no UI for changing style, so it is expressed as "copy the style of the original character sourceChar" (contract D4).
 * Writing takes over the font resource and fill color operators of that character's operation. fontId, size, bold, italic and color are copies for display and classification.
 */
export interface RunStyle {
  /** PageModel.chars index at application time. */
  sourceChar: number;
  fontId: number;
  size: number;
  bold: boolean;
  italic: boolean;
  color: RGB | null;
  /**
   * Letter spacing added per glyph (pt, page space). The start state fills it from the original operation's `Tc` (Tc × Tz × font size/Tf size).
   * Reflow adds it to the cluster advance, and writing carries the position difference into TJ numbers. 0 if absent (compatibility with older logs and blocks).
   */
  charSpacing?: number;
  /**
   * Horizontal scale (original `Tz`/100). Reflow multiplies glyph advances by it, and writing emits it as `Tz` in the edit block. 1 if absent.
   */
  horizontalScale?: number;
}

/** A text run with the same style. A forced line break is "\n". */
export interface TextRun {
  text: string;
  style: RunStyle;
}

export type ParagraphAlign = 'left' | 'right' | 'center' | 'justify';

/**
 * Paragraph format. Handling of area overflow is a reflow rule, not an option (user decision 2026-10-20): when text overflows below the area,
 * the bottom edge is automatically lowered to the required height (up to areaLimit) (ReflowSummary.area). The overflow and fontScale
 * fields written by earlier builds (/PdfEditorFormat JSON, EditOp) are ignored when read.
 */
export interface ParagraphFormat {
  /** Layout area chosen by the user (default: original paragraph bbox, within areaLimit). The area actually used is ReflowSummary.area. */
  area: Rect;
  align: ParagraphAlign;
  /** First-line indent (pt, negative for hanging indent). */
  firstLineIndent: number;
  /** Baseline spacing (pt). */
  lineHeight: number;
  /** First-line baseline − area top (pt). */
  firstBaselineOffset: number;
}

/** Paragraph text replacement. Cell and vector edits are added in M4. */
export interface ReplaceParagraphOp {
  kind: 'replace-paragraph';
  /** Edit id (unique within the session). Same as the edit block's /PdfEditorEdit value. */
  id: string;
  target: ParagraphTarget;
  runs: TextRun[];
  format: ParagraphFormat;
}

/** Vector path being edited (M4). */
/** Fingerprint for verifying the path target (contract D4). Compared in plan, begin and reapplication so a shifted paintSeq never edits a different path. */
export interface PathFingerprint {
  /** Paint operator name (S, f, B, etc.). */
  paintOp: string;
  constructOpCount: number;
  /** Page-space box (rounded to 1e-3 pt). */
  bbox: Rect;
  /** Hash of the construction operator bytes (hex). */
  constructHash: string;
}

export interface PathTarget {
  pageIndex: number;
  /** First paintSeq per selected paint operator (relative to the PageModel at application time; valid only for in-order reapplication). */
  paintSeqs: number[];
  /** Same order as paintSeqs. */
  fingerprints: PathFingerprint[];
  bbox: Rect;
}

/** Vector path edit content. null means "unchanged". */
export interface PathEdit {
  /** Page-space affine (translation and scaling only). */
  transform: Matrix | null;
  fill: RGB | null;
  stroke: RGB | null;
  /** Page-space pt. */
  lineWidth: number | null;
  /**
   * Point-level edit (single path only, contract D2): point number in PageModel PathInfo.segments order → new position (page space).
   * The point number counts points from the start of segments (M and L give 1, C gives 2 control points + 1 end point). null means none.
   */
  points: { index: number; to: Point }[] | null;
  /** Path deletion (contract D2). If true, the other fields are ignored. */
  delete: boolean;
}

export interface EditPathOp {
  kind: 'edit-path';
  id: string;
  target: PathTarget;
  edit: PathEdit;
}

export type EditOp = ReplaceParagraphOp | EditPathOp;

/** Path edit limit reasons (M4, in addition to the operation-level reasons in EditLimitReason). */
export const PATH_LIMIT_REASONS = [
  'clip-path',
  'pattern-or-shading',
  'path-op-unparsed',
  'path-spans-streams',
  'inside-text-object',
  'path-interleaved-ops', // other operations between construction and painting (M4 review H3)
  'soft-mask', // SMask at paint time
  'singular-ctm', // same name and meaning as the paragraph reason
] as const;

export type PathLimitReason = (typeof PATH_LIMIT_REASONS)[number];

export interface PathLimit {
  reason: PathLimitReason | EditLimitReason;
  /** User-facing description (Korean). */
  detail: string;
}

/** Paragraph-level edit limit reasons (in addition to the operation-level reasons in EditLimitReason, contract 5.1). */
export const PARAGRAPH_LIMIT_REASONS = [
  'not-flow-paragraph', // No longer assigned by the classifier since M4 (figure labels 2026-10-21, table cells M4 D1). For compatibility with earlier results
  'vertical-or-rotated', // vertical writing / rotated lines
  'remove-skipped', // contains operations that removal would skip (detail = RemoveSkipCode)
  'mixed-content-sources', // spans page content and a Form, or different Form usage paths
  'actualtext-partial', // erases only some glyphs of an ActualText MC
  'singular-ctm', // insertion point CTM is a singular matrix
  'insertion-clipped', // the insertion point's non-rectangular clip does not cover the original paragraph bbox
  'bt-split-unsupported', // BT cannot be split (clip-text BT, displacement not computable, q/cm inside BT; reason in detail)
  'graphics-state-mismatch', // the SMask differs between the original character and the insertion point, or pattern fill
] as const;

export type ParagraphLimitReason = (typeof PARAGRAPH_LIMIT_REASONS)[number];

export interface ParagraphLimit {
  reason: ParagraphLimitReason | EditLimitReason;
  /** If reason is remove-skipped, the code of the reason removal skipped it. */
  code?: RemoveSkipCode;
  /** User-facing description (Korean). */
  detail: string;
  /** Corresponding PageModel.chars indices. An empty array if it applies to the whole paragraph. */
  chars: number[];
}

/** removeTextShowOps skip reason codes (contract D2). */
export const REMOVE_SKIP_CODES = [
  'not-text-show',
  'in-form', // operation inside a Form (handled on the clone path)
  'op-limit', // operation limits (spans-stream-boundary, tokenizer-error, etc.)
  'clip-text', // Tr 4–7
  'font-encoding-unresolved',
  'no-font-resource',
  'reread-failed', // operation bytes could not be reread
  'quote-operands', // " has too few operands
  'font-size-zero',
  'hscale-zero',
  'fallback-font', // MuPDF substitute font (load failure)
  'vertical',
  'type3',
  'width-uncertain',
  'tj-bad-token', // token other than string or number in the TJ array
  'cid-unmapped', // code with no CID mapping
  'glyph-count-mismatch',
] as const;

export type RemoveSkipCode = (typeof REMOVE_SKIP_CODES)[number];

export type EditWarningKind =
  | 'font-fallback' // characters missing from the original font are written with a fallback font
  | 'glyph-missing' // characters not written because neither the original nor the fallback has a glyph
  | 'synthetic-style' // synthetic bold/italic of the fallback font
  | 'tagged-structure-kept' // new text is inside the original MCID (structure tree unchanged)
  | 'tagged-structure-unlinked' // tagged page, but the new text is not linked to the structure
  | 'actualtext-cleared' // removed the ActualText of the erased MC
  | 'reading-order-approximate' // insertion point moved outside the MC, so it differs from the original position (contract D3 rule 3)
  | 'link-overlap' // link overlapping the edited paragraph (kept)
  | 'redact-overlap' // existing overlapping Redact annotation (applying it later would also erase the new text)
  | 'optional-content' // inside optional content (L7)
  | 'area-overlaps-content' // the (automatically) expanded area overlaps other text or shapes
  | 'overflow-clipped' // lines that overflow because of the area limit are clipped at the CropBox or parent Form BBox
  | 'color-space-changed' // color space changed to use a new color (M4 D3)
  | 'shared-form' // path inside a Form used in several places; only this location changes (M4)
  | 'path-clipped' // after editing, the path box is outside the clip or Form BBox at paint time (M4)
  | 'table-rule-removed'; // erased a path used as a table rule (table detection may change, M4)

export interface EditWarning {
  kind: EditWarningKind;
  /** User-facing description (Korean). For other languages, the viewer builds the sentence from kind, count, chars and variant (2026-10-26). */
  message: string;
  /** Count used in the sentence (number of fallback character kinds, erased ActualText, overlapping links, Redacts). The rects count if absent. */
  count?: number;
  /** Characters used in the sentence (fallback and glyph-less characters, first 20). */
  chars?: string;
  /** Case within the same kind. tagged-structure-unlinked: form-clone (/StructParents removed by cloning the Form), path-removed (path inside tagged content removed). */
  variant?: 'form-clone' | 'path-removed';
  /** Related areas (links, Redact annotations, overlap boxes). */
  rects: Rect[];
}

/** How new text is inserted (contract D3). */
export interface InsertionInfo {
  /** Stream where the edit block call is inserted: page content or a cloned Form. */
  container: 'page' | 'form-clone';
  /** before-bt: right before BT, split-bt: splits BT, rewrite-block: only rewrites an existing edit block. */
  mode: 'before-bt' | 'split-bt' | 'rewrite-block';
  /** Whether the new text goes inside the original MCID's marked content. null if there is no MCID. */
  mcidKept: boolean | null;
}

/** Pre-edit classification (does not modify the document, contract 5.1, 5.3). */
export interface ParagraphEditPlan {
  pageIndex: number;
  /** Paragraph id in the PageLayout at classification time. */
  paragraphId: number;
  /** Document revision at classification time. Passed through unchanged to beginParagraphEdit. */
  revision: number;
  target: ParagraphTarget;
  editable: boolean;
  limits: ParagraphLimit[];
  warnings: EditWarning[];
  /** Editor start text and style (contract 5.3). */
  runs: TextRun[];
  /** Text position → PageModel.chars index. -1 for synthetic spaces. Length = text length. */
  charIndexOfOffset: number[];
  format: ParagraphFormat;
  /** Area limit: CropBox ∩ (BBox if inside a Form) (A7-4). */
  areaLimit: Rect;
  /** null if editable is false. */
  insertion: InsertionInfo | null;
  /** Number of operations to erase (including operations erased only in part) and number of Form instances to clone. */
  removal: { ops: number; partialOps: number; formInstances: number };
  save: { method: SaveMethod; changes: ChangeKind[] };
  planMs: number;
}

/** Per-paragraph classification for hover display (getPageEditability). */
export interface ParagraphEditability {
  paragraphId: number;
  bbox: Rect;
  editable: boolean;
  /** The edit id if it is an edit block. */
  editedBlock: string | null;
  reasons: (ParagraphLimitReason | EditLimitReason)[];
  /** Cell position if the paragraph is inside a table cell, otherwise null (M4). */
  cell: { table: number; row: number; col: number } | null;
}

/** Per-path classification (M4). */
export interface PathEditability {
  /** PageModel.paths index. */
  pathIndex: number;
  paintSeq: number;
  bbox: Rect;
  editable: boolean;
  reasons: (PathLimitReason | EditLimitReason)[];
}

export interface PageEditability {
  pageIndex: number;
  revision: number;
  paragraphs: ParagraphEditability[];
  paths: PathEditability[];
  /**
   * Path classification error (for diagnostics). If path classification fails, `paths` is an empty list and the paragraph classification is returned as is. Absent when normal.
   */
  pathError?: string;
  ms: number;
}

/** Pre-edit path classification (M4, does not modify the document). */
export interface PathEditPlan {
  pageIndex: number;
  revision: number;
  target: PathTarget;
  editable: boolean;
  limits: PathLimit[];
  warnings: EditWarning[];
  fill: PaintColor | null;
  stroke: PaintColor | null;
  lineWidth: number | null;
  planMs: number;
}

export interface PathDraftUpdate {
  draftId: string;
  target: PathTarget;
  bbox: Rect;
  warnings: EditWarning[];
  region: RenderedPage;
  updateMs: number;
}

export interface BeginPathEditResult {
  draftId: string;
  plan: PathEditPlan;
}

/** Laid-out glyphs (per cluster). */
export interface PlacedGlyph {
  /** Text position where the cluster starts. */
  offset: number;
  /** Cluster length (UTF-16). */
  length: number;
  /** missing: neither the original nor the fallback has a glyph, so it is not written (width 0, for caret positioning). */
  font: { kind: 'original'; fontId: number } | { kind: 'fallback' } | { kind: 'missing' };
  /** Baseline origin (page space). */
  x: number;
  y: number;
  /** Advance (pt, including adjustments). */
  advance: number;
  /** Font size (pt). */
  size: number;
}

export interface PlacedLine {
  /** Baseline y. */
  baseline: number;
  /** Left and right of the line content (excluding trailing whitespace). For an empty line, the alignment anchor. */
  x0: number;
  x1: number;
  /** Ascent (positive) and descent (negative), pt. Line box = [baseline − ascent, baseline − descent]. */
  ascent: number;
  descent: number;
  /** Text positions of this line [start, end). The lines cover the text without gaps and include trailing whitespace and forced line break characters. */
  start: number;
  end: number;
  /** Ends with a forced line break. */
  hardBreak: boolean;
}

export interface ReflowSummary {
  /** At least one (even empty text has one line for the caret). */
  lines: PlacedLine[];
  glyphs: PlacedGlyph[];
  /** Union of the laid-out character boxes (including overflowed lines). */
  contentBox: Rect;
  /** Area actually used: the input area (within the limit), or, if the text overflows, the area with its bottom edge lowered to the required height (up to the limit). */
  area: Rect;
  /** Still overflowing after automatic expansion because of the limit. */
  overflow: boolean;
  reflowMs: number;
}

export interface DraftInput {
  runs: TextRun[];
  format: ParagraphFormat;
  /** Text position being composed by the IME [start, end). null if not composing. The composition string is contained in runs. */
  composition: [number, number] | null;
  /** Render scale of the changed area (viewer scale × devicePixelRatio). */
  renderScale: number;
}

export interface DraftUpdate {
  draftId: string;
  reflow: ReflowSummary;
  /** All warnings at that point (including plan warnings, one per kind). */
  warnings: EditWarning[];
  /** Render of the changed area (clip is filled in). */
  region: RenderedPage;
  updateMs: number;
}

export interface BeginEditResult {
  draftId: string;
  plan: ParagraphEditPlan;
  /** Preview of the start state (original text). */
  first: DraftUpdate;
}

export interface EditHistoryState {
  /** Increases every time the document changes (commit, undo, redo, reapplication). Guards against stale paragraph ids. */
  revision: number;
  /** Edit ids currently reflected in the document (log order). The viewer discards EditOps not listed here from the recovery log. */
  activeEditIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** Number of committed edits (excluding undone ones). */
  edits: number;
  /** Pages changed by the previous action (0-based). */
  affectedPages: number[];
}

export interface CommitResult {
  op: EditOp;
  history: EditHistoryState;
}

/** Edit blocks of a page (paragraphs edited in the same session). */
export interface EditedBlock {
  editId: string;
  contentBox: Rect;
  area: Rect;
}

export interface PageEditInfo {
  pageIndex: number;
  blocks: EditedBlock[];
}
