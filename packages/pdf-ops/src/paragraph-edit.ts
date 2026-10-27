/**
 * Paragraph editing (M3, docs/m3-contract.md): editability classification (5.1), removal (D2, 5.2), edit block insertion (D3), font assignment (D4),
 * edit block writing (5.5), save metadata (5.6). The core edit session calls them in the order below.
 *
 *   planParagraphEdit → (FontManager.assign → reflow.layoutParagraph → writeEditBlock)* → commit
 *   prepareParagraphEdit is called once at draft start (removal + empty edit block insertion). core opens and closes the journal operation.
 *
 * The joint of the contract commit. Signatures are fixed. Implementation: edit-plan.ts (classification), edit-apply.ts (removal, insertion),
 * font-assign.ts (font assignment), edit-block.ts (writing, listing), edit-meta.ts (save metadata).
 */
import type * as mupdf from 'mupdf';
import type {
  ChangeKind,
  EditWarning,
  InsertionInfo,
  PageEditability,
  PageLayout,
  PageLinkage,
  PageModel,
  ParagraphEditPlan,
  ParagraphFormat,
  ParagraphTarget,
  Rect,
  SourceMap,
  TextRun,
} from '@pdf-editor/shared-types';
import { layoutParagraph, type FontSegment, type ReflowResult } from '@pdf-editor/reflow';
import { now } from './clock.js';
import { latestWriteContext, prepareEdit, releaseWriteContext, styleFor } from './edit-apply.js';
import { listBlocks, writeBlock } from './edit-block.js';
import { recordMetadata } from './edit-meta.js';
import { cellOfParagraph } from './cell-edit.js';
import { planPathEditability, releasePathEdit } from './path-edit.js';
import {
  analyzeParagraph,
  blockStartState,
  makeEnv,
  normalizeStartState,
  originalStartState,
  type AnalyzeEnv,
  type EditAnalysis,
  type StartState,
} from './edit-plan.js';
import { resolveStyle } from './edit-style.js';
import { FontState } from './font-assign.js';
import { FontCache } from './pdf-fonts.js';
import { decideSaveMethod } from './save-method.js';

/** Per-document PdfFont cache (shared by classification and apply). The fallback font is read separately by FontState. */
const docFonts = new WeakMap<mupdf.PDFDocument, FontCache>();
function fontCacheOf(doc: mupdf.PDFDocument): FontCache {
  let c = docFonts.get(doc);
  if (!c) {
    c = new FontCache(doc);
    docFonts.set(doc, c);
  }
  return c;
}

const fontStates = new WeakMap<FontManager, FontState>();
function fontStateOf(fonts: FontManager): FontState {
  const s = fontStates.get(fonts);
  if (!s) throw new Error('FontManager 상태 없음');
  return s;
}

function planOne(
  env: AnalyzeEnv,
  paragraphId: number,
  t0: number,
): Omit<ParagraphEditPlan, 'revision'> {
  return planWith(env, paragraphId, t0).plan;
}

function planWith(
  env: AnalyzeEnv,
  paragraphId: number,
  t0: number,
): { plan: Omit<ParagraphEditPlan, 'revision'>; analysis: EditAnalysis } {
  const { ctx } = env;
  const a = analyzeParagraph(env, paragraphId);
  const editable = a.limits.length === 0;
  const start = normalizeStartState(
    a.block ? blockStartState(ctx, a) : cellStart(originalStartState(ctx, a.paragraph), a),
  );
  const ins = a.insertion;
  const insertion: InsertionInfo | null = !editable
    ? null
    : a.block
      ? {
          container: a.formPath.length > 0 ? 'form-clone' : 'page',
          mode: 'rewrite-block',
          mcidKept: a.blockFormat?.insertion.mcidKept ?? null,
        }
      : ins
        ? {
            container: a.formPath.length > 0 ? 'form-clone' : 'page',
            mode: ins.mode,
            mcidKept: ins.mcidKept,
          }
        : null;
  const changes: ChangeKind[] = ['content-stream'];
  const save = decideSaveMethod(changes, ctx.doc.canBeSavedIncrementally());
  const cell = a.cell
    ? { table: a.cell.table.id, row: a.cell.cell.row, col: a.cell.cell.col }
    : null;
  const plan: Omit<ParagraphEditPlan, 'revision'> = {
    pageIndex: ctx.pageIndex,
    paragraphId,
    target: {
      pageIndex: ctx.pageIndex,
      glyphSeqs: a.chars.map((c) => ctx.model.chars[c]!.glyphSeq),
      editedBlock: a.block?.editId ?? null,
      bbox: [...a.paragraph.bbox] as Rect,
      ...(cell ? { cell } : {}),
    },
    editable: editable && insertion !== null,
    limits: a.limits,
    warnings: a.warnings,
    runs: start.runs,
    charIndexOfOffset: start.charIndexOfOffset,
    format: start.format,
    areaLimit: a.areaLimit,
    insertion,
    removal: {
      ops: a.removals.length,
      partialOps: a.removals.filter((r) => r.partial).length,
      formInstances: a.block ? 0 : a.formPath.length,
    },
    save: { method: save.method, changes },
    planMs: now() - t0,
  };
  return { plan, analysis: a };
}

/** Cell start format (D5): horizontal = cell − margin (original gap on the aligned side), vertical = character box, cell alignment, indent 0. */
function cellStart(state: StartState, a: EditAnalysis): StartState {
  const c = a.cell;
  if (!c) return state;
  const box = a.paragraph.bbox;
  return {
    ...state,
    format: {
      ...state.format,
      area: [c.areaX[0], box[1], c.areaX[1], box[3]],
      align: c.align,
      firstLineIndent: 0,
      lineHeight: c.lineHeight ?? state.format.lineHeight,
    },
  };
}

/** Page state used for classification and removal (taken from the core cache). */
export interface ParagraphEditContext {
  doc: mupdf.PDFDocument;
  pageIndex: number;
  model: PageModel;
  map: SourceMap;
  linkage: PageLinkage;
  layout: PageLayout;
  /** Edit blocks of this page (listEditBlocks result). */
  editBlocks: EditBlockRef[];
}

/** Edit block in the document (dedicated Form XObject, stream dictionary /PdfEditorEdit). */
export interface EditBlockRef {
  editId: string;
  /** Edit block Form XObject object number. */
  objectNumber: number;
}

export interface PreparedEdit {
  editId: string;
  target: ParagraphTarget;
  block: EditBlockRef;
  /** Object numbers changed or newly created by removal and insertion (expected value for the object diff). */
  changedObjects: number[];
}

export interface WriteResult {
  /** Edit block stream length (bytes, before compression). */
  streamBytes: number;
  /** Font and color-space resource names added by this write. */
  resources: string[];
  writeMs: number;
}

/**
 * Editability per flow paragraph of a page (contract 5.1 batch classification). revision and ms are filled in by the caller.
 *
 * An edit block is one item. Layout reconstruction after a commit may split the block's lines like other paragraphs (line spacing, short lines, forced
 * line breaks, justified spacing) or merge them with neighbor paragraph lines. Since the target is the whole block whichever such layout paragraph is edited
 * (contract D3), only one first paragraph id is kept per block, and the box is the block's character box (analyzeBlock). Using the layout paragraph box
 * as is would make one block look split into several borders or cover neighbor paragraphs (user report 2026-10-20, docs/m3-integration.md section 9).
 * A table cell is one item per cell (first paragraph id, box = cell box, M4 4.1). paths comes from planPathEditability (M4 4.2).
 */
export function planPageEditability(
  ctx: ParagraphEditContext,
  fonts: FontManager,
): Omit<PageEditability, 'revision' | 'ms'> {
  void fonts;
  const env = makeEnv(ctx, fontCacheOf(ctx.doc));
  const paragraphs: PageEditability['paragraphs'] = [];
  const blocks = new Set<string>();
  const cells = new Set<string>();
  for (const p of ctx.layout.paragraphs) {
    // A cell is one item (first paragraph id, box = cell box, contract 4.1).
    const found = p.table !== null ? cellOfParagraph(ctx.layout, p.id) : null;
    if (found) {
      const key = `${found.table.id}:${found.cell.row}:${found.cell.col}`;
      if (cells.has(key)) continue;
      cells.add(key);
    }
    const { plan, analysis } = planWith(env, p.id, now());
    const block = plan.target.editedBlock;
    if (block !== null) {
      if (blocks.has(block)) continue;
      blocks.add(block);
    }
    paragraphs.push({
      paragraphId: p.id,
      bbox: [
        ...(analysis.cell ? analysis.cell.box : block !== null ? plan.target.bbox : p.bbox),
      ] as Rect,
      editable: plan.editable,
      editedBlock: block,
      reasons: [...new Set(plan.limits.map((l) => l.reason))],
      cell: plan.target.cell ?? null,
    });
  }
  return { pageIndex: ctx.pageIndex, paragraphs, paths: planPathEditability(ctx) };
}

/** Editability, start text and area (contract 5.1, 5.3). Does not change the document. revision is filled in by the caller. */
export function planParagraphEdit(
  ctx: ParagraphEditContext,
  fonts: FontManager,
  paragraphId: number,
): Omit<ParagraphEditPlan, 'revision'> {
  const t0 = now();
  const plan = planOne(makeEnv(ctx, fontCacheOf(ctx.doc)), paragraphId, t0);
  if (!plan.editable || plan.target.editedBlock !== null) return plan;
  const format = fitAreaToNaturalLines(ctx, fonts, plan);
  return format === plan.format ? plan : { ...plan, format, planMs: now() - t0 };
}

/**
 * Start-area horizontal correction (docs/m3-integration.md 10.4 proposal 2): if the maximum natural width measured per original line with the reflow shaper
 * (excluding trailing line-end spaces, including the first-line indent) is larger than the area width, the area is widened to that width (opposite the aligned side, both sides for center, within areaLimit).
 * This prevents the same text from wrapping earlier because original lines sit narrower than the shaper width due to original TJ kerning, ligatures, etc. If no widening is needed,
 * the same object is returned. Measurement lays out text with a forced line break at each original line boundary in a wide area (the document is not changed).
 */
function fitAreaToNaturalLines(
  ctx: ParagraphEditContext,
  fonts: FontManager,
  plan: Omit<ParagraphEditPlan, 'revision'>,
): ParagraphFormat {
  const format = plan.format;
  const lineOf = new Map<number, number>();
  const wanted = new Set(plan.charIndexOfOffset.filter((c) => c >= 0));
  ctx.model.lines.forEach((line, li) => {
    for (const c of line.chars) if (wanted.has(c)) lineOf.set(c, li);
  });
  const runs: TextRun[] = [];
  let offset = 0;
  let prevLine = -1;
  let last = '';
  for (const run of plan.runs) {
    let text = '';
    for (let j = 0; j < run.text.length; j++) {
      const ci = plan.charIndexOfOffset[offset + j] ?? -1;
      const line = ci >= 0 ? (lineOf.get(ci) ?? prevLine) : prevLine;
      const ch = run.text[j]!;
      if (prevLine >= 0 && line !== prevLine && ch !== '\n' && last !== '\n') text += '\n';
      text += ch;
      last = ch;
      prevLine = line;
    }
    offset += run.text.length;
    runs.push({ text, style: run.style });
  }
  const text = runs.map((r) => r.text).join('');
  if (text.trim() === '') return format;
  // Assign using the classification-time resolution (do not go through FontManager.assign, so a past draft's WriteContext is not used).
  const { segments } = fontStateOf(fonts).assign(
    text,
    runs,
    (sc) => resolveStyle(ctx, sc),
    ctx.map,
  );
  const [x0, y0, x1, y1] = format.area;
  const huge = 1e6;
  const result = layoutParagraph({
    text,
    segments,
    format: { ...format, align: 'left', area: [x0, y0, x0 + huge, y1] },
    areaLimit: [-huge, -huge, huge, huge],
  });
  let need = 0;
  for (const line of result.summary.lines) {
    if (line.x1 > line.x0) need = Math.max(need, line.x1 - x0);
  }
  const width = x1 - x0;
  if (!(need > width + 1e-3)) return format;
  // Widen a little more so it falls within the line-width check slack (FIT_EPSILON 0.01pt). The value is logged, so it is fixed at 3 decimals.
  const grow = Math.ceil((need - width) * 1000 + 1) / 1000;
  // The widened side stops at 0.5pt before neighbor content (other paragraphs, images, paths that do not overlap the original area and straddle it vertically), together with the limit.
  // Widening over a neighbor makes the same text overlap other content or get hidden by content drawn later (M3 corpus measurement, 2 nasa-eo cases).
  const [left, right] = neighbourBounds(ctx, plan, format.area);
  const lim: Rect = [
    Math.max(plan.areaLimit[0], left),
    plan.areaLimit[1],
    Math.min(plan.areaLimit[2], right),
    plan.areaLimit[3],
  ];
  let [nx0, nx1] = [x0, x1];
  if (format.align === 'right') nx0 = Math.max(lim[0], x0 - grow);
  else if (format.align === 'center') {
    nx0 = Math.max(lim[0], x0 - grow / 2);
    nx1 = Math.min(lim[2], x1 + grow / 2);
  } else nx1 = Math.min(lim[2], x1 + grow);
  nx0 = Math.min(nx0, x0);
  nx1 = Math.max(nx1, x1);
  if (nx0 === x0 && nx1 === x1) return format;
  return { ...format, area: [nx0, y0, nx1, y1] };
}

/**
 * The edges of the nearest neighbor content to the left and right of the area (0.5pt gap). Neighbor = a paragraph, image or fill path outside the target that overlaps the area vertically
 * and does not overlap it horizontally (a background covering the area is not counted). ±Infinity if none.
 */
function neighbourBounds(
  ctx: ParagraphEditContext,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  area: Rect,
): [number, number] {
  const own = new Set(plan.charIndexOfOffset.filter((c) => c >= 0));
  const boxes: Rect[] = [];
  for (const p of ctx.layout.paragraphs) if (!p.chars.some((c) => own.has(c))) boxes.push(p.bbox);
  for (const im of ctx.model.images) boxes.push(im.bbox);
  for (const pa of ctx.model.paths) if (pa.op === 'fill' || pa.op === 'stroke') boxes.push(pa.bbox);
  let left = -Infinity;
  let right = Infinity;
  for (const b of boxes) {
    if (b[3] <= area[1] || b[1] >= area[3]) continue;
    if (b[0] >= area[2]) right = Math.min(right, b[0] - 0.5);
    else if (b[2] <= area[0]) left = Math.max(left, b[2] + 0.5);
  }
  return [left, right];
}

/**
 * Removal of the original paragraph (D2) + insertion of a call to an empty edit block at the insertion point (D3). Throws if plan.editable is false.
 * If the target is an edit block (target.editedBlock), returns that block without removal.
 */
export function prepareParagraphEdit(
  ctx: ParagraphEditContext,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  editId: string,
): PreparedEdit {
  return prepareEdit(ctx, plan, editId, fontCacheOf(ctx.doc));
}

/**
 * Rewrites the edit block stream and /PdfEditorFormat from the reflow result (contract 5.5, D3). runs is the array the result's
 * WritableGlyph.runIndex points to, and the font, fill color and ExtGState of the style source (sourceChar) are found in ctx.
 */
export function writeEditBlock(
  ctx: ParagraphEditContext,
  prepared: PreparedEdit,
  runs: TextRun[],
  format: ParagraphFormat,
  result: ReflowResult,
  fonts: FontManager,
): WriteResult {
  return writeBlock(ctx, prepared, runs, format, result, fontStateOf(fonts));
}

/**
 * Per edit block, the PageModel line indices that contain that block's characters (ascending). A pure function (does not read the document) for the layout reconstruction hint
 * (`ReconOptions.fixedGroups`, docs/m3-integration.md 9.6).
 *
 * A character's membership is decided by whether the block Form object number is in the original linkage (`linkage.charOp` → `SourceOp.formPath`)
 * (same rule as analyzeBlock). If a line mixes block characters and other characters, it goes to the block that holds the majority (more than half) of the visible characters.
 * With no majority it goes into no group (ordinary layout reconstruction). The result is in `blocks` order, and empty groups are dropped.
 */
export function editBlockLineGroups(
  model: PageModel,
  map: SourceMap,
  linkage: PageLinkage,
  blocks: readonly EditBlockRef[],
): number[][] {
  if (blocks.length === 0) return [];
  const order = new Map(blocks.map((b, k) => [b.objectNumber, k]));
  const blockOfOp = new Map<number, number>();
  const blockOfChar = (ci: number): number => {
    const opId = linkage.charOp[ci] ?? -1;
    if (opId < 0) return -1;
    let k = blockOfOp.get(opId);
    if (k === undefined) {
      k = -1;
      for (const s of map.ops[opId]?.formPath ?? []) {
        const hit = order.get(s.objectNumber);
        if (hit !== undefined) {
          k = hit;
          break;
        }
      }
      blockOfOp.set(opId, k);
    }
    return k;
  };
  const groups: number[][] = blocks.map(() => []);
  model.lines.forEach((line, li) => {
    const counts = new Map<number, number>();
    let visible = 0;
    for (const ci of line.chars) {
      if (model.chars[ci]!.text.trim() === '') continue;
      visible++;
      const k = blockOfChar(ci);
      if (k >= 0) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) {
      if (n * 2 > visible) {
        groups[k]!.push(li);
        break;
      }
    }
  });
  return groups.filter((g) => g.length > 0);
}

/** Finds /PdfEditorEdit edit blocks in page content and Forms (list rebuild after undo/redo, contract 5.7). */
export function listEditBlocks(doc: mupdf.PDFDocument, pageIndex: number): EditBlockRef[] {
  return listBlocks(doc, pageIndex);
}

/**
 * Records Info /PdfEditorEdits inside the commit operation (contract 5.6, D1 amendment 4). pages is the page index (from 0) of all active edits,
 * idempotent for the same input, union with the previous session's page numbers. core creates the Info dictionary before turning on the journal (contract amendment 1).
 */
export function recordEditMetadata(
  doc: mupdf.PDFDocument,
  info: { pages: number[]; structureNotUpdated: boolean },
): void {
  recordMetadata(doc, info);
}

/**
 * Fallback font (contract D4 amendment 1). core runs embedFont once just before turning on the journal (outside the operation). Being an object outside the journal, it
 * does not disappear on edit cancel or undo. FontManager does not call embedFont directly.
 */
export interface FallbackFontSource {
  /** Font bytes (coverage check, shaping). core awaits them in advance. */
  bytes(): Uint8Array;
  /** Embedded fallback font object (Type0). null before the journal is turned on (classification stage). */
  ref(): mupdf.PDFObject | null;
}

/** Font assignment (contract D4). One per document. */
export class FontManager {
  readonly #doc: mupdf.PDFDocument;
  readonly #fallback: FallbackFontSource;

  constructor(doc: mupdf.PDFDocument, fallback: FallbackFontSource) {
    this.#doc = doc;
    this.#fallback = fallback;
    fontStates.set(this, new FontState(this.#doc, this.#fallback));
  }

  /**
   * Assigns text to the original/fallback font per character (cluster). segments cover the text without gaps.
   * sourceChar of runs is the classification-time PageModel index of that draft (prepareParagraphEdit keeps the resolution).
   */
  assign(
    ctx: ParagraphEditContext,
    text: string,
    runs: TextRun[],
  ): { segments: FontSegment[]; warnings: EditWarning[] } {
    const wc = latestWriteContext(ctx.doc);
    const draft = wc && wc.pageIndex === ctx.pageIndex ? wc : null;
    return fontStateOf(this).assign(
      text,
      runs,
      (sc) => (draft ? styleFor(draft, sc) : resolveStyle(ctx, sc)),
      ctx.map,
    );
  }

  /** Only inside a save operation (contract D9): replaces the font with a subset that keeps only the glyphs that used the fallback font (A7-1). Discarding the operation reverts it. */
  finalizeForSave(): void {
    fontStateOf(this).finalizeForSave();
  }

  /**
   * Releases the original font probe and the fallback `mupdf.Font` (R-L3, `FontState.dispose`). Safe to call repeatedly. After release, assign etc.
   * throw. Document and edit block objects are not touched. core calls it when closing the document or replacing the FontManager.
   */
  dispose(): void {
    fontStateOf(this).dispose();
  }
}

/**
 * Discards the pdf-ops draft state (paragraph WriteContext, path preparation state) of one edit (editId) or the whole document (editId omitted) (R-L3).
 * core calls it after commit, cancel and reapply and when closing the document. Does not change the document contents.
 */
export function releaseEdit(doc: mupdf.PDFDocument, editId?: string): void {
  releaseWriteContext(doc, editId);
  releasePathEdit(doc, editId);
}
