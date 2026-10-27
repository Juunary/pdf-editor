/**
 * Editability classification and removal/insertion analysis (docs/m3-contract.md 5.1, D1, D2, D3). Does not change the document.
 *
 * The analysis result (EditAnalysis) is shared by classification (planParagraphEdit, planPageEditability) and apply (prepareParagraphEdit).
 * The same document and the same SourceMap give the same result (apply recomputes the classification).
 */
import type * as mupdf from 'mupdf';
import type {
  ContentStreamRef,
  EditLimitReason,
  EditWarning,
  FormStep,
  InsertionInfo,
  LayoutParagraph,
  Matrix,
  ParagraphAlign,
  ParagraphFormat,
  ParagraphLimit,
  ParagraphLimitReason,
  Rect,
  RunStyle,
  SourceOp,
  TextRun,
} from '@pdf-editor/shared-types';
import { cellTarget, type CellTarget } from './cell-edit.js';
import { offsetMap } from './text-map.js';
import { parseContentOpsLenient } from './content-stream.js';
import {
  concat,
  determinant,
  fmtExact,
  formKey,
  intersect,
  invert,
  latin1String,
  lookupResource,
  overlaps,
  resourceChain,
  StreamCache,
  transformRect,
  union,
} from './edit-common.js';
import { extGStateOf, readColorOp, samePdfValue } from './edit-style.js';
import type { FontCache } from './pdf-fonts.js';
import type { EditBlockRef, ParagraphEditContext } from './paragraph-edit.js';
import { listRedactAnnots } from './redact-existing.js';
import {
  analyzeShow,
  displacementBefore,
  isSkip,
  type ShowAnalysis,
  type SkipInfo,
} from './show-ops.js';

/** /PdfEditorFormat in the block stream dictionary (contract D3, 5.3). */
export interface BlockFormat {
  v: 1;
  format: ParagraphFormat;
  runs: {
    text: string;
    size: number;
    bold: boolean;
    italic: boolean;
    color: [number, number, number] | null;
    /** RunStyle.charSpacing (pt). Not written if 0. */
    charSpacing?: number;
    /** RunStyle.horizontalScale. Not written if 1. */
    horizontalScale?: number;
    /** Original font name (BaseFont). The fallback font name for the fallback. */
    font: string;
    synthetic: { bold: boolean; italic: boolean };
  }[];
  /** Text position per written glyph (stream order). Used to restore sourceChar and caret positions after reopening. */
  glyphOffsets: number[];
  /** Text positions of characters not written (glyph-missing). */
  missing: number[];
  insertion: InsertionInfo;
  areaLimit: Rect;
}

export interface OpRemoval {
  op: SourceOp;
  /** Whether each text.glyphs index is erased. */
  remove: boolean[];
  partial: boolean;
  analysis: ShowAnalysis;
}

export interface InsertionPoint {
  mode: 'before-bt' | 'split-bt';
  /** Stream and byte position to insert at (inserted before that position). If splitOp is present, inside that operation (between the rewritten TJs). */
  stream: ContentStreamRef;
  offset: number;
  splitOp: number | null;
  splitGlyph: number | null;
  /** Text to continue after the edit block call for split-bt (`BT <Tlm> Tm [n] TJ`). Empty string for before-bt. */
  resume: string;
  /** Operation that has the graphics state of the insertion point. */
  stateOp: SourceOp;
  /** Insertion-point CTM (that stream's content space → user space). */
  ctm: Matrix;
  mcidKept: boolean | null;
  /** Moved outside marked content by rule 3. */
  moved: boolean;
}

export interface EditAnalysis {
  paragraph: LayoutParagraph;
  /** Target characters (PageModel.chars indices, paragraph order. For an edit block, block characters in glyphSeq order). */
  chars: number[];
  /** The block, if the target is an edit block. */
  block: EditBlockRef | null;
  blockStep: FormStep | null;
  blockFormat: BlockFormat | null;
  limits: ParagraphLimit[];
  warnings: EditWarning[];
  removals: OpRemoval[];
  /** Form usage path of the content into which the new text (edit block call) goes. Empty array for page content. */
  formPath: FormStep[];
  insertion: InsertionPoint | null;
  areaLimit: Rect;
  /** BDC operation ids from which to remove ActualText. */
  actualTextClears: number[];
  /** The Form to duplicate has /StructParents, which is removed from the copy. */
  structParentsRemoved: boolean;
  /** Table cell target (M4 D1). paragraph is the paragraph that joins the cell paragraphs. */
  cell: CellTarget | null;
}

/** State shared within a single classification (one page). */
export interface AnalyzeEnv {
  ctx: ParagraphEditContext;
  fonts: FontCache;
  streams: StreamCache;
  blockNums: Map<number, EditBlockRef>;
  links: Rect[];
  redacts: Rect[];
  formats: Map<number, BlockFormat | null>;
  /** (Form path, font resource name) → font resource value. */
  fontRefs: Map<string, mupdf.PDFObject | null>;
  /** gs operation id → /SMask of that dictionary (undefined if the key is absent). */
  gsSMask: Map<number, mupdf.PDFObject | undefined>;
  /** Color operation id → whether it is a pattern fill. */
  patternOps: Map<number, boolean>;
  /** glyphSeq → PageModel character, character → paragraph id (ActualText classification, built on first use). */
  charOfSeq: Map<number, number> | null;
  paraOfChar: Map<number, number> | null;
}

const BLOCKING: Partial<Record<EditLimitReason, string>> = {
  unmatched: 'PageModel 글자와 원본 연산을 연결하지 못함',
  'tokenizer-error': '콘텐츠 스트림 토큰 분리 실패',
  'spans-stream-boundary': '연산이 /Contents 스트림 경계에 걸침',
  'form-inherits-resources': 'Form 에 자체 /Resources 없음(쪽 리소스 상속)',
  'outside-page-content': '쪽 콘텐츠 밖(주석 외관·패턴·Type3 글리프 등)',
  'form-depth-exceeded': 'Form 재귀 깊이 초과·순환',
  'type3-font': 'Type3 폰트',
  'font-encoding-unresolved': '문자 코드 매핑 복원 곤란',
  'clip-text': '클립 텍스트(Tr 4–7)',
  'invisible-text': '보이지 않는 텍스트(Tr 3, 스캔 OCR 층 보호)',
  'inline-image': '인라인 이미지',
  'form-bbox-overflow': 'Form BBox 초과',
};

const ROTATION_TOLERANCE = (0.5 * Math.PI) / 180;

const ALIGNS: ReadonlySet<string> = new Set(['left', 'right', 'center', 'justify']);

/**
 * Takes out only the current fields of the format (reading and writing /PdfEditorFormat). `overflow` ('expand', 'shrink', 'keep') and
 * `fontScale` written by earlier builds are discarded: overflow is now automatic area expansion rather than a choice, and there is no text shrinking (2026-10-20 user decision).
 * null if the area is not four numbers or the first baseline position is not a number (the caller starts from the extracted text + block box).
 */
export function cleanParagraphFormat(raw: unknown): ParagraphFormat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const f = raw as Record<string, unknown>;
  const area = f.area;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!Array.isArray(area) || area.length !== 4 || !area.every(finite)) return null;
  if (!finite(f.firstBaselineOffset)) return null;
  const num = (v: unknown, fallback: number): number => (finite(v) ? v : fallback);
  const lineHeight = num(f.lineHeight, 0);
  return {
    area: [...area] as Rect,
    align:
      typeof f.align === 'string' && ALIGNS.has(f.align) ? (f.align as ParagraphAlign) : 'left',
    firstLineIndent: num(f.firstLineIndent, 0),
    // If 0 or less, reflow sets it to font size × 1.2 (contract 5.4).
    lineHeight: lineHeight > 0 ? lineHeight : 0,
    firstBaselineOffset: f.firstBaselineOffset,
  };
}

function readJson(obj: mupdf.PDFObject): BlockFormat | null {
  try {
    if (!obj.isString()) return null;
    const v = JSON.parse(obj.asString()) as BlockFormat;
    return v && v.v === 1 && Array.isArray(v.runs) ? v : null;
  } catch {
    return null;
  }
}

/** /PdfEditorFormat of an edit block. null if absent or unreadable. */
export function readBlockFormat(doc: mupdf.PDFDocument, objectNumber: number): BlockFormat | null {
  return readJson(doc.newIndirect(objectNumber).get('PdfEditorFormat'));
}

export function makeEnv(ctx: ParagraphEditContext, fonts: FontCache): AnalyzeEnv {
  const page = ctx.doc.loadPage(ctx.pageIndex);
  let links: Rect[];
  try {
    links = page.getLinks().map((l) => [...l.getBounds()] as Rect);
  } finally {
    page.destroy();
  }
  const redacts = listRedactAnnots(ctx.doc, [ctx.pageIndex]).annots.map((a) => a.rect);
  return {
    ctx,
    fonts,
    streams: new StreamCache(ctx.doc),
    blockNums: new Map(ctx.editBlocks.map((b) => [b.objectNumber, b])),
    links,
    redacts,
    formats: new Map(),
    fontRefs: new Map(),
    gsSMask: new Map(),
    patternOps: new Map(),
    charOfSeq: null,
    paraOfChar: null,
  };
}

class Limits {
  readonly list: ParagraphLimit[] = [];
  add(
    reason: ParagraphLimitReason | EditLimitReason,
    detail: string,
    chars: number[] = [],
    code?: ParagraphLimit['code'],
  ): void {
    const same = this.list.find((l) => l.reason === reason && l.code === code);
    if (same) {
      for (const c of chars) if (!same.chars.includes(c)) same.chars.push(c);
      return;
    }
    this.list.push({ reason, detail, chars: [...chars], ...(code ? { code } : {}) });
  }
}

const formKeys = new WeakMap<readonly FormStep[], string>();
function keyOf(path: readonly FormStep[]): string {
  let k = formKeys.get(path);
  if (k === undefined) {
    k = formKey(path);
    formKeys.set(path, k);
  }
  return k;
}

/** Whether the glyph is visible (received a number and is not Tr 3 or 7). */
const visibleGlyph = (op: SourceOp, g: number) =>
  op.text !== undefined &&
  op.text.glyphs[g]?.seq !== null &&
  op.text.renderMode !== 3 &&
  op.text.renderMode !== 7;

function opFont(env: AnalyzeEnv, op: SourceOp): mupdf.PDFObject | null {
  if (!op.text) return null;
  const key = `${keyOf(op.formPath)}|${op.text.fontResource}`;
  if (env.fontRefs.has(key)) return env.fontRefs.get(key)!;
  const chain = resourceChain(env.ctx.doc, env.ctx.pageIndex, op.formPath);
  const f = lookupResource(chain, 'Font', op.text.fontResource);
  const v = f && f.resolve().isDictionary() ? f : null;
  env.fontRefs.set(key, v);
  return v;
}

/** Analyzes an operation by spec widths (including font lookup). */
function analyzeOp(env: AnalyzeEnv, op: SourceOp): ShowAnalysis | SkipInfo {
  if (!op.text || op.kind !== 'text-show') {
    return { code: 'not-text-show', detail: '텍스트 표시 연산 아님' };
  }
  const font = opFont(env, op);
  if (!font)
    return { code: 'no-font-resource', detail: `폰트 리소스 없음: ${op.text.fontResource}` };
  return analyzeShow(op, env.streams.opBytes(op), env.fonts.load(font));
}

/** Edit block usage level (the level in a character operation's Form path that is an edit block). */
function blockStepOf(env: AnalyzeEnv, op: SourceOp): FormStep | null {
  for (const s of op.formPath) if (env.blockNums.has(s.objectNumber)) return s;
  return null;
}

/** Paragraph analysis. */
export function analyzeParagraph(env: AnalyzeEnv, paragraphId: number): EditAnalysis {
  const { ctx } = env;
  const paragraph = ctx.layout.paragraphs.find((p) => p.id === paragraphId);
  if (!paragraph) throw new Error(`문단 없음: ${paragraphId}`);
  const limits = new Limits();
  const warnings: EditWarning[] = [];

  // Shape label paragraphs are not blocked (2026-10-21 user report, main #6): shape detection often picks up background images, boxes and the whole page as shapes
  // (of 778 out-of-flow paragraphs on corpus pages 1 and 4, 221 were shape labels, with shapes covering 54–100% of the page area), and ordinary text was not editable.
  // For table cells, per M4 D1 all paragraphs of the cell are the target (main's "only table cells get not-flow-paragraph" rule is replaced by M4 cell editing).
  // A table paragraph whose cell is not found is treated like a flow paragraph. So not-flow-paragraph is not attached.
  let target = paragraph;
  let cell: CellTarget | null = null;
  if (paragraph.table !== null) {
    cell = cellTarget(ctx.model, ctx.layout, paragraphId);
    if (cell) target = cell.paragraph;
  }
  const withCell = (a: EditAnalysis): EditAnalysis => {
    a.cell = cell;
    // An edit block uses the limit from when it was created (block BBox) as is (after commit the cell box is recomputed from the new text).
    if (cell && !a.block) a.areaLimit = intersect(a.areaLimit, cell.limit);
    return a;
  };
  for (const li of target.lines) {
    const line = ctx.model.lines[li];
    if (!line) continue;
    const angle = Math.abs(Math.atan2(line.dir[1], line.dir[0]));
    if (line.wmode === 1 || angle > ROTATION_TOLERANCE) {
      limits.add('vertical-or-rotated', '세로쓰기·회전 줄', line.chars);
    }
  }

  // If it contains edit block characters, the target is the whole block (contract D3).
  for (const c of target.chars) {
    const opId = ctx.linkage.charOp[c] ?? -1;
    const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
    const step = op ? blockStepOf(env, op) : null;
    if (op && step) return withCell(analyzeBlock(env, target, step, limits, warnings));
  }

  return withCell(analyzeChars(env, target, target.chars, limits, warnings, cell?.members ?? null));
}

function analyzeChars(
  env: AnalyzeEnv,
  paragraph: LayoutParagraph,
  chars: number[],
  limits: Limits,
  warnings: EditWarning[],
  members: ReadonlySet<number> | null,
): EditAnalysis {
  const { ctx } = env;
  const ops = ctx.map.ops;
  const own = members ?? new Set([paragraph.id]);
  const base: EditAnalysis = {
    paragraph,
    chars,
    block: null,
    blockStep: null,
    blockFormat: null,
    limits: limits.list,
    warnings,
    removals: [],
    formPath: [],
    insertion: null,
    areaLimit: [...ctx.model.bounds] as Rect,
    actualTextClears: [],
    structParentsRemoved: false,
    cell: null,
  };

  // Operation linkage and operation limits.
  const byOp = new Map<number, number[]>();
  for (const c of chars) {
    const opId = ctx.linkage.charOp[c] ?? -1;
    if (opId < 0 || !ops[opId]?.text) {
      limits.add('unmatched', BLOCKING.unmatched!, [c]);
      continue;
    }
    const list = byOp.get(opId) ?? [];
    list.push(c);
    byOp.set(opId, list);
  }
  const touched = [...byOp.keys()].sort((a, b) => a - b).map((id) => ops[id]!);
  let optional = false;
  for (const op of touched) {
    const cs = byOp.get(op.id)!;
    for (const r of op.limits) {
      if (r === 'optional-content') optional = true;
      const detail = BLOCKING[r];
      if (detail) limits.add(r, detail, cs);
    }
  }
  if (optional) {
    warnings.push({
      kind: 'optional-content',
      message: '선택적 콘텐츠(/OC) 안의 문단입니다. 레이어 설정에 따라 보이지 않을 수 있습니다.',
      rects: [paragraph.bbox],
    });
  }
  if (touched.length === 0) return base;

  // Mixed sources: page content and a Form, or different Form usage paths.
  const keys = new Set(touched.map((o) => keyOf(o.formPath)));
  if (keys.size > 1) {
    limits.add(
      'mixed-content-sources',
      '문단 글자가 쪽 콘텐츠와 Form, 또는 서로 다른 Form 사용 경로에 걸침',
      chars,
    );
    return base;
  }
  const formPath = touched[0]!.formPath;
  base.formPath = formPath;

  // ActualText (D1): if a glyph to erase is inside an /ActualText MC, all glyphs of that MC are erased. MuPDF structured text
  // replaces characters with ActualText, so some glyphs of the MC belong to no paragraph (such glyphs are erased together).
  // If a glyph belongs to another paragraph, only part would be erased, so the edit is restricted.
  const targetSeqs = new Set(chars.map((c) => ctx.model.chars[c]!.glyphSeq));
  const atOps = new Set<number>();
  for (const op of touched) {
    for (const mc of op.markedContent ?? []) if (mc.actualText && mc.opId >= 0) atOps.add(mc.opId);
  }
  if (atOps.size > 0) {
    const charOfSeq = (env.charOfSeq ??= new Map(ctx.model.chars.map((c, i) => [c.glyphSeq, i])));
    let paraOf = env.paraOfChar;
    if (!paraOf) {
      paraOf = new Map<number, number>();
      for (const q of ctx.layout.paragraphs) for (const c of q.chars) paraOf.set(c, q.id);
      env.paraOfChar = paraOf;
    }
    const touchedIds = new Set(touched.map((o) => o.id));
    for (const bdc of atOps) {
      let partial = false;
      const extra: SourceOp[] = [];
      const extraSeqs: number[] = [];
      for (let id = bdc + 1; id < ops.length; id++) {
        const o = ops[id]!;
        if (!o.markedContent?.some((m) => m.opId === bdc)) break;
        if (!o.text) continue;
        let used = false;
        for (const g of o.text.glyphs) {
          if (g.seq === null || targetSeqs.has(g.seq)) continue;
          const c = charOfSeq.get(g.seq);
          const owner = c === undefined ? undefined : paraOf.get(c);
          if (owner !== undefined && !own.has(owner)) partial = true;
          else {
            extraSeqs.push(g.seq);
            used = true;
          }
        }
        if (used && !touchedIds.has(o.id)) extra.push(o);
      }
      if (partial) {
        limits.add(
          'actualtext-partial',
          '/ActualText 가 있는 marked content 의 글자 일부만 지움(남은 ActualText 가 옛 텍스트를 내보냄)',
          chars,
        );
        continue;
      }
      base.actualTextClears.push(bdc);
      for (const q of extraSeqs) targetSeqs.add(q);
      for (const o of extra) {
        if (keyOf(o.formPath) !== keyOf(formPath)) {
          limits.add('mixed-content-sources', 'ActualText 구간이 다른 콘텐츠 출처에 걸침', chars);
          return base;
        }
        touched.push(o);
        touchedIds.add(o.id);
        byOp.set(o.id, []);
      }
    }
    touched.sort((x, y) => x.id - y.id);
  }
  if (base.actualTextClears.length > 0) {
    warnings.push({
      kind: 'actualtext-cleared',
      message: `지운 문단의 /ActualText ${base.actualTextClears.length}개를 뺍니다.`,
      count: base.actualTextClears.length,
      rects: [paragraph.bbox],
    });
  }

  // Glyphs to erase and operation analysis (D2).
  const removals: OpRemoval[] = [];
  for (const op of touched) {
    const a = analyzeOp(env, op);
    if (isSkip(a)) {
      limits.add('remove-skipped', a.detail, byOp.get(op.id)!, a.code);
      continue;
    }
    const glyphs = op.text!.glyphs;
    const remove = glyphs.map((g) => g.seq !== null && targetSeqs.has(g.seq));
    const anyKept = glyphs.some((g, i) => g.seq !== null && !remove[i]);
    glyphs.forEach((g, i) => {
      if (g.seq === null) remove[i] = !anyKept;
    });
    removals.push({ op, remove, partial: remove.some((r) => !r), analysis: a });
  }
  base.removals = removals;
  if (removals.length !== touched.length) return base;

  // /StructParents of the Form copy (D1).
  for (const s of formPath) {
    const f = ctx.doc.newIndirect(s.objectNumber);
    if (!f.get('StructParents').isNull() || !f.get('StructParent').isNull()) {
      base.structParentsRemoved = true;
    }
  }

  // Insertion point (D3).
  const ins = findInsertion(env, base, limits);
  if (ins) {
    base.insertion = ins;
    checkInsertionState(env, base, ins, limits);
  }
  addPlacementWarnings(env, base);
  return base;
}

/** Insertion point classification (contract D3 rules 1–3). Adds a limit and returns null if it cannot be split. */
function findInsertion(env: AnalyzeEnv, a: EditAnalysis, limits: Limits): InsertionPoint | null {
  const ops = env.ctx.map.ops;
  const first = a.removals.find((r) => r.remove.some((x) => x));
  if (!first) return null;
  const ref = first.op;
  const refGlyph = first.remove.indexOf(true);
  const key = keyOf(ref.formPath);
  const same = (o: SourceOp) => keyOf(o.formPath) === key;
  let bt = -1;
  for (let id = ref.id - 1; id >= 0; id--) {
    const o = ops[id]!;
    if (!same(o)) continue;
    if (o.op === 'BT') {
      bt = id;
      break;
    }
    if (o.op === 'ET') break;
  }
  if (bt < 0) {
    limits.add('bt-split-unsupported', 'BT 밖 텍스트 표시 연산', a.chars);
    return null;
  }
  const btOp = ops[bt]!;
  let et = ops.length;
  for (let id = ref.id + 1; id < ops.length; id++) {
    const o = ops[id]!;
    if (same(o) && o.op === 'ET') {
      et = id;
      break;
    }
  }
  const btOps: SourceOp[] = [];
  for (let id = bt + 1; id < et; id++) if (same(ops[id]!)) btOps.push(ops[id]!);
  const removal = new Map(a.removals.map((r) => [r.op.id, r]));
  const keptVisible = (o: SourceOp, upTo = Infinity) => {
    if (!o.text) return false;
    const r = removal.get(o.id);
    const n = Math.min(upTo, o.text.glyphs.length);
    for (let g = 0; g < n; g++) if (!(r?.remove[g] ?? false) && visibleGlyph(o, g)) return true;
    return false;
  };
  const keptBefore = (endId: number) => btOps.some((o) => o.id < endId && keptVisible(o));

  const refMc = [...(ref.markedContent ?? [])].reverse().find((m) => m.mcid !== null) ?? null;
  const mcidKeptAt = (stateOp: SourceOp): boolean | null => {
    if (!refMc) return null;
    // An MCID opened inside a Form to be duplicated is cut off from the structure if /StructParents is removed.
    const mcOp = ops[refMc.opId];
    if (a.structParentsRemoved && mcOp && mcOp.formPath.length > 0) return false;
    return (stateOp.markedContent ?? []).some((m) => m.opId === refMc.opId);
  };
  const beforeBt = (): InsertionPoint => ({
    mode: 'before-bt',
    stream: btOp.stream,
    offset: btOp.range[0],
    splitOp: null,
    splitGlyph: null,
    resume: '',
    stateOp: btOp,
    ctm: btOp.ctm,
    mcidKept: mcidKeptAt(btOp),
    moved: false,
  });

  // Rule 1.
  if (!keptBefore(ref.id) && !keptVisible(ref, refGlyph)) return beforeBt();

  // Rule 3: if marked content opened inside the BT is still open, move before the outermost one and reapply rules 1 and 2.
  const openInside = (ref.markedContent ?? []).find(
    (m) => m.insideText && m.opId > bt && m.opId < ref.id && same(ops[m.opId]!),
  );
  let target: { op: SourceOp; glyph: number | null };
  let moved = false;
  if (openInside) {
    const bdc = ops[openInside.opId]!;
    moved = true;
    const between =
      btOps.some((o) => o.id > bdc.id && o.id < ref.id && keptVisible(o)) ||
      keptVisible(ref, refGlyph);
    if (between) a.warnings.push(readingOrderWarning(a));
    if (!keptBefore(bdc.id)) {
      const p = beforeBt();
      p.moved = true;
      return p;
    }
    target = { op: bdc, glyph: null };
  } else {
    const inside = first.remove.slice(0, refGlyph).some((r) => !r);
    target = { op: ref, glyph: inside ? refGlyph : null };
  }

  // Split restriction of rule 2.
  const unsupported = (detail: string) => {
    limits.add('bt-split-unsupported', detail, a.chars);
    return null;
  };
  const clipOp = btOps.find((o) => o.text && o.text.renderMode >= 4);
  if (clipOp) return unsupported(`클립 텍스트(Tr ${clipOp.text!.renderMode})가 있는 BT`);
  if (btOps.some((o) => o.op === 'q' || o.op === 'Q' || o.op === 'cm')) {
    return unsupported('BT 안 q/Q·cm(비표준)');
  }

  const sim = simulateLine(env, btOps, target, removal);
  if ('error' in sim) return unsupported(sim.error);
  return {
    mode: 'split-bt',
    stream: target.op.stream,
    offset: target.op.range[0],
    splitOp: target.glyph !== null ? target.op.id : null,
    splitGlyph: target.glyph,
    resume: sim.resume,
    stateOp: target.op,
    ctm: target.op.ctm,
    mcidKept: mcidKeptAt(target.op),
    moved,
  };
}

function readingOrderWarning(a: EditAnalysis): EditWarning {
  return {
    kind: 'reading-order-approximate',
    message:
      'BT 안 marked content 때문에 새 텍스트를 원래 자리보다 앞에 넣습니다. 복사·읽기 순서가 원래와 조금 다를 수 있습니다.',
    rects: [a.paragraph.bbox],
  };
}

/**
 * From the BT start to the split point, follows the text line matrix and displacement to build the `BT … [n] TJ` to continue after the edit block call
 * (contract D3 rule 2). Split point: just before target.op if target.glyph is null, otherwise before the target.glyph glyph of that operation.
 *
 * The line matrix (Tlm) is not written as a single computed value (`<Tlm> Tm`); the line-setting operations from the last Tm (or the BT) on are re-executed
 * with the original operands in the same order: Tm and Td as the original bytes, TD as `tx ty Td` (no TL side effect), and the line moves of T*, ' and " as
 * `0 -TL Td` (if TL is known) or `T*`. The same operations must run in the same order for even per-engine floating-point accumulation to match the original
 * (measured: pdf.js changes the antialiasing of later-line glyphs with `<Tlm> Tm`, and Poppler changes it with a single merged Td).
 * A reason if it cannot be computed.
 */
function simulateLine(
  env: AnalyzeEnv,
  btOps: readonly SourceOp[],
  target: { op: SourceOp; glyph: number | null },
  removal: Map<number, OpRemoval>,
): { resume: string } | { error: string } {
  let replay: string[] = [];
  let d = 0;
  let shows: SourceOp[] = [];
  let tl: number | null = null;
  let tfs: number | null = null;
  let th = 1;
  const opText = (o: SourceOp) => latin1String(env.streams.opBytes(o)).replace(/\s+/g, ' ').trim();
  const nums = (o: SourceOp) => {
    const p = parseContentOpsLenient(env.streams.opBytes(o)).ops[0];
    return p ? p.operands.filter((t) => t.kind === 'number').map((t) => t.value as number) : [];
  };
  const upto = btOps.filter((o) => o.id <= target.op.id);
  /** Whether there is an operation that changes TL after o and before the split point. */
  const tlChangesAfter = (o: SourceOp) =>
    upto.some((x) => x.id > o.id && x.id < target.op.id && (x.op === 'TL' || x.op === 'TD'));
  /** TL of the text-showing operation after o (when TL does not change in between). */
  const leadingAhead = (o: SourceOp): number | null => {
    for (const x of btOps) {
      if (x.id <= o.id) continue;
      if (x.op === 'TL' || x.op === 'TD') return null;
      if (x.text) return x.text.leading;
    }
    return null;
  };
  const nextLine = (o: SourceOp): string | null => {
    const known = tl ?? leadingAhead(o);
    if (known !== null) return `0 ${fmtExact(-known)} Td`;
    return tlChangesAfter(o) ? null : 'T*';
  };
  for (const o of upto) {
    const isTarget = o.id === target.op.id;
    if (isTarget && target.glyph === null) {
      if (o.text) {
        tfs = o.text.fontSize;
        th = o.text.horizontalScale;
      }
      break;
    }
    switch (o.op) {
      case 'Td':
        replay.push(opText(o));
        shows = [];
        break;
      case 'TD': {
        const [tx, ty] = nums(o);
        if (tx === undefined || ty === undefined) return { error: 'TD 피연산자 부족' };
        replay.push(`${opText(o).replace(/\s*TD$/, '')} Td`);
        tl = -ty;
        shows = [];
        break;
      }
      case 'Tm':
        if (nums(o).length < 6) return { error: 'Tm 피연산자 부족' };
        replay = [opText(o)];
        shows = [];
        break;
      case 'T*': {
        const line = nextLine(o);
        if (line === null) return { error: 'T* 의 TL 을 알 수 없음' };
        replay.push(line);
        shows = [];
        break;
      }
      case 'TL':
        tl = nums(o)[0] ?? 0;
        break;
      case 'Tf':
        tfs = nums(o)[0] ?? 0;
        break;
      case 'Tz':
        th = (nums(o)[0] ?? 100) / 100;
        break;
      default:
        if (o.kind !== 'text-show' || !o.text) break;
        tfs = o.text.fontSize;
        th = o.text.horizontalScale;
        if (o.op === "'" || o.op === '"') {
          tl = o.text.leading;
          const line = nextLine(o);
          if (line === null) return { error: "' 의 TL 을 알 수 없음" };
          replay.push(line);
          shows = [];
        }
        tl = o.text.leading;
        // Only the displacement of the show operations after the last line-setting operation is needed (computed at once below).
        shows.push(o);
    }
    if (isTarget) break;
  }
  for (const o of shows) {
    const r = removal.get(o.id);
    const an = r?.analysis ?? analyzeOp(env, o);
    if (isSkip(an)) return { error: `변위 계산 불가: ${an.detail}` };
    d += o.id === target.op.id ? displacementBefore(an, target.glyph!) : an.total;
  }
  let tj = '';
  if (Math.abs(d) > 1e-9) {
    if (!tfs || !th) return { error: 'Tfs·Th 가 0 이라 위치를 되돌릴 수 없음' };
    tj = ` [${fmtExact((-1000 * d) / (tfs * th))}] TJ`;
  }
  return { resume: ['BT', ...replay].join(' ') + tj };
}

/** Insertion-point graphics state classification (D3): singular CTM, clip, pattern fill, SMask. Also decides the area limit. */
function checkInsertionState(
  env: AnalyzeEnv,
  a: EditAnalysis,
  ins: InsertionPoint,
  limits: Limits,
): void {
  const { ctx } = env;
  if (Math.abs(determinant(ins.ctm)) < 1e-12 || !invert(ins.ctm)) {
    limits.add('singular-ctm', '삽입점 CTM 이 특이 행렬', a.chars);
  }
  const clip = ins.stateOp.state ? ins.stateOp.state.clipRect : ctx.model.bounds;
  if (clip === null) {
    limits.add(
      'insertion-clipped',
      '삽입점에 직사각형이 아닌 클립이 걸려 있음(원 문단을 덮는지 판정하지 않음)',
      a.chars,
    );
  } else {
    a.areaLimit = intersect(ctx.model.bounds, clip as Rect);
    // Even a rectangular clip clips the new text if it does not cover all original paragraph characters (characters drawn under another clip are mixed in).
    const r = a.areaLimit;
    const out = a.chars.filter((c) => {
      const o = ctx.model.chars[c]!.origin;
      return o[0] < r[0] - 1 || o[0] > r[2] + 1 || o[1] < r[1] - 1 || o[1] > r[3] + 1;
    });
    if (out.length > 0) {
      limits.add(
        'insertion-clipped',
        `삽입점의 직사각형 클립이 원 문단 글자 ${out.length}개를 덮지 않음(새 텍스트가 잘림)`,
        out,
      );
    }
  }
  // Classification only needs the effective SMask (read once per gs operation; the gs list accumulated to the end of the page is not merged each time).
  const smaskOf = (ids: readonly number[]): mupdf.PDFObject | undefined => {
    let v: mupdf.PDFObject | undefined;
    for (const id of ids) {
      if (!env.gsSMask.has(id)) {
        const d = extGStateOf(ctx, id, env.streams);
        const m = d?.get('SMask');
        env.gsSMask.set(id, m && !m.isNull() ? m : undefined);
      }
      const m = env.gsSMask.get(id);
      if (m !== undefined) v = m;
    }
    return v && !(v.isName() && v.asName() === 'None') ? v : undefined;
  };
  const isPattern = (id: number) => {
    let v = env.patternOps.get(id);
    if (v === undefined) {
      const cop = ctx.map.ops[id];
      const spec = cop ? readColorOp(ctx.doc, ctx.pageIndex, cop, env.streams.opBytes(cop)) : null;
      v = spec?.pattern !== null && spec?.pattern !== undefined;
      env.patternOps.set(id, v);
    }
    return v;
  };
  const insMask = smaskOf(ins.stateOp.state?.extGStateOps ?? []);
  for (const run of a.paragraph.styleRuns) {
    const sc = a.paragraph.chars[run.start];
    if (sc === undefined) continue;
    const opId = ctx.linkage.charOp[sc] ?? -1;
    const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
    if (!op) continue;
    for (const id of op.state?.fillColorOps ?? []) {
      if (isPattern(id)) {
        limits.add(
          'graphics-state-mismatch',
          '패턴 채움 글자(블록으로 옮기면 패턴 위치가 어긋남)',
          [sc],
        );
      }
    }
    if (!samePdfValue(smaskOf(op.state?.extGStateOps ?? []), insMask)) {
      limits.add('graphics-state-mismatch', '원 글자와 삽입점의 소프트 마스크(SMask)가 다름', [sc]);
    }
  }
}

function addPlacementWarnings(env: AnalyzeEnv, a: EditAnalysis): void {
  const box = a.paragraph.bbox;
  const ins = a.insertion;
  if (ins && ins.mcidKept === true) {
    a.warnings.push({
      kind: 'tagged-structure-kept',
      message: '새 텍스트가 원 문단의 marked content(MCID) 안에 들어가 구조 연결이 유지됩니다.',
      rects: [box],
    });
  } else if ((ins && ins.mcidKept === false) || a.structParentsRemoved) {
    a.warnings.push({
      kind: 'tagged-structure-unlinked',
      message:
        '태그 PDF 구조(읽기 순서·태그)와 새 텍스트가 연결되지 않습니다. 구조는 갱신하지 않습니다.',
      rects: [box],
    });
  }
  const links = env.links.filter((r) => overlaps(r, box));
  if (links.length > 0) {
    a.warnings.push({
      kind: 'link-overlap',
      message: `편집 문단과 겹치는 링크 ${links.length}개는 그대로 남습니다(영역을 다시 계산하지 않음).`,
      count: links.length,
      rects: links,
    });
  }
  const redacts = env.redacts.filter((r) => overlaps(r, box));
  if (redacts.length > 0) {
    a.warnings.push({
      kind: 'redact-overlap',
      message: `편집 문단이 적용되지 않은 Redact 표시 ${redacts.length}개와 겹칩니다. 나중에 적용하면 새 텍스트도 지워집니다.`,
      count: redacts.length,
      rects: redacts,
    });
  }
}

/** Edit block re-edit (rewrite-block): rewrites only the block stream without removing the original operations. */
function analyzeBlock(
  env: AnalyzeEnv,
  paragraph: LayoutParagraph,
  step: FormStep,
  limits: Limits,
  warnings: EditWarning[],
): EditAnalysis {
  const { ctx } = env;
  const block = env.blockNums.get(step.objectNumber)!;
  const chars: number[] = [];
  let state: SourceOp | null = null;
  ctx.model.chars.forEach((_c, i) => {
    const opId = ctx.linkage.charOp[i] ?? -1;
    const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
    if (op && op.formPath.some((s) => s.objectNumber === step.objectNumber)) {
      chars.push(i);
      state ??= op;
    }
  });
  let fmt = env.formats.get(step.objectNumber);
  if (fmt === undefined) {
    fmt = readBlockFormat(ctx.doc, step.objectNumber);
    env.formats.set(step.objectNumber, fmt);
  }
  const blockObj = ctx.doc.newIndirect(step.objectNumber);
  const bbox = blockObj.get('BBox');
  const matrix = blockObj.get('Matrix');
  const m: Matrix = matrix.isArray()
    ? ([0, 1, 2, 3, 4, 5].map((i) => matrix.get(i).asNumber()) as Matrix)
    : [1, 0, 0, 1, 0, 0];
  let areaLimit: Rect = [...ctx.model.bounds] as Rect;
  if (bbox.isArray()) {
    const r = [0, 1, 2, 3].map((i) => bbox.get(i).asNumber()) as Rect;
    const toPage = concatAll([m, step.ctm, ctx.map.userToPage]);
    areaLimit = intersect(areaLimit, transformRect(r, toPage));
  }
  const holderPath = state ? (state as SourceOp).formPath : [step];
  const idx = holderPath.findIndex((s) => s.objectNumber === step.objectNumber);
  const formPath = holderPath.slice(0, Math.max(0, idx));
  let bboxChars: Rect | null = null;
  for (const c of chars) {
    const q = ctx.model.chars[c]!.quad;
    bboxChars = union(bboxChars, [
      Math.min(q[0], q[4]),
      Math.min(q[1], q[3]),
      Math.max(q[2], q[6]),
      Math.max(q[5], q[7]),
    ]);
  }
  return {
    paragraph: { ...paragraph, bbox: bboxChars ?? paragraph.bbox },
    chars,
    block,
    blockStep: step,
    blockFormat: fmt,
    limits: limits.list,
    warnings,
    removals: [],
    formPath,
    insertion: null,
    areaLimit,
    actualTextClears: [],
    structParentsRemoved: false,
    cell: null,
  };
}

const concatAll = (list: Matrix[]): Matrix => list.reduce((acc, m) => concat(acc, m));

// ---------------------------------------------------------------- Start state (5.3)

export interface StartState {
  runs: TextRun[];
  charIndexOfOffset: number[];
  format: ParagraphFormat;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Normalizes the start-state text to NFC (the editor and reverse-mapping keys are NFC. So that original text whose ToUnicode is decomposed (NFD) does not lose
 * characters on a same-text commit). Normalizes per cluster, and every position of a normalized cluster points to the first original character
 * of the original cluster (-1 if none).
 */
export function normalizeStartState(state: StartState): StartState {
  const src = state.charIndexOfOffset;
  const map: number[] = [];
  let offset = 0;
  const runs = state.runs.map((run) => {
    let text = '';
    for (const g of graphemes.segment(run.text)) {
      const n = g.segment.normalize('NFC');
      let ci = -1;
      for (let j = 0; j < g.segment.length && ci < 0; j++) ci = src[offset + g.index + j] ?? -1;
      for (let j = 0; j < n.length; j++) map.push(ci);
      text += n;
    }
    offset += run.text.length;
    return { ...run, text };
  });
  return { ...state, runs, charIndexOfOffset: map };
}

/** Determinism: the value is logged and goes into block JSON, so significant digits are fixed. */
const round6 = (v: number): number => Number(v.toPrecision(6));

/**
 * Horizontal and vertical scale from character space to page space for an original character operation (Tm × CTM × userToPage). null if the operation is not found.
 */
function textScales(
  ctx: ParagraphEditContext,
  sourceChar: number,
): { sx: number; sy: number; tc: number; th: number } | null {
  const opId = ctx.linkage.charOp[sourceChar] ?? -1;
  const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
  const text = op?.text;
  if (!op || !text) return null;
  const m = concat(concat(text.tm, op.ctm), ctx.map.userToPage);
  const sx = Math.hypot(m[0], m[1]);
  // The vertical scale is the height perpendicular to the baseline (|det| / sx). Using the y-axis length would misread slanted text (Tm skew) as horizontal shrinking.
  const sy = Math.abs(m[0] * m[3] - m[1] * m[2]) / sx;
  if (!(sx > 1e-9) || !(sy > 1e-9) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  return { sx, sy, tc: text.charSpacing, th: text.horizontalScale };
}

/**
 * Letter spacing (Tc) of an original character operation in page-space pt (advance added per glyph). Tc is a character-space value not multiplied by size, so
 * it is multiplied by the horizontal scale (Tz) and the character-space → page-space horizontal scale. 0 if not found or 0.
 */
export function charSpacingOf(ctx: ParagraphEditContext, sourceChar: number): number {
  const t = textScales(ctx, sourceChar);
  if (!t || !t.tc) return 0;
  const value = round6(t.tc * t.th * t.sx);
  return Number.isFinite(value) && Math.abs(value) >= 1e-6 ? value : 0;
}

/**
 * Horizontal scale of an original character (character width ratio): Tz/100 × (character-space horizontal scale / vertical scale). Text narrowed horizontally only via Tm or CTM
 * (HWP-family PDFs) is expressed with the same value, not just Tz. 1 if within 0.1%.
 */
export function horizontalScaleOf(ctx: ParagraphEditContext, sourceChar: number): number {
  const t = textScales(ctx, sourceChar);
  if (!t || !Number.isFinite(t.th) || !(t.th > 0)) return 1;
  const value = round6(t.th * (t.sx / t.sy));
  return Math.abs(value - 1) < 1e-3 ? 1 : value;
}

/**
 * Index of the style span where a synthetic space (no original character, inserted by extraction into a wide gap) lies between two original characters on the same line. The space
 * that joins lines is not counted.
 */
function letterSpacedRuns(
  ctx: ParagraphEditContext,
  paragraph: LayoutParagraph,
  text: string,
  map: readonly number[],
  runIdx: readonly number[],
): Set<number> {
  const out = new Set<number>();
  const lineOf = new Map<number, number>();
  for (const li of paragraph.lines)
    for (const c of ctx.model.lines[li]?.chars ?? []) lineOf.set(c, li);
  let prevReal = -1;
  for (let o = 0; o < text.length; o++) {
    const ci = map[o] ?? -1;
    if (ci >= 0) {
      prevReal = ci;
      continue;
    }
    if (prevReal < 0 || !/\s/u.test(text[o]!)) continue;
    let next = -1;
    for (let k = o + 1; k < text.length && next < 0; k++) next = map[k] ?? -1;
    const line = lineOf.get(prevReal);
    if (next >= 0 && line !== undefined && lineOf.get(next) === line) out.add(runIdx[o]!);
  }
  return out;
}

export function originalStartState(
  ctx: ParagraphEditContext,
  paragraph: LayoutParagraph,
): StartState {
  const text = paragraph.text;
  const map = offsetMap(paragraph, ctx.model.chars);
  const posOf = new Map(paragraph.chars.map((c, i) => [c, i]));
  const runOfPos = (pos: number) =>
    paragraph.styleRuns.findIndex((r) => pos >= r.start && pos < r.end);
  const runIdx: number[] = [];
  let prev = 0;
  for (let o = 0; o < text.length; o++) {
    const ci = map[o]!;
    const r = ci >= 0 ? runOfPos(posOf.get(ci) ?? -1) : -1;
    const v = r >= 0 ? r : prev;
    runIdx.push(v);
    prev = v;
  }
  const runs: TextRun[] = [];
  const gapRuns = letterSpacedRuns(ctx, paragraph, text, map, runIdx);
  const styleOf = (ri: number): RunStyle => {
    const r = paragraph.styleRuns[ri];
    const sc = r ? (paragraph.chars[r.start] ?? paragraph.chars[0]!) : paragraph.chars[0]!;
    // Wide letter spacing (spaced-out text) already has its gap expressed by extraction inserting synthetic spaces between characters. Adding the letter spacing too would widen it twice.
    const raw = charSpacingOf(ctx, sc);
    const charSpacing = raw > 0 && gapRuns.has(ri) ? 0 : raw;
    const horizontalScale = horizontalScaleOf(ctx, sc);
    return {
      sourceChar: sc,
      fontId: r?.fontId ?? ctx.model.chars[sc]?.fontId ?? 0,
      size: r?.size ?? ctx.model.chars[sc]?.size ?? 10,
      bold: r?.bold ?? false,
      italic: r?.italic ?? false,
      color: r?.color ?? null,
      ...(charSpacing !== 0 ? { charSpacing } : {}),
      ...(horizontalScale !== 1 ? { horizontalScale } : {}),
    };
  };
  for (let o = 0; o < text.length; o++) {
    const ri = runIdx[o]!;
    const last = runs.at(-1);
    if (last && (last as TextRun & { ri?: number }).ri === ri) last.text += text[o];
    else {
      const run = { text: text[o]!, style: styleOf(ri) } as TextRun & { ri?: number };
      run.ri = ri;
      runs.push(run);
    }
  }
  const cleanRuns = runs.map(({ text: t, style }) => ({ text: t, style }));
  if (cleanRuns.length === 0) cleanRuns.push({ text: '', style: styleOf(0) });
  const firstLine = ctx.model.lines[paragraph.lines[0] ?? -1];
  const firstChar = firstLine?.chars
    .map((c) => ctx.model.chars[c]!)
    .find((c) => c.text.trim() !== '');
  const baseline = firstChar?.origin[1] ?? paragraph.bbox[3];
  const size = cleanRuns[0]!.style.size;
  return {
    runs: cleanRuns,
    charIndexOfOffset: map,
    format: {
      area: [...paragraph.bbox] as Rect,
      align: paragraph.align === 'unknown' ? 'left' : paragraph.align,
      firstLineIndent: paragraph.firstLineIndent,
      lineHeight: paragraph.lineHeight ?? size * 1.2,
      firstBaselineOffset: baseline - paragraph.bbox[1],
    },
  };
}

/** Start state of an edit block (5.3): /PdfEditorFormat, or extracted text + block box if it differs from the extracted text. */
export function blockStartState(ctx: ParagraphEditContext, a: EditAnalysis): StartState {
  const fmt = a.blockFormat;
  const chars = a.chars;
  const extracted = chars.map((c) => ctx.model.chars[c]!.text).join('');
  // Written text is NFC and extracted text is left as ToUnicode gave it (possibly NFD), so compare in NFC.
  const strip = (s: string) => s.replace(/\s+/gu, '').normalize('NFC');
  const first = chars[0] ?? 0;
  const ch0 = ctx.model.chars[first];
  const plainStyle = {
    sourceChar: first,
    fontId: ch0?.fontId ?? 0,
    size: ch0?.size ?? 10,
    bold: ctx.model.fonts[ch0?.fontId ?? -1]?.bold ?? false,
    italic: ctx.model.fonts[ch0?.fontId ?? -1]?.italic ?? false,
    color: ch0?.color ?? null,
  };
  const box = a.paragraph.bbox;
  const fromExtract = (): StartState => {
    const text = chars.map((c) => ctx.model.chars[c]!.text).join('');
    const map: number[] = [];
    for (const c of chars) for (let j = 0; j < ctx.model.chars[c]!.text.length; j++) map.push(c);
    const size = plainStyle.size;
    return {
      runs: [{ text, style: plainStyle }],
      charIndexOfOffset: map,
      format: {
        area: [...box] as Rect,
        align: 'left',
        firstLineIndent: 0,
        lineHeight: size * 1.2,
        firstBaselineOffset: (ch0?.origin[1] ?? box[3]) - box[1],
      },
    };
  };
  const format = fmt ? cleanParagraphFormat(fmt.format) : null;
  if (!fmt || !format) return fromExtract();
  const text = fmt.runs.map((r) => r.text).join('');
  if (strip(text) !== strip(extracted) || fmt.glyphOffsets.length !== chars.length) {
    return fromExtract();
  }
  const map = new Array<number>(text.length).fill(-1);
  fmt.glyphOffsets.forEach((o, k) => {
    if (o >= 0 && o < map.length && map[o] === -1) map[o] = chars[k]!;
  });
  // Also fill the remaining UTF-16 positions of the cluster with the same character.
  for (let o = 1; o < map.length; o++) {
    if (map[o] === -1 && map[o - 1]! >= 0 && /[\uDC00-\uDFFF]|\p{M}/u.test(text[o]!)) {
      map[o] = map[o - 1]!;
    }
  }
  let offset = 0;
  let prevSc = first;
  const runs: TextRun[] = fmt.runs.map((r) => {
    let sc = -1;
    for (let o = offset; o < offset + r.text.length; o++) {
      if (map[o]! >= 0) {
        sc = map[o]!;
        break;
      }
    }
    if (sc < 0) sc = prevSc;
    prevSc = sc;
    offset += r.text.length;
    return {
      text: r.text,
      style: {
        sourceChar: sc,
        fontId: ctx.model.chars[sc]?.fontId ?? plainStyle.fontId,
        size: r.size,
        bold: r.bold,
        italic: r.italic,
        color: r.color,
        ...(typeof r.charSpacing === 'number' &&
        Number.isFinite(r.charSpacing) &&
        r.charSpacing !== 0
          ? { charSpacing: r.charSpacing }
          : {}),
        ...(typeof r.horizontalScale === 'number' &&
        Number.isFinite(r.horizontalScale) &&
        r.horizontalScale > 0 &&
        r.horizontalScale !== 1
          ? { horizontalScale: r.horizontalScale }
          : {}),
      },
    };
  });
  return { runs, charIndexOfOffset: map, format };
}
