/**
 * Vector path editing (M4, docs/m4-contract.md 4.2, 4.3, D2, D3, D4).
 *
 * The edit unit is one painting operation (`S s f F f* B B* b b*`). The construction operations (`m l c v y re h`) are found through
 * `SourceOp.pathOps`, which the interpreter fills. Writing is a single replacement list per stream based on the original bytes (same as M3 D2).
 *
 * - Geometry: rewrites the numeric operands of construction operations as content-space coordinates (no `cm` is layered on). `re` stays `re` if the result is an axis-aligned
 *   rectangle, otherwise `m l l l h`.
 * - Attributes: `q` + color and `w` before the first construction operation, `Q` after the painting operation. Nothing is inserted between construction and painting.
 * - Delete: replaces the construction operations through the painting operation with a single space (review L1: no unpaired `n` is left, so it is clean even for a strict preflight).
 *   Since the painting operation disappears, the paintSeq of later painting operations shifts down by one (contract path-deletion item). Target confirmation is the fingerprint's job (D4), and the fingerprint is
 *   recomputed from the changed stream, so the post-delete classification (planPathEdit) uses the new order. Reapply follows the same rule in log order.
 * - A path inside a Form duplicates the usage path (including the parent chain) and changes only this usage location. Several paths on the same chain share
 *   one copy. A shared /Contents is copied.
 *
 * Point numbers (PathEdit.points) follow the order of PageModel PathInfo.segments. Correspondence with construction operations: `m` and `l` 1 point, `c` 3,
 * `v` 3 (the first point is the current point, no operand), `y` 3 (third = second operand), `re` 4 (MuPDF fz_rectto order:
 * (x,y), (x+w,y), (x+w,y+h), (x,y+h) + close), `h` 0. If the model has segments, this correspondence is checked against the segments.
 */
import type * as mupdf from 'mupdf';
import type {
  ContentStreamRef,
  EditLimitReason,
  EditWarning,
  FormStep,
  Matrix,
  PaintColor,
  PathEdit,
  PathEditPlan,
  PathEditability,
  PathFingerprint,
  PathLimit,
  PathLimitReason,
  PathSegment,
  PathTarget,
  Point,
  RGB,
  Rect,
  SourceMap,
  SourceOp,
} from '@pdf-editor/shared-types';
import { now } from './clock.js';
import { parseContentOpsLenient } from './content-stream.js';
import {
  apply,
  concat,
  determinant,
  fmt9,
  formKey,
  invert,
  latin1String,
  StreamCache,
  union,
} from './edit-common.js';
import { extGStateOf, readColorOp } from './edit-style.js';
import { ownResources, ownSubdict, putUniqueResource } from './page-content.js';
import type { ParagraphEditContext } from './paragraph-edit.js';
import {
  applyReplacements,
  contentsSlotNumber,
  contentsUseCount,
  replaceContentsSlot,
  type Replacement,
} from './text-remove.js';
import { writeStreamBytes } from './mupdf-util.js';

/** Preparation result holding the list of object numbers a path edit changes. */
export interface PreparedPathEdit {
  editId: string;
  target: PathTarget;
  /** Stream object numbers this edit changes. */
  changedObjects: number[];
}

// ---------------------------------------------------------------- Classification (4.2)

const PAINT_TARGETS: ReadonlySet<string> = new Set([
  'S',
  's',
  'f',
  'F',
  'f*',
  'B',
  'B*',
  'b',
  'b*',
]);
const FILLS: ReadonlySet<string> = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const STROKES: ReadonlySet<string> = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const CONSTRUCT_ARITY: Readonly<Record<string, number>> = {
  m: 2,
  l: 2,
  c: 6,
  v: 4,
  y: 4,
  re: 4,
  h: 0,
};

const OP_BLOCKING: Partial<Record<EditLimitReason, string>> = {
  unmatched: 'PageModel 패스와 원본 연산을 연결하지 못함',
  'tokenizer-error': '콘텐츠 스트림 토큰 분리 실패',
  'spans-stream-boundary': '연산이 /Contents 스트림 경계에 걸침',
  'outside-page-content': '쪽 콘텐츠 밖(주석 외관·패턴·Type3 글리프 등)',
  'form-depth-exceeded': 'Form 재귀 깊이 초과·순환',
};

const PATH_DETAIL: Record<PathLimitReason, string> = {
  'clip-path': '클립 경로(W·W*)를 겸하는 칠하기',
  'pattern-or-shading': '패턴·셰이딩으로 칠한 패스',
  'path-op-unparsed': '구성 연산을 찾지 못했거나 피연산자가 숫자가 아님',
  'path-spans-streams': '구성 ~ 칠하기 연산이 /Contents 스트림 경계에 걸침',
  'inside-text-object': 'BT 안의 패스(비표준)',
  'path-interleaved-ops': '구성 ~ 칠하기 사이에 다른 연산이 있음(명세 8.2 위반)',
  'soft-mask': '칠하기 시점 ExtGState 에 소프트 마스크(SMask)',
  'singular-ctm': '칠하기 시점 CTM 이 특이 행렬',
};

/** One construction operation. nums is read at preparation (preparePathEdit) (classification checks only the grammar, page classification time 4.2). */
interface Construct {
  op: SourceOp;
  nums: number[];
}

/** Classification of one painting operation. */
interface PathItem {
  op: SourceOp;
  /** Construction operations (execution order). */
  constructs: SourceOp[];
  /** PageModel.paths indices (all linked to this operation). */
  infos: number[];
  /** Representative PathInfo (first fill/stroke, otherwise the first entry). */
  pathIndex: number;
  paintSeq: number;
  bbox: Rect;
  limits: PathLimit[];
  optional: boolean;
}

interface PageAnalysis {
  items: PathItem[];
  bySeq: Map<number, PathItem>;
}

const analyses = new WeakMap<SourceMap, PageAnalysis>();

function addLimit(list: PathLimit[], reason: PathLimitReason | EditLimitReason, detail?: string) {
  if (list.some((l) => l.reason === reason)) return;
  list.push({
    reason,
    detail:
      detail ??
      PATH_DETAIL[reason as PathLimitReason] ??
      OP_BLOCKING[reason as EditLimitReason] ??
      reason,
  });
}

/**
 * PDF number token ([+-]? digits [. digits], or [+-]? . digits). NaN otherwise. Integers directly, decimals via Number (decimal notation).
 * If values is false, only checks the grammar and returns 0.
 */
function readNumber(b: Uint8Array, s: number, e: number, values: boolean): number {
  let i = s;
  if (b[i] === 0x2b || b[i] === 0x2d) i++;
  let v = 0;
  let digits = 0;
  while (i < e && b[i]! >= 0x30 && b[i]! <= 0x39) {
    v = v * 10 + (b[i++]! - 0x30);
    digits++;
  }
  if (i < e && b[i] === 0x2e) {
    i++;
    while (i < e && b[i]! >= 0x30 && b[i]! <= 0x39) {
      i++;
      digits++;
    }
    if (digits === 0 || i !== e) return NaN;
    return values ? Number(String.fromCharCode(...b.subarray(s, e))) : 0;
  }
  if (digits === 0 || i !== e) return NaN;
  return b[s] === 0x2d ? -v : v;
}

const isSpace = (c: number) =>
  c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/**
 * Numeric operands of a construction operation. Read directly from operandRanges (number and name tokens) filled by the interpreter: token count = operand count,
 * the first token is the operation start, only whitespace between tokens and between the last token and the operator, all numbers. Tokenizes if operandRanges is absent.
 */
function parseConstruct(op: SourceOp, stream: Uint8Array, values = true): number[] | null {
  const arity = CONSTRUCT_ARITY[op.op];
  if (arity === undefined) return null;
  const ranges = op.operandRanges;
  if (!ranges) {
    const p = parseContentOpsLenient(stream.subarray(op.range[0], op.range[1]));
    const parsed = p.ops[0];
    if (p.error || !parsed || parsed.op !== op.op) return null;
    if (parsed.operands.length !== arity) return null;
    if (!parsed.operands.every((t) => t.kind === 'number')) return null;
    return parsed.operands.map((t) => t.value as number);
  }
  if (ranges.length !== arity) return null;
  const out: number[] = [];
  let pos = op.range[0];
  for (const [s, e] of ranges) {
    for (let i = pos; i < s; i++) if (!isSpace(stream[i]!)) return null;
    const v = readNumber(stream, s, e, values);
    if (Number.isNaN(v)) return null;
    out.push(v);
    pos = e;
  }
  const end = op.range[1] - op.op.length;
  for (let i = pos; i < end; i++) if (!isSpace(stream[i]!)) return null;
  return out;
}

const sameStream = (a: ContentStreamRef, b: ContentStreamRef) =>
  a.objectNumber === b.objectNumber && a.contentsIndex === b.contentsIndex;

/** Classification of the page's painting operations (once per SourceMap). */
function analyzePage(ctx: ParagraphEditContext): PageAnalysis {
  const cached = analyses.get(ctx.map);
  if (cached) return cached;
  const ops = ctx.map.ops;
  const streams = new StreamCache(ctx.doc);
  // Painting operation → linked PathInfo (PageModel.paths is in paintSeq order, so they gather per operation).
  const infosOf = new Map<number, number[]>();
  const pathOp = ctx.linkage.pathOp;
  for (let i = 0; i < pathOp.length; i++) {
    const opId = pathOp[i]!;
    if (opId < 0) continue;
    const l = infosOf.get(opId);
    if (l) l.push(i);
    else infosOf.set(opId, [i]);
  }
  // Whether inside BT. Operations of the same content execution share the formPath array, so the array itself is used as the key.
  const inText = new Uint8Array(ops.length);
  const textState = new Map<readonly FormStep[], boolean>();
  for (const o of ops) {
    if (o.op === 'BT') textState.set(o.formPath, true);
    else if (o.op === 'ET') textState.set(o.formPath, false);
    else if (o.kind === 'path-paint' && textState.get(o.formPath) === true) inText[o.id] = 1;
  }
  // Effective SMask: the later gs wins. The extGStateOps array is one per execution point, so the result is remembered by the last gs id
  // (so that a page with many gs does not rescan the whole array for every painting operation).
  const smaskKey = new Map<number, boolean | undefined>();
  const smaskAt = new Map<number, boolean>();
  const keyValue = (id: number) => {
    if (!smaskKey.has(id)) {
      const m = extGStateOf(ctx, id, streams)?.get('SMask');
      smaskKey.set(
        id,
        m === undefined || m.isNull() ? undefined : !(m.isName() && m.asName() === 'None'),
      );
    }
    return smaskKey.get(id);
  };
  const hasSMask = (ids: readonly number[]) => {
    if (ids.length === 0) return false;
    let i = ids.length - 1;
    const pending: number[] = [];
    let v = false;
    for (; i >= 0; i--) {
      const id = ids[i]!;
      const known = smaskAt.get(id);
      if (known !== undefined) {
        v = known;
        break;
      }
      const k = keyValue(id);
      if (k !== undefined) {
        v = k;
        smaskAt.set(id, k);
        break;
      }
      pending.push(id);
    }
    for (const id of pending) smaskAt.set(id, v);
    return v;
  };
  const patternOp = new Map<number, boolean>();
  const isPattern = (id: number) => {
    let v = patternOp.get(id);
    if (v === undefined) {
      const cop = ops[id];
      const spec = cop ? readColorOp(ctx.doc, ctx.pageIndex, cop, streams.opBytes(cop)) : null;
      v = spec !== null && spec.pattern !== null;
      patternOp.set(id, v);
    }
    return v;
  };

  const items: PathItem[] = [];
  const bySeq = new Map<number, PathItem>();
  let lastNum = -1;
  let lastBytes: Uint8Array = new Uint8Array(0);
  const paths = ctx.model.paths;
  // Only painting operations with a linked PathInfo (operation id order = paintSeq order).
  for (const [opId, infos] of infosOf) {
    const op = ops[opId]!;
    if (op.kind !== 'path-paint' || !PAINT_TARGETS.has(op.op) || !op.paintSeq?.length) continue;
    let painted = 0;
    let firstPainted = -1;
    let clipInfo = false;
    let bbox: Rect | null = null;
    for (const i of infos) {
      const kind = paths[i]!.op;
      if (kind === 'fill' || kind === 'stroke') {
        if (firstPainted < 0) firstPainted = i;
        painted++;
        const b = paths[i]!.bbox;
        bbox = bbox
          ? [
              Math.min(bbox[0], b[0]),
              Math.min(bbox[1], b[1]),
              Math.max(bbox[2], b[2]),
              Math.max(bbox[3], b[3]),
            ]
          : [b[0], b[1], b[2], b[3]];
      } else clipInfo = true;
    }
    if (!bbox) for (const i of infos) bbox = union(bbox, paths[i]!.bbox);
    const limits: PathLimit[] = [];
    let optional = false;

    const constructs: SourceOp[] = [];
    let spans = false;
    for (const id of op.pathOps ?? []) {
      const c = ops[id];
      if (!c) continue;
      if (c.stream.objectNumber !== lastNum) {
        lastNum = c.stream.objectNumber;
        lastBytes = streams.get(lastNum);
      }
      if (!parseConstruct(c, lastBytes, false)) addLimit(limits, 'path-op-unparsed');
      if (!spans && !sameStream(c.stream, op.stream)) spans = true;
      constructs.push(c);
      if (c.limits.length > 0) {
        for (const r of c.limits) {
          if (r === 'optional-content') optional = true;
          else if (OP_BLOCKING[r]) addLimit(limits, r);
        }
      }
    }
    if (constructs.length === 0) addLimit(limits, 'path-op-unparsed');
    if (spans) addLimit(limits, 'path-spans-streams');
    const first = constructs[0]?.id ?? op.id;
    for (let id = first + 1; id < op.id; id++) {
      const o = ops[id]!;
      if (o.kind === 'path-construct') continue;
      if (o.op === 'W' || o.op === 'W*') addLimit(limits, 'clip-path');
      else
        addLimit(limits, 'path-interleaved-ops', `${PATH_DETAIL['path-interleaved-ops']}: ${o.op}`);
    }
    const fills = FILLS.has(op.op);
    const strokes = STROKES.has(op.op);
    const state = op.state;
    let patterned = painted !== (fills ? 1 : 0) + (strokes ? 1 : 0);
    if (!patterned && fills && state)
      for (const id of state.fillColorOps) patterned ||= isPattern(id);
    if (!patterned && strokes && state?.strokeColorOps) {
      for (const id of state.strokeColorOps) patterned ||= isPattern(id);
    }
    if (patterned) addLimit(limits, 'pattern-or-shading');
    // MuPDF also sends pattern painting as clip + content, so a clip PathInfo is a clip reason only when it is not a pattern.
    else if (clipInfo) addLimit(limits, 'clip-path');
    if (inText[op.id]) addLimit(limits, 'inside-text-object');
    if (state && hasSMask(state.extGStateOps)) addLimit(limits, 'soft-mask');
    for (const r of op.limits) {
      if (r === 'optional-content') optional = true;
      else if (OP_BLOCKING[r]) addLimit(limits, r);
    }
    const det = determinant(op.ctm);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) addLimit(limits, 'singular-ctm');

    const item: PathItem = {
      op,
      constructs,
      infos,
      pathIndex: firstPainted >= 0 ? firstPainted : infos[0]!,
      paintSeq: op.paintSeq[0]!,
      bbox: bbox!,
      limits,
      optional,
    };
    items.push(item);
    for (const sq of op.paintSeq) bySeq.set(sq, item);
  }
  const result = { items, bySeq };
  analyses.set(ctx.map, result);
  return result;
}

/** 53-bit hash (cyrb53) in hex. */
function hashBytes(parts: readonly Uint8Array[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (b: number) => {
    h1 = Math.imul(h1 ^ b, 2654435761);
    h2 = Math.imul(h2 ^ b, 1597334677);
  };
  for (const p of parts) {
    for (const b of p) feed(b);
    feed(0x0a);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function fingerprintOf(item: PathItem, streams: StreamCache): PathFingerprint {
  return {
    paintOp: item.op.op,
    constructOpCount: item.constructs.length,
    bbox: item.bbox.map(round3) as Rect,
    constructHash: hashBytes(item.constructs.map((c) => streams.opBytes(c))),
  };
}

/** Fingerprint comparison (boxes tolerate rounding-boundary jitter up to 2e-3). */
export function sameFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return (
    a.paintOp === b.paintOp &&
    a.constructOpCount === b.constructOpCount &&
    a.constructHash === b.constructHash &&
    a.bbox.every((v, i) => Math.abs(v - b.bbox[i]!) <= 2e-3)
  );
}

/** Classification of all paths of the page (PageModel.paths order). */
export function planPathEditability(ctx: ParagraphEditContext): PathEditability[] {
  return analyzePage(ctx)
    .items.map((it) => ({
      pathIndex: it.pathIndex,
      paintSeq: it.paintSeq,
      bbox: [...it.bbox] as Rect,
      editable: it.limits.length === 0,
      reasons: it.limits.map((l) => l.reason),
    }))
    .sort((a, b) => a.pathIndex - b.pathIndex);
}

/** Classification entries that the paintSeqs point to (duplicates removed, input order). Throws for a number that does not exist. */
function itemsFor(ctx: ParagraphEditContext, paintSeqs: readonly number[]): PathItem[] {
  const a = analyzePage(ctx);
  const out: PathItem[] = [];
  for (const s of paintSeqs) {
    const it = a.bySeq.get(s);
    if (!it) throw new Error(`편집 대상 패스 없음: paintSeq ${s}`);
    if (!out.includes(it)) out.push(it);
  }
  if (out.length === 0) throw new Error('편집 대상 패스 없음');
  return out;
}

/** Number of times this page uses a Form object number as Do. */
function formUses(ctx: ParagraphEditContext, num: number): number {
  let n = 0;
  const seen = new Set<string>();
  for (const o of ctx.map.ops) {
    const s = o.formPath.find((x) => x.objectNumber === num);
    if (!s) continue;
    const k = formKey(o.formPath.slice(0, o.formPath.indexOf(s) + 1));
    if (!seen.has(k)) {
      seen.add(k);
      n++;
    }
  }
  return n;
}

function planWarnings(ctx: ParagraphEditContext, items: readonly PathItem[]): EditWarning[] {
  const warnings: EditWarning[] = [];
  const rects = (f: (it: PathItem) => boolean) => items.filter(f).map((it) => [...it.bbox] as Rect);
  const opt = rects((it) => it.optional);
  if (opt.length > 0) {
    warnings.push({
      kind: 'optional-content',
      message: '선택적 콘텐츠(/OC) 안의 패스입니다. 레이어 설정에 따라 보이지 않을 수 있습니다.',
      rects: opt,
    });
  }
  const shared = rects((it) =>
    it.op.formPath.some((s) => formUses(ctx, s.objectNumber) > 1 || pageUses(ctx, s) > 1),
  );
  if (shared.length > 0) {
    warnings.push({
      kind: 'shared-form',
      message: '여러 곳에서 쓰는 Form 안의 패스입니다. 이 사용 위치만 바뀝니다.',
      rects: shared,
    });
  }
  const tagged = rects((it) =>
    it.op.formPath.some((s) => {
      const f = ctx.doc.newIndirect(s.objectNumber);
      try {
        return !f.get('StructParents').isNull() || !f.get('StructParent').isNull();
      } finally {
        f.destroy();
      }
    }),
  );
  if (tagged.length > 0) {
    warnings.push({
      kind: 'tagged-structure-unlinked',
      message:
        'Form 을 복제하면서 /StructParents 를 지웁니다. 태그 PDF 구조와 이 위치의 연결이 끊깁니다.',
      variant: 'form-clone',
      rects: tagged,
    });
  }
  return warnings;
}

/** The name if the step's Do operand is a copy name made by a previous edit (/PEFn), otherwise null. */
function clonedName(streams: StreamCache, step: FormStep): string | null {
  const bytes = streams.get(step.stream.objectNumber);
  const text = latin1String(bytes.subarray(step.nameRange[0], step.nameRange[1]));
  const m = /^\/(PEF\d+)$/.exec(text);
  return m ? m[1]! : null;
}

/**
 * Number of pages whose Resources /XObject point to the same Form (+ this page).
 * The cache is tied to the classification context (ctx). ctx is created anew on every call (= every revision), so a stale value from before the document changed
 * does not remain (M4 review L5).
 */
const pageUseCache = new WeakMap<ParagraphEditContext, Map<number, number>>();
function pageUses(ctx: ParagraphEditContext, step: FormStep): number {
  let m = pageUseCache.get(ctx);
  if (!m) {
    m = new Map();
    pageUseCache.set(ctx, m);
  }
  const hit = m.get(step.objectNumber);
  if (hit !== undefined) return hit;
  let n = 0;
  const pages = ctx.doc.countPages();
  for (let i = 0; i < pages; i++) {
    const page = ctx.doc.findPage(i);
    const res = page.getInheritable('Resources');
    const dict = res.isNull() ? res : res.get('XObject');
    let used = false;
    if (!dict.isNull() && dict.isDictionary()) {
      dict.forEach((v) => {
        if (v.isIndirect() && v.asIndirect() === step.objectNumber) used = true;
      });
    }
    // The wrapper is released as soon as it is used (so they do not pile up per page count).
    if (dict !== res) dict.destroy();
    res.destroy();
    page.destroy();
    if (used) n++;
  }
  m.set(step.objectNumber, n);
  return n;
}

function paintColorOf(ctx: ParagraphEditContext, it: PathItem, op: 'fill' | 'stroke') {
  const i = it.infos.find((k) => ctx.model.paths[k]!.op === op);
  return i === undefined ? null : ctx.model.paths[i]!;
}

/** Path-space line width → page-space pt (√|det|, MuPDF fz_matrix_expansion). */
const expansion = (m: Matrix) => Math.sqrt(Math.abs(determinant(m)));

/** Edit plan of the selected path. revision is filled in by the caller. */
export function planPathEdit(
  ctx: ParagraphEditContext,
  paintSeqs: number[],
): Omit<PathEditPlan, 'revision'> {
  const t0 = now();
  const items = itemsFor(ctx, paintSeqs);
  const streams = new StreamCache(ctx.doc);
  const limits: PathLimit[] = [];
  for (const it of items) for (const l of it.limits) addLimit(limits, l.reason, l.detail);
  let bbox: Rect | null = null;
  for (const it of items) bbox = union(bbox, it.bbox);
  const first = items[0]!;
  const fillInfo = paintColorOf(ctx, first, 'fill');
  const strokeInfo = paintColorOf(ctx, first, 'stroke');
  const color = (c: PaintColor | null | undefined): PaintColor | null =>
    c ? { space: c.space, values: [...c.values], rgb: c.rgb ? [...c.rgb] : null } : null;
  return {
    pageIndex: ctx.pageIndex,
    target: {
      pageIndex: ctx.pageIndex,
      paintSeqs: items.map((it) => it.paintSeq),
      fingerprints: items.map((it) => fingerprintOf(it, streams)),
      bbox: bbox!,
    },
    editable: limits.length === 0,
    limits,
    warnings: planWarnings(ctx, items),
    fill: color(fillInfo?.color),
    stroke: color(strokeInfo?.color),
    lineWidth:
      strokeInfo && strokeInfo.lineWidth !== null
        ? strokeInfo.lineWidth * expansion(strokeInfo.ctm)
        : null,
    planMs: now() - t0,
  };
}

// ---------------------------------------------------------------- Point correspondence table (D4)

/** Origin of a point: construction operation number and point number within it. implicit = the first point of v (current point). */
export interface PointSlot {
  construct: number;
  k: number;
}

/** Construction operation → point list (content space) and MuPDF segments (for cross-checking). */
export function constructPoints(constructs: readonly { op: string; nums: readonly number[] }[]): {
  points: Point[];
  slots: PointSlot[];
  segments: PathSegment[];
} {
  const points: Point[] = [];
  const slots: PointSlot[] = [];
  const segments: PathSegment[] = [];
  let cur: Point = [0, 0];
  let move: Point = [0, 0];
  constructs.forEach((c, ci) => {
    const n = c.nums;
    const push = (p: Point, k: number) => {
      points.push(p);
      slots.push({ construct: ci, k });
    };
    switch (c.op) {
      case 'm':
        move = cur = [n[0]!, n[1]!];
        push(cur, 0);
        segments.push({ type: 'M', p: cur });
        break;
      case 'l':
        cur = [n[0]!, n[1]!];
        push(cur, 0);
        segments.push({ type: 'L', p: cur });
        break;
      case 'c': {
        const p1: Point = [n[0]!, n[1]!];
        const p2: Point = [n[2]!, n[3]!];
        cur = [n[4]!, n[5]!];
        push(p1, 0);
        push(p2, 1);
        push(cur, 2);
        segments.push({ type: 'C', p1, p2, p3: cur });
        break;
      }
      case 'v': {
        const p1: Point = [...cur];
        const p2: Point = [n[0]!, n[1]!];
        cur = [n[2]!, n[3]!];
        push(p1, 0);
        push(p2, 1);
        push(cur, 2);
        segments.push({ type: 'C', p1, p2, p3: cur });
        break;
      }
      case 'y': {
        const p1: Point = [n[0]!, n[1]!];
        cur = [n[2]!, n[3]!];
        push(p1, 0);
        push([...cur], 1);
        push(cur, 2);
        segments.push({ type: 'C', p1, p2: [...cur], p3: cur });
        break;
      }
      case 're': {
        const [x, y, w, h] = [n[0]!, n[1]!, n[2]!, n[3]!];
        const ps: Point[] = [
          [x, y],
          [x + w, y],
          [x + w, y + h],
          [x, y + h],
        ];
        ps.forEach((p, k) => push(p, k));
        segments.push(
          { type: 'M', p: ps[0]! },
          { type: 'L', p: ps[1]! },
          { type: 'L', p: ps[2]! },
          { type: 'L', p: ps[3]! },
          { type: 'Z' },
        );
        move = cur = [x, y];
        break;
      }
      case 'h':
        segments.push({ type: 'Z' });
        cur = move;
        break;
    }
  });
  return { points, slots, segments };
}

/** Points of a segment list (in PathEdit.points number order). */
function segmentPoints(segs: readonly PathSegment[]): Point[] {
  const out: Point[] = [];
  for (const s of segs) {
    if (s.type === 'M' || s.type === 'L') out.push(s.p);
    else if (s.type === 'C') out.push(s.p1, s.p2, s.p3);
  }
  return out;
}

const near = (a: Point, b: Point, tol = 1e-6) =>
  Math.abs(a[0] - b[0]) <= tol * Math.max(1, Math.abs(a[0])) &&
  Math.abs(a[1] - b[1]) <= tol * Math.max(1, Math.abs(a[1]));

/** Rebuilds the construction operation text from the point list. null for an operation whose changed is false (original bytes kept). */
function rebuildConstructs(
  constructs: readonly Construct[],
  slots: readonly PointSlot[],
  oldPts: readonly Point[],
  newPts: readonly Point[],
): (string | null)[] {
  const byConstruct = constructs.map(() => [] as number[]);
  slots.forEach((s, i) => byConstruct[s.construct]!.push(i));
  const f = (p: Point) => `${fmt9(p[0])} ${fmt9(p[1])}`;
  let cur: Point = [0, 0];
  let move: Point = [0, 0];
  return constructs.map((c, ci) => {
    const idx = byConstruct[ci]!;
    const np = idx.map((i) => newPts[i]!);
    const changed = idx.some((i) => !near(oldPts[i]!, newPts[i]!, 0));
    const before = cur;
    let text: string | null = null;
    switch (c.op.op) {
      case 'm':
        if (changed) text = `${f(np[0]!)} m`;
        move = cur = np[0]!;
        break;
      case 'l':
        if (changed) text = `${f(np[0]!)} l`;
        cur = np[0]!;
        break;
      case 'c':
        if (changed) text = `${f(np[0]!)} ${f(np[1]!)} ${f(np[2]!)} c`;
        cur = np[2]!;
        break;
      case 'v': {
        // If the first control point equals the (new) current point, keep v; otherwise c.
        const implicit = near(np[0]!, before, 1e-12);
        const prevMoved = !near(before, oldPts[idx[0]!]!, 0);
        if (changed || prevMoved) {
          text = implicit
            ? `${f(np[1]!)} ${f(np[2]!)} v`
            : `${f(np[0]!)} ${f(np[1]!)} ${f(np[2]!)} c`;
        }
        cur = np[2]!;
        break;
      }
      case 'y':
        if (changed) {
          text = near(np[1]!, np[2]!, 1e-12)
            ? `${f(np[0]!)} ${f(np[2]!)} y`
            : `${f(np[0]!)} ${f(np[1]!)} ${f(np[2]!)} c`;
        }
        cur = np[2]!;
        break;
      case 're': {
        const [p0, p1, p2, p3] = np as [Point, Point, Point, Point];
        if (changed) {
          const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
          const rect = eq(p0[1], p1[1]) && eq(p1[0], p2[0]) && eq(p2[1], p3[1]) && eq(p3[0], p0[0]);
          text = rect
            ? `${f(p0)} ${fmt9(p1[0] - p0[0])} ${fmt9(p3[1] - p0[1])} re`
            : `${f(p0)} m ${f(p1)} l ${f(p2)} l ${f(p3)} l h`;
        }
        move = cur = p0;
        break;
      }
      case 'h':
        cur = move;
        break;
    }
    return text;
  });
}

// ---------------------------------------------------------------- Writing (4.3, D3, D4)

/** Stream to write (page /Contents slot or Form copy). */
interface Holder {
  key: string;
  orig: Uint8Array;
  write(bytes: Uint8Array): void;
  /** Fixed replacements unrelated to editing, such as Do name replacement. */
  fixed: Replacement[];
  /** Resources of the Form copy (for registering child copies). null for the page (the page Resources are used). */
  res: mupdf.PDFObject | null;
}

interface PreparedItem {
  holder: string;
  constructs: Construct[];
  paint: SourceOp;
  toPage: Matrix;
  bbox: Rect;
  /** Page-space box of the construction points (excluding line width). The difference from the painted box is the line-width margin. */
  pointsBox: Rect;
  pathIndex: number;
  /** All PageModel.paths indices linked to this painting operation. */
  infos: number[];
  fill: PaintColor | null;
  stroke: PaintColor | null;
  /** Path-space line width (stroke kinds only). */
  lineWidth: number | null;
  clipRect: Rect | null;
  /** Model segments (for point number cross-checking, if present). */
  segments: PathSegment[] | null;
}

interface PreparedState {
  editId: string;
  holders: Map<string, Holder>;
  items: PreparedItem[];
  /** PageModel.paths indices the ruled-strategy table used as its grid (LayoutTable.paths). */
  rulePaths: Set<number>;
  warnings: EditWarning[];
}

const prepared = new WeakMap<mupdf.PDFDocument, Map<string, PreparedState>>();

/** Discards the path draft preparation state (R-L3). Without editId, all state of this document. */
export function releasePathEdit(doc: mupdf.PDFDocument, editId?: string): void {
  if (editId === undefined) prepared.delete(doc);
  else prepared.get(doc)?.delete(editId);
}

function stateOf(doc: mupdf.PDFDocument, editId: string): PreparedState {
  const s = prepared.get(doc)?.get(editId);
  if (!s) throw new Error(`preparePathEdit 결과 없음: ${editId}`);
  return s;
}

/** Edit preparation (Form duplication etc. if needed). Called inside a journal operation. */
export function preparePathEdit(
  ctx: ParagraphEditContext,
  plan: Omit<PathEditPlan, 'revision'>,
  editId: string,
): PreparedPathEdit {
  if (!plan.editable) {
    throw new Error(`편집할 수 없는 패스: ${plan.limits.map((l) => l.reason).join(', ')}`);
  }
  const doc = ctx.doc;
  const items = itemsFor(ctx, plan.target.paintSeqs);
  const streams = new StreamCache(doc);
  items.forEach((it, k) => {
    const fp = plan.target.fingerprints[k];
    if (!fp || !sameFingerprint(fp, fingerprintOf(it, streams))) {
      throw new Error(`판정 이후 패스가 바뀜(지문 불일치): paintSeq ${it.paintSeq}`);
    }
    if (it.limits.length > 0) {
      throw new Error(`편집 제한: ${it.limits.map((l) => l.reason).join(', ')}`);
    }
  });

  const changed = new Set<number>();
  const holders = new Map<string, Holder>();
  const pageObj = doc.findPage(ctx.pageIndex);
  let pageRes: mupdf.PDFObject | null = null;
  const ownPageRes = () => {
    if (!pageRes) {
      const inherited = pageObj.getInheritable('Resources');
      pageRes = ownResources(doc, pageObj, inherited.isNull() ? null : inherited);
      if (pageObj.isIndirect()) changed.add(pageObj.asIndirect());
    }
    return pageRes;
  };
  const slotHolder = (s: ContentStreamRef): Holder => {
    const key = `p:${s.contentsIndex}:${s.objectNumber}`;
    let h = holders.get(key);
    if (h) return h;
    const slot = s.contentsIndex!;
    if (contentsSlotNumber(pageObj, slot) !== s.objectNumber) {
      throw new Error(`SourceMap 이 문서와 다름: /Contents[${slot}] ≠ ${s.objectNumber} 0 R`);
    }
    let num = s.objectNumber;
    const orig = streams.get(num).slice();
    if (contentsUseCount(doc, num) > 1) {
      const copy = doc.addStream(orig, {});
      replaceContentsSlot(doc, pageObj, slot, copy);
      num = copy.asIndirect();
      if (pageObj.isIndirect()) changed.add(pageObj.asIndirect());
    }
    changed.add(num);
    const target = num;
    h = {
      key,
      orig,
      write: (b) => writeStreamBytes(doc.newIndirect(target), b),
      fixed: [],
      res: null,
    };
    holders.set(key, h);
    return h;
  };
  const holderOfStream = (s: ContentStreamRef, path: readonly FormStep[]): Holder =>
    s.contentsIndex !== null ? slotHolder(s) : formHolder(path);
  /** Innermost Form copy of usage path path (length ≥ 1). A shared path prefix is one copy. */
  const formHolder = (path: readonly FormStep[]): Holder => {
    const key = `f:${formKey(path)}`;
    let h = holders.get(key);
    if (h) return h;
    const step = path.at(-1)!;
    const parentPath = path.slice(0, -1);
    const parent = holderOfStream(step.stream, parentPath);
    const orig = doc.newIndirect(step.objectNumber);
    const cd = doc.newDictionary();
    orig.forEach((v, k) => {
      const key2 = String(k);
      if (['Length', 'Filter', 'DecodeParms', 'StructParents', 'StructParent'].includes(key2)) {
        return;
      }
      cd.put(key2, v);
    });
    const clone = doc.addStream('', cd);
    const parentRes = parent.res ?? ownPageRes();
    // A Form without /Resources is drawn with the Resources of its caller (the parent Form, or the page if none) (the deprecated inheritance of spec 7.8.3,
    // followed by MuPDF, pdf.js and Poppler alike). An empty dictionary on the copy would leave names such as fonts unfound, so a copy of the caller's effective
    // Resources is made and owned by the copy (copied before putUniqueResource below, so its own entry is not included).
    const res = ownResources(doc, clone, orig.get('Resources').isNull() ? parentRes : null);
    changed.add(clone.asIndirect());
    const xobjects = ownSubdict(doc, parentRes, 'XObject');
    // If this re-edits a Form that is already a copy (PEFn), erase the previous name that will no longer be used (M4 review L2). Erased only when this page
    // calls this Form from a single place and a Resources entry points to this object (save garbage walks the objects).
    const oldName = clonedName(streams, step);
    if (oldName !== null && formUses(ctx, step.objectNumber) === 1) {
      const ref = xobjects.get(oldName);
      if (ref.isIndirect() && ref.asIndirect() === step.objectNumber) xobjects.delete(oldName);
    }
    const name = putUniqueResource(xobjects, clone, 'PEF');
    parent.fixed.push({ start: step.nameRange[0], end: step.nameRange[1], text: `/${name}` });
    h = {
      key,
      orig: streams.get(step.objectNumber).slice(),
      write: (b) => writeStreamBytes(clone, b),
      fixed: [],
      res,
    };
    holders.set(key, h);
    return h;
  };

  const pItems: PreparedItem[] = items.map((it) => {
    const holder = holderOfStream(it.op.stream, it.op.formPath);
    const toPage = concat(it.op.ctm, ctx.map.userToPage);
    const constructs = it.constructs.map((c) => {
      const nums = parseConstruct(c, streams.get(c.stream.objectNumber));
      if (!nums) throw new Error(`구성 연산을 읽지 못함: ${c.op}`);
      return { op: c, nums };
    });
    const { points } = constructPoints(constructs.map((c) => ({ op: c.op.op, nums: c.nums })));
    let pointsBox: Rect | null = null;
    for (const p of points) {
      const q = apply(toPage, p[0], p[1]);
      pointsBox = union(pointsBox, [q[0], q[1], q[0], q[1]]);
    }
    const fill = paintColorOf(ctx, it, 'fill');
    const stroke = paintColorOf(ctx, it, 'stroke');
    const info = ctx.model.paths[it.pathIndex];
    const clip = it.op.state?.clipRect;
    return {
      holder: holder.key,
      constructs,
      paint: it.op,
      toPage,
      bbox: [...it.bbox] as Rect,
      pointsBox: pointsBox ?? ([...it.bbox] as Rect),
      pathIndex: it.pathIndex,
      infos: [...it.infos],
      fill: fill?.color ?? null,
      stroke: stroke?.color ?? null,
      lineWidth: stroke?.lineWidth ?? null,
      clipRect: clip ? ([...clip] as Rect) : null,
      segments: info?.segments ?? null,
    };
  });
  // The copy was made with an empty stream, so it is written once with only the fixed replacements. A page /Contents slot with no fixed replacement is not written
  // (the first write is writePathEdit). An initial draft cancelled without changes does not change the document, so redo remains (M4 review M1).
  for (const h of holders.values()) {
    if (h.res !== null || h.fixed.length > 0) h.write(applyReplacements(h.orig, h.fixed));
  }

  let map = prepared.get(doc);
  if (!map) {
    map = new Map();
    prepared.set(doc, map);
  }
  map.set(editId, {
    editId,
    holders,
    items: pItems,
    rulePaths: new Set(
      ctx.layout.tables.filter((t) => t.strategy === 'lines').flatMap((t) => t.paths),
    ),
    warnings: [],
  });
  return {
    editId,
    target: plan.target,
    changedObjects: [...changed].sort((a, b) => a - b),
  };
}

/** 8-bit rounding comparison (D3: if equal, that channel is not written). */
const same8 = (a: RGB, b: RGB | null) =>
  b !== null && a.every((v, i) => Math.round(v * 255) === Math.round(b[i]! * 255));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** New color operation (D3). A Device space in the original color space family; DeviceRGB + a warning if it cannot be represented. */
function colorOps(
  rgb: RGB,
  orig: PaintColor | null,
  stroke: boolean,
): { text: string; spaceChanged: boolean } {
  const [r, g, b] = rgb.map(clamp01) as RGB;
  const n = orig?.values.length ?? 3;
  const special = orig !== null && /^(Separation|DeviceN|Indexed|Lab)/.test(orig.space);
  const op = (base: string) => (stroke ? base.toUpperCase() : base);
  const rgbText = { text: `${fmt9(r)} ${fmt9(g)} ${fmt9(b)} ${op('rg')}`, spaceChanged: true };
  if (special || ![1, 3, 4].includes(n)) return rgbText;
  if (n === 3) return { ...rgbText, spaceChanged: false };
  if (n === 1) {
    const r8 = Math.round(r * 255);
    if (r8 !== Math.round(g * 255) || r8 !== Math.round(b * 255)) return rgbText;
    return { text: `${fmt9(r)} ${op('g')}`, spaceChanged: false };
  }
  const k = 1 - Math.max(r, g, b);
  const d = 1 - k;
  const cmyk = d <= 1e-12 ? [0, 0, 0, 1] : [(d - r) / d, (d - g) / d, (d - b) / d, k];
  return { text: `${cmyk.map(fmt9).join(' ')} ${op('k')}`, spaceChanged: false };
}

/** Whether the page-space affine transform is translation and scaling only. */
function checkTransform(t: Matrix): void {
  if (!t.every(Number.isFinite)) throw new Error('변환 행렬이 유한하지 않음');
  if (Math.abs(t[1]) > 1e-9 || Math.abs(t[2]) > 1e-9) {
    throw new Error('패스 변환은 이동·확대축소만(b = c = 0)');
  }
  if (Math.abs(t[0]) < 1e-9 || Math.abs(t[3]) < 1e-9) throw new Error('특이 변환 행렬');
}

interface ItemResult {
  reps: Replacement[];
  bbox: Rect;
  spaceChanged: boolean;
}

function itemReplacements(it: PreparedItem, edit: PathEdit, single: boolean): ItemResult {
  const first = it.constructs[0]!.op;
  const paint = it.paint;
  if (edit.delete) {
    return {
      reps: [{ start: first.range[0], end: paint.range[1], text: ' ' }],
      bbox: [...it.bbox] as Rect,
      spaceChanged: false,
    };
  }
  const reps: Replacement[] = [];
  const { points, slots, segments } = constructPoints(
    it.constructs.map((c) => ({ op: c.op.op, nums: c.nums })),
  );
  let newPts = points.map((p) => [...p] as Point);
  const fromPage = invert(it.toPage);
  if (!fromPage) throw new Error('특이 CTM');
  if (edit.points && edit.points.length > 0) {
    if (!single) throw new Error('점 편집은 패스 하나만');
    if (it.segments) {
      const model = segmentPoints(it.segments);
      const ok =
        model.length === points.length &&
        model.every((p, i) => near(p, points[i]!)) &&
        it.segments.length === segments.length;
      if (!ok) throw new Error('점 편집 불가: 모델 세그먼트와 구성 연산 점 대응이 다름');
    }
    for (const { index, to } of edit.points) {
      if (!Number.isInteger(index) || index < 0 || index >= newPts.length) {
        throw new Error(`점 번호 범위 밖: ${index}`);
      }
      newPts[index] = apply(fromPage, to[0], to[1]);
    }
  }
  if (edit.transform) {
    checkTransform(edit.transform);
    const a = concat(concat(it.toPage, edit.transform), fromPage);
    newPts = newPts.map((p) => apply(a, p[0], p[1]));
  }
  const texts = rebuildConstructs(it.constructs, slots, points, newPts);
  texts.forEach((t, i) => {
    if (t === null) return;
    const op = it.constructs[i]!.op;
    reps.push({ start: op.range[0], end: op.range[1], text: t });
  });

  // Attributes.
  const attrs: string[] = [];
  let spaceChanged = false;
  const fills = FILLS.has(paint.op);
  const strokes = STROKES.has(paint.op);
  if (fills && edit.fill && !same8(edit.fill, it.fill?.rgb ?? null)) {
    const c = colorOps(edit.fill, it.fill, false);
    attrs.push(c.text);
    spaceChanged ||= c.spaceChanged;
  }
  if (strokes && edit.stroke && !same8(edit.stroke, it.stroke?.rgb ?? null)) {
    const c = colorOps(edit.stroke, it.stroke, true);
    attrs.push(c.text);
    spaceChanged ||= c.spaceChanged;
  }
  let widthRatio = 1;
  if (strokes && edit.lineWidth !== null && Number.isFinite(edit.lineWidth)) {
    const w = Math.max(0, edit.lineWidth) / expansion(it.toPage);
    const old = it.lineWidth ?? 1;
    if (Math.abs(w - old) > 1e-9 * Math.max(1, old)) {
      attrs.push(`${fmt9(w)} w`);
      widthRatio = old > 0 ? w / old : 1;
    }
  }
  if (attrs.length > 0) {
    reps.push({ start: first.range[0], end: first.range[0], text: `q ${attrs.join(' ')} ` });
    reps.push({ start: paint.range[1], end: paint.range[1], text: ' Q' });
  }

  // New box: point box + original line-width margin (reflecting the thickness ratio).
  let box: Rect | null = null;
  for (const p of newPts) {
    const q = apply(it.toPage, p[0], p[1]);
    box = union(box, [q[0], q[1], q[0], q[1]]);
  }
  const pad = [
    it.pointsBox[0] - it.bbox[0],
    it.pointsBox[1] - it.bbox[1],
    it.bbox[2] - it.pointsBox[2],
    it.bbox[3] - it.pointsBox[3],
  ].map((v) => Math.max(0, v) * widthRatio);
  const b = box ?? it.bbox;
  return {
    reps,
    bbox: [b[0] - pad[0]!, b[1] - pad[1]!, b[2] + pad[2]!, b[3] + pad[3]!],
    spaceChanged,
  };
}

const inside = (a: Rect, b: Rect, tol = 0.5) =>
  a[0] >= b[0] - tol && a[1] >= b[1] - tol && a[2] <= b[2] + tol && a[3] <= b[3] + tol;

/** Writes the path edit to the stream. Can be called repeatedly in the same draft. */
export function writePathEdit(
  ctx: ParagraphEditContext,
  prepared: PreparedPathEdit,
  edit: PathEdit,
): { bbox: Rect; writeMs: number } {
  const t0 = now();
  const st = stateOf(ctx.doc, prepared.editId);
  const lists = new Map<string, Replacement[]>();
  let bbox: Rect | null = null;
  const warnings: EditWarning[] = [];
  const clipped: Rect[] = [];
  const spaceRects: Rect[] = [];
  const ruleRects: Rect[] = [];
  const taggedRects: Rect[] = [];
  const single = st.items.length === 1;
  for (const it of st.items) {
    const r = itemReplacements(it, edit, single);
    const l = lists.get(it.holder) ?? [];
    l.push(...r.reps);
    lists.set(it.holder, l);
    bbox = union(bbox, r.bbox);
    if (r.spaceChanged) spaceRects.push(r.bbox);
    if (!edit.delete && it.clipRect && !inside(r.bbox, it.clipRect)) clipped.push(r.bbox);
    if (edit.delete && it.infos.some((i) => st.rulePaths.has(i))) ruleRects.push(it.bbox);
    if (edit.delete && it.paint.markedContent?.some((m) => m.mcid !== null)) {
      taggedRects.push(it.bbox);
    }
  }
  for (const h of st.holders.values()) {
    h.write(applyReplacements(h.orig, [...h.fixed, ...(lists.get(h.key) ?? [])]));
  }
  if (spaceRects.length > 0) {
    warnings.push({
      kind: 'color-space-changed',
      message: '원래 색공간으로 고른 색을 나타낼 수 없어 DeviceRGB 로 씁니다.',
      rects: spaceRects,
    });
  }
  if (clipped.length > 0) {
    warnings.push({
      kind: 'path-clipped',
      message: '편집한 패스가 칠하기 시점 클립·Form BBox 밖으로 나가 일부가 보이지 않습니다.',
      rects: clipped,
    });
  }
  if (ruleRects.length > 0) {
    warnings.push({
      kind: 'table-rule-removed',
      message: '표 괘선으로 쓰인 패스를 지웁니다. 표 감지가 바뀔 수 있습니다.',
      rects: ruleRects,
    });
  }
  if (taggedRects.length > 0) {
    // Use an existing structure warning instead of creating a new warning kind (shared-types is outside the M5 S5 scope).
    warnings.push({
      kind: 'tagged-structure-unlinked',
      message:
        '태그(MCID)된 콘텐츠 안의 패스를 지웁니다. 태그 PDF 구조 트리에 내용 없는 항목이 남을 수 있습니다.',
      variant: 'path-removed',
      rects: taggedRects,
    });
  }
  st.warnings = warnings;
  return { bbox: bbox ?? prepared.target.bbox, writeMs: now() - t0 };
}

/**
 * Edit warnings of the last writePathEdit (`color-space-changed`, `path-clipped`, `table-rule-removed`, and on deletion the tag `tagged-structure-unlinked`). Plan warnings
 * (PathEditPlan.warnings) are not included. They are kept separately because the return signature of writePathEdit is fixed.
 */
export function pathEditWarnings(
  ctx: ParagraphEditContext,
  prepared: PreparedPathEdit,
): EditWarning[] {
  return stateOf(ctx.doc, prepared.editId).warnings.map((w) => ({ ...w, rects: [...w.rects] }));
}
