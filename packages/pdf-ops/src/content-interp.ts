/**
 * Content stream interpreter (PLAN.md 3.4, docs/m1-contract.md sections 3 and 5.1).
 *
 * Emulates the Device delivery behavior of MuPDF 1.28 pdf-op-run.c and, per operation, records the byte range, state, glyph origin,
 * glyphSeq and paintSeq. Delivery-time model (docs/m1-pdf-ops.md 3.1):
 * - Text is gathered into "execution units" (consecutive glyphs of the same tos mode) and goes to the Device at flush time (color, line state, gs, Q, cm, W, ET,
 *   marked content, page end, Tr change on the next glyph). Tr 4–7 glyphs also go into the clip accumulation and
 *   go again at ET (ET resend: clip if the last execution-unit mode is 4–7, ignore if 3, none otherwise).
 * - Records the arrival of each glyph (fill, stroke, fill+stroke, ignore, clip, clip-stroke), and the counting policy
 *   (GlyphSeqPolicy) decides arrival → glyphSeq. Switching policy is one constant.
 * - Paint callbacks (paintSeq) follow the paintSeq table in contract section 3. Tiling patterns are split, under the same conditions as MuPDF, into
 *   the beginTile path (cells not counted) and the direct execution path (cell content only consumes numbers, once per tile).
 * - Image XObjects use only get() on an indirect reference (resolve() is forbidden, PLAN.md section 7 risk 7).
 */
import type * as mupdf from 'mupdf';
import type {
  SourceMap,
  ContentStreamInfo,
  ContentStreamRef,
  EditLimitReason,
  FormStep,
  Matrix,
  OpenMarkedContent,
  Point,
  SourceGlyph,
  SourceMapError,
  SourceOp,
  SourceOpKind,
  SourceOpState,
} from '@pdf-editor/shared-types';
import {
  decodeStringToken,
  inlineImageEntries,
  parseContentOpsLenient,
  type ContentOp,
  type Token,
} from './content-stream.js';
import { now } from './clock.js';
import { readStreamBytes } from './mupdf-util.js';
import { OptionalContent } from './optional-content.js';
import { FontCache, type PdfFont } from './pdf-fonts.js';
import { loadType3, T3_COLOR, T3_UNCACHEABLE, type Type3Font, type Type3Glyph } from './type3.js';

/**
 * glyphSeq counting policy (contract 3.1, decision pending).
 * - first-arrival: counted when the glyph first arrives at the Device (pdf-ops proposal A).
 * - no-clip: arrivals of clipText and clipStrokeText are not counted. All other arrivals are counted (core proposal A).
 *   If a glyph that already has a number is counted again (ET ignore resend), that number is consumed without an owning glyph.
 */
export type GlyphSeqPolicy = 'first-arrival' | 'no-clip';
export const GLYPH_SEQ_POLICY: GlyphSeqPolicy = 'first-arrival';

export interface InterpretOptions {
  maxFormDepth: number;
  policy: GlyphSeqPolicy;
  /** For tests: Device delivery order trace (text arrival `kind:glyph count`, paint `P`). */
  trace?: string[];
}

export interface InterpretResult {
  userToPage: Matrix;
  streams: ContentStreamInfo[];
  ops: SourceOp[];
  glyphCount: number;
  paintCount: number;
  errors: SourceMapError[];
}

type Rect4 = [number, number, number, number];
type Arrival = 'fill' | 'stroke' | 'fill+stroke' | 'ignore' | 'clip' | 'clip-stroke';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Index of the in-progress path commands and the last move command (-1: none). Used to restore the current point on h. */
interface PathBuf {
  cmds: number[][];
  move: number;
  /** Id of the constituent operation that made this path (recorded operations only, M4 SourceOp.pathOps). */
  ops: number[];
}

const newPath = (): PathBuf => ({ cmds: [], move: -1, ops: [] });

/** Operation kinds that record operand byte ranges (M4 SourceOp.operandRanges). */
const OPERAND_RANGE_KINDS: ReadonlySet<SourceOpKind> = new Set(['path-construct', 'color']);

function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function apply(m: Matrix, x: number, y: number): Point {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function preTranslate(m: Matrix, tx: number, ty: number): Matrix {
  return [m[0], m[1], m[2], m[3], tx * m[0] + ty * m[2] + m[4], tx * m[1] + ty * m[3] + m[5]];
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (det === 0) return [...IDENTITY];
  const r = 1 / det;
  const a = m[3] * r;
  const b = -m[1] * r;
  const c = -m[2] * r;
  const d = m[0] * r;
  return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d];
}

function transformRect(r: Rect4, m: Matrix): Rect4 {
  const pts = [
    apply(m, r[0], r[1]),
    apply(m, r[2], r[1]),
    apply(m, r[0], r[3]),
    apply(m, r[2], r[3]),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** MuPDF fz_matrix_max_expansion. */
function maxExpansion(m: Matrix): number {
  return Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
}

const OP_KIND: Record<string, SourceOpKind> = {};
const kinds: [SourceOpKind, string][] = [
  ['text-show', 'Tj TJ \' "'],
  ['text-state', 'Tc Tw Tz TL Tf Tr Ts Td TD Tm T*'],
  ['text-object', 'BT ET'],
  ['path-construct', 'm l c v y h re'],
  ['path-paint', 'S s f F f* B B* b b* n'],
  ['clip', 'W W*'],
  ['xobject', 'Do'],
  ['inline-image', 'BI'],
  ['shading', 'sh'],
  ['graphics-state', 'q Q cm w J j M d ri i gs'],
  ['color', 'CS cs SC SCN sc scn G g RG rg K k'],
  ['marked-content', 'BMC BDC EMC MP DP'],
  ['compat', 'BX EX'],
  ['type3', 'd0 d1'],
];
for (const [kind, list] of kinds) for (const op of list.split(' ')) OP_KIND[op] = kind;

/** Operations that flush the text execution unit when the operator runs (where MuPDF calls pdf_flush_text). */
const FLUSHING = new Set(
  'CS cs SC SCN sc scn G g RG rg K k w j J M d ri Q cm W W* BMC BDC EMC MP DP'.split(' '),
);

interface TilingPattern {
  /** PaintType 2 (uncolored pattern). Releases both fill and stroke materials inside the cell. */
  uncolored: boolean;
  bbox: Rect4;
  xstep: number;
  ystep: number;
  matrix: Matrix;
  stream: mupdf.PDFObject;
  resources: mupdf.PDFObject | null;
  usesBlending: boolean;
}

interface Material {
  kind: 'color' | 'pattern' | 'shade';
  /** The tiling pattern set when kind = pattern (nothing painted if absent). */
  pattern: TilingPattern | null;
  /** Pattern base matrix: CTM at the start of the parent content at set time (content → user space). */
  base: Matrix;
}

interface GState {
  ctm: Matrix;
  clipDepth: number;
  font: PdfFont | null;
  /** Tf resource missing or MuPDF failed to load it, so replaced with the hail-mary font. */
  fontFallback: boolean;
  /** Glyph preparation result for a Type3 font (for the direct-execution decision). */
  type3: Type3Font | null;
  fontResource: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  render: number;
  fill: Material;
  stroke: Material;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  lineJoin: number;
  miterLimit: number;
  /** Effective fill color operation ids (cs followed by sc/scn, or one of g/rg/k). Replaced with a new array when changed (operation records share it). */
  fillColorOps: number[];
  /** Effective stroke color operation ids (CS followed by SC/SCN, or one of G/RG/K, M4). */
  strokeColorOps: number[];
  /** Effective w operation id (M4). gs /LW is handled via extGStateOps. */
  lineWidthOps: number[];
  /** Executed gs operation ids (outer → inner). Replaced with a new array when changed. */
  extGStateOps: number[];
  /** Intersection of rectangular clips (page space). null if a non-rectangular clip applies. */
  clipRect: Rect4 | null;
}

/** One open marked content (stack entry). */
interface MarkedEntry {
  mcid: number | null;
  oc: boolean;
  info: OpenMarkedContent;
}

/** The rectangle if the path commands are a single axis-aligned rectangle in device space, otherwise null (an empty path is an empty rectangle). */
function rectOfPath(cmds: readonly number[][], dev: Matrix): Rect4 | null {
  const pts: Point[] = [];
  let closed = false;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i]!;
    if (c[0] === 0) {
      if (i !== 0) return null;
      pts.push(apply(dev, c[1]!, c[2]!));
    } else if (c[0] === 1) {
      if (closed) return null;
      pts.push(apply(dev, c[1]!, c[2]!));
    } else if (c[0] === 3) closed = true;
    else return null;
  }
  if (pts.length === 0) return [0, 0, 0, 0];
  // If the last point equals the first point (an explicitly closed path), drop it.
  const eq = (a: Point, b: Point) => Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
  if (pts.length === 5 && eq(pts[0]!, pts[4]!)) pts.pop();
  if (pts.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    if (Math.abs(a[0] - b[0]) > 1e-3 && Math.abs(a[1] - b[1]) > 1e-3) return null;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function intersectRect(a: Rect4 | null, b: Rect4 | null): Rect4 | null {
  if (!a || !b) return null;
  const r: Rect4 = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  if (r[2] < r[0]) r[2] = r[0];
  if (r[3] < r[1]) r[3] = r[1];
  return r;
}

/** Whether the matrix keeps axis alignment in device space (rotations of 0, 90, 180, 270, flips). */
const axisAligned = (m: Matrix) =>
  (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) ||
  (Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);

const cloneGs = (g: GState): GState => ({
  ...g,
  fill: { ...g.fill },
  stroke: { ...g.stroke },
});

/** One glyph (or a glyph for unowned counting). */
interface GlyphRef {
  glyph: SourceGlyph | null;
  op: SourceOp | null;
  counted: boolean;
  /** Text space → content space glyph matrix (trm of MuPDF fz_text). The origin is computed with the CTM at arrival time. */
  trm: Matrix;
  /** Approximate bounds in device space (for the tiling-pattern text decision). */
  box: Rect4;
}

interface PendingRun {
  glyphs: GlyphRef[];
  owner: SourceOp | null;
}

interface Segment {
  start: number;
  end: number;
  ref: ContentStreamRef;
}

interface ExecCtx {
  bytes: Uint8Array;
  segments: Segment[];
  /** Resource chain (innermost first). MuPDF pdf_lookup_resource also searches the outer content's resources. */
  resources: mupdf.PDFObject[];
  formPath: FormStep[];
  /** false = counting only, such as a pattern cell (no operation records). */
  owned: boolean;
  /** CTM at the start of this content (pattern base). */
  parentCtm: Matrix;
  inheritsResources: boolean;
  structParents: boolean;
  formOC: boolean;
  doOrdinals: number[];
  depth: number;
  opIds: number[];
}

function filtersOf(stream: mupdf.PDFObject): string[] {
  const f = stream.get('Filter');
  if (f.isName()) return [f.asName()];
  if (!f.isArray()) return [];
  const out: string[] = [];
  for (let i = 0; i < f.length; i++) {
    const n = f.get(i);
    if (n.isName()) out.push(n.asName());
  }
  return out;
}

function numberArray(obj: mupdf.PDFObject, n: number): number[] | null {
  if (!obj.isArray() || obj.length < n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = obj.get(i);
    if (!v.isNumber()) return null;
    out.push(v.asNumber());
  }
  return out;
}

const objNum = (o: mupdf.PDFObject) => (o.isIndirect() ? o.asIndirect() : null);

/** get that is safe on null objects too (a null PDFObject in mupdf cannot have get called). */
const at = (o: mupdf.PDFObject, key: string) => (o.isNull() ? o : o.get(key));

/** MuPDF-style operands from a token list: top-level numbers (from the front), names (first and second), last string, last array/dictionary. */
interface Operands {
  nums: number[];
  names: string[];
  str: Token | null;
  array: Token[] | null;
  dict: Token[] | null;
}

function readOperands(tokens: readonly Token[]): Operands {
  const out: Operands = { nums: [], names: [], str: null, array: null, dict: null };
  let depth = 0;
  let group: Token[] = [];
  let groupKind: 'array' | 'dict' | null = null;
  for (const t of tokens) {
    if (depth > 0) {
      if (t.kind === 'array-open' || t.kind === 'dict-open') depth++;
      else if (t.kind === 'array-close' || t.kind === 'dict-close') depth--;
      if (depth === 0) {
        if (groupKind === 'array') out.array = group;
        else out.dict = group;
        groupKind = null;
      } else group.push(t);
      continue;
    }
    if (t.kind === 'array-open' || t.kind === 'dict-open') {
      depth = 1;
      group = [];
      groupKind = t.kind === 'array-open' ? 'array' : 'dict';
    } else if (t.kind === 'number') out.nums.push(t.value as number);
    else if (t.kind === 'name') out.names.push(t.value as string);
    else if (t.kind === 'string' || t.kind === 'hexstring') out.str = t;
  }
  return out;
}

const num = (o: Operands, i: number) => o.nums[i] ?? 0;

/** The number after /key in dictionary tokens. */
function dictNumber(tokens: readonly Token[], key: string): number | null {
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i]!;
    const v = tokens[i + 1]!;
    if (t.kind === 'name' && t.value === key && v.kind === 'number') return v.value as number;
  }
  return null;
}

export class ContentInterpreter {
  private readonly ops: SourceOp[] = [];
  private readonly streams: ContentStreamInfo[] = [];
  private readonly streamSeen = new Set<number>();
  private readonly errors: SourceMapError[] = [];
  private glyphCounter = 0;
  private paintCounter = 0;
  private gs: GState;
  private gstack: GState[] = [];
  private tm: Matrix = [...IDENTITY];
  private tlm: Matrix = [...IDENTITY];
  private run: PendingRun | null = null;
  /** MuPDF tos.text_mode: mode of the last execution unit (including Type3 correction). */
  private tosMode = 0;
  private clipAccum: GlyphRef[] | null = null;
  private hidden = 0;
  private marked: MarkedEntry[] = [];
  /** Marked content copy used by record. Cleared to null when the stack changes. */
  private markedSnap: OpenMarkedContent[] | null = null;
  /** Between BT and ET (relative to the current content). */
  private inText = false;
  /**
   * In-progress path (content space): [0,x,y] move, [1,x,y] line, [2,x1,y1,x2,y2,x3,y3] curve, [3] close.
   * pathRight = MuPDF only_right_angles (decided at creation).
   */
  private pathBuf: PathBuf = newPath();
  private pathRight = true;
  private pathCur: Point = [0, 0];
  private pendingClip: { owner: SourceOp | null } | null = null;
  private readonly activeForms = new Set<number>();
  private readonly fonts: FontCache;
  private readonly oc: OptionalContent;
  private readonly userToPage: Matrix;
  private aborted = false;
  private patternDepth = 0;
  /** Owning operation of a directly executed pattern cell or Type3 glyph (outer reference). */
  private cellOwner: SourceOp | null = null;
  /**
   * MuPDF device MASK flag (turned on by d1). While on, color operations neither change the color nor flush text
   * (the MASK check in pdf_run_cs etc.). After a direct Type3 execution MuPDF restores the device flags, so it is
   * valid only inside the glyph procedure. A d1 in page content (non-standard) remains until the page ends.
   */
  private deviceMask = false;
  private readonly type3Cache = new Map<number, Type3Font>();
  private readonly type3Running = new Set<Type3Font>();
  /** Content being executed (for the pattern resource chain of deferred flush). */
  private cur: ExecCtx | null = null;

  constructor(
    private readonly doc: mupdf.PDFDocument,
    private readonly pageIndex: number,
    private readonly options: InterpretOptions,
  ) {
    this.fonts = new FontCache(doc);
    this.oc = new OptionalContent(doc);
    const page = doc.loadPage(pageIndex);
    let bounds: Rect4;
    try {
      this.userToPage = page.getTransform() as Matrix;
      bounds = [...page.getBounds()] as Rect4;
    } finally {
      page.destroy();
    }
    const material = (): Material => ({ kind: 'color', pattern: null, base: [...IDENTITY] });
    this.gs = {
      ctm: [...IDENTITY],
      clipDepth: 0,
      font: null,
      fontFallback: false,
      type3: null,
      fontResource: '',
      fontSize: -1,
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      leading: 0,
      rise: 0,
      render: 0,
      fill: material(),
      stroke: material(),
      fillAlpha: 1,
      strokeAlpha: 1,
      lineWidth: 1,
      lineJoin: 0,
      miterLimit: 10,
      fillColorOps: [],
      strokeColorOps: [],
      lineWidthOps: [],
      extGStateOps: [],
      clipRect: bounds,
    };
  }

  interpret(): InterpretResult {
    const pageObj = this.doc.findPage(this.pageIndex);
    const contents = pageObj.get('Contents');
    const parts: Uint8Array[] = [];
    const segments: Segment[] = [];
    const items: mupdf.PDFObject[] = [];
    if (contents.isArray()) for (let i = 0; i < contents.length; i++) items.push(contents.get(i));
    else if (!contents.isNull()) items.push(contents);
    let offset = 0;
    items.forEach((s, i) => {
      if (!s.isStream()) return;
      const bytes = readStreamBytes(s);
      const ref: ContentStreamRef = { objectNumber: objNum(s) ?? 0, contentsIndex: i };
      this.streams.push({ ...ref, decodedLength: bytes.byteLength, filters: filtersOf(s) });
      segments.push({ start: offset, end: offset + bytes.byteLength, ref });
      parts.push(bytes);
      offset += bytes.byteLength + 1;
    });
    // MuPDF joins the /Contents array with one space (0x20) byte and interprets it as a single stream (fz_open_concat pad).
    const joined = new Uint8Array(Math.max(0, offset - 1));
    let o = 0;
    parts.forEach((p, i) => {
      if (i > 0) joined[o++] = 0x20;
      joined.set(p, o);
      o += p.byteLength;
    });
    const resources = pageObj.getInheritable('Resources');
    this.exec({
      bytes: joined,
      segments,
      resources: resources.isNull() ? [] : [resources],
      formPath: [],
      owned: true,
      parentCtm: [...IDENTITY],
      inheritsResources: false,
      structParents: false,
      formOC: false,
      doOrdinals: segments.map(() => 0),
      depth: 0,
      opIds: [],
    });
    for (const op of this.ops) {
      if (!op.text) continue;
      const seqs = op.text.glyphs.map((g) => g.seq).filter((s): s is number => s !== null);
      if (seqs.length === 0) continue;
      // Compute by iteration so an operation with many glyphs does not exceed the spread-argument limit.
      let lo = seqs[0]!;
      let hi = lo;
      for (const v of seqs) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      op.glyphSeq = [lo, hi + 1];
    }
    return {
      userToPage: this.userToPage,
      streams: this.streams,
      ops: this.ops,
      glyphCount: this.glyphCounter,
      paintCount: this.paintCounter,
      errors: this.errors,
    };
  }

  // ---- Execution ----

  private exec(ctx: ExecCtx): void {
    const { ops, error } = parseContentOpsLenient(ctx.bytes);
    const prev = this.cur;
    this.cur = ctx;
    for (const op of ops) {
      if (this.aborted) break;
      this.execOp(ctx, op);
    }
    // End of content (MuPDF pdf_process_end → op_END): flushes only the execution unit. The clip accumulation remains.
    if (!this.aborted) this.flushText();
    this.cur = prev;
    if (error && ctx.owned) {
      const seg = this.segmentAt(ctx, error.offset);
      this.errors.push({
        stream: seg.ref,
        offset: error.offset - seg.start,
        message: error.message,
      });
      for (const id of ctx.opIds) this.addLimit(this.ops[id]!, 'tokenizer-error');
    }
  }

  private segmentAt(ctx: ExecCtx, offset: number): Segment {
    let found = ctx.segments[0]!;
    for (const s of ctx.segments) if (offset >= s.start) found = s;
    return found;
  }

  private local(
    ctx: ExecCtx,
    start: number,
    end: number,
  ): { seg: Segment; range: [number, number] } {
    const seg = this.segmentAt(ctx, start);
    return {
      seg,
      range: [start - seg.start, Math.min(end, seg.end) - seg.start],
    };
  }

  private addLimit(op: SourceOp, reason: EditLimitReason): void {
    if (!op.limits.includes(reason)) op.limits.push(reason);
  }

  private record(ctx: ExecCtx, op: ContentOp): SourceOp | null {
    if (!ctx.owned) return null;
    const { seg, range } = this.local(ctx, op.start, op.end);
    const rec: SourceOp = {
      id: this.ops.length,
      op: op.op,
      kind: OP_KIND[op.op] ?? 'other',
      stream: seg.ref,
      range,
      formPath: ctx.formPath,
      ctm: [...this.gs.ctm],
      clipDepth: this.gs.clipDepth,
      mcids: this.marked.map((m) => m.mcid).filter((m): m is number => m !== null),
      optionalContent: ctx.formOC || this.marked.some((m) => m.oc),
      limits: [],
      state: this.opState(),
      markedContent: (this.markedSnap ??= this.marked.map((m) => m.info)),
    };
    if (OPERAND_RANGE_KINDS.has(rec.kind) || op.op === 'w') {
      rec.operandRanges = op.operands
        .filter((t) => t.kind === 'number' || t.kind === 'name')
        .map((t) => [t.start - seg.start, t.end - seg.start]);
    }
    if (op.end > seg.end) this.addLimit(rec, 'spans-stream-boundary');
    if (ctx.inheritsResources) this.addLimit(rec, 'form-inherits-resources');
    if (rec.mcids.length > 0 || ctx.structParents) this.addLimit(rec, 'tagged-content');
    if (rec.optionalContent) this.addLimit(rec, 'optional-content');
    this.ops.push(rec);
    ctx.opIds.push(rec.id);
    return rec;
  }

  private opState(): SourceOpState {
    const g = this.gs;
    return {
      fillColorOps: g.fillColorOps,
      strokeColorOps: g.strokeColorOps,
      lineWidthOps: g.lineWidthOps,
      extGStateOps: g.extGStateOps,
      clipRect: g.clipRect,
    };
  }

  private pushMarked(entry: MarkedEntry): void {
    this.marked.push(entry);
    this.markedSnap = null;
  }

  private resource(ctx: ExecCtx, category: string, name: string): mupdf.PDFObject | null {
    for (const res of ctx.resources) {
      const v = at(at(res, category), name);
      if (!v.isNull()) return v;
    }
    return null;
  }

  private execOp(ctx: ExecCtx, op: ContentOp): void {
    const rec = this.record(ctx, op);
    const o = readOperands(op.operands);
    const masked = this.deviceMask && OP_KIND[op.op] === 'color';
    if (masked) return;
    if (FLUSHING.has(op.op)) this.flushText();
    const gs = this.gs;
    if (rec && rec.kind === 'path-construct') this.pathBuf.ops.push(rec.id);
    switch (op.op) {
      // Graphics state
      case 'q':
        this.gstack.push(cloneGs(gs));
        break;
      case 'Q': {
        const prev = this.gstack.pop();
        if (prev) this.gs = prev;
        break;
      }
      case 'cm':
        if (this.clipAccum && this.clipAccum.length > 0) {
          // MuPDF: a CTM change during clip text accumulation ends page interpretation with an exception.
          this.aborted = true;
          this.errors.push({
            stream: this.local(ctx, op.start, op.end).seg.ref,
            offset: this.local(ctx, op.start, op.end).range[0],
            message: 'MuPDF: 클립 텍스트 누적 중 cm(해석 중단)',
          });
          return;
        }
        gs.ctm = concat([num(o, 0), num(o, 1), num(o, 2), num(o, 3), num(o, 4), num(o, 5)], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = num(o, 0);
        if (rec) gs.lineWidthOps = [rec.id];
        break;
      case 'j':
        gs.lineJoin = Math.min(2, Math.max(0, Math.trunc(num(o, 0))));
        break;
      case 'M':
        gs.miterLimit = num(o, 0);
        break;
      case 'gs':
        if (this.execGs(ctx, o.names[0]) && rec) {
          gs.extGStateOps = [...gs.extGStateOps, rec.id];
        }
        break;
      // Path
      case 'm':
        this.pathCmd([0, num(o, 0), num(o, 1)]);
        break;
      case 'l': {
        const [x, y] = [num(o, 0), num(o, 1)];
        if (x !== this.pathCur[0] && y !== this.pathCur[1]) this.pathRight = false;
        this.pathCmd([1, x, y]);
        break;
      }
      case 'c':
        this.pathCmd([2, num(o, 0), num(o, 1), num(o, 2), num(o, 3), num(o, 4), num(o, 5)]);
        break;
      case 'v':
        this.pathCmd([2, ...this.pathCur, num(o, 0), num(o, 1), num(o, 2), num(o, 3)]);
        break;
      case 'y':
        this.pathCmd([2, num(o, 0), num(o, 1), num(o, 2), num(o, 3), num(o, 2), num(o, 3)]);
        break;
      case 're': {
        // MuPDF fz_rectto: move + 3 lines + close.
        const [x, y, w, h] = [num(o, 0), num(o, 1), num(o, 2), num(o, 3)];
        this.pathCmd([0, x, y]);
        this.pathCmd([1, x + w, y]);
        this.pathCmd([1, x + w, y + h]);
        this.pathCmd([1, x, y + h]);
        this.pathCmd([3]);
        break;
      }
      case 'h':
        this.pathCmd([3]);
        break;
      case 'W':
      case 'W*':
        this.pendingClip = { owner: rec };
        if (rec) rec.pathOps = [...this.pathBuf.ops];
        break;
      case 'S':
      case 's':
        this.paintPath(rec, false, true);
        break;
      case 'f':
      case 'F':
      case 'f*':
        this.paintPath(rec, true, false);
        break;
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
        this.paintPath(rec, true, true);
        break;
      case 'n':
        this.paintPath(rec, false, false);
        break;
      // Text
      case 'BT':
        this.tm = [...IDENTITY];
        this.tlm = [...IDENTITY];
        this.inText = true;
        break;
      case 'ET':
        this.flushText();
        this.flushClipText();
        this.inText = false;
        break;
      case 'Tc':
        gs.charSpacing = num(o, 0);
        break;
      case 'Tw':
        gs.wordSpacing = num(o, 0);
        break;
      case 'Tz':
        gs.hScale = num(o, 0) / 100;
        break;
      case 'TL':
        gs.leading = num(o, 0);
        break;
      case 'Tr':
        gs.render = Math.trunc(num(o, 0));
        break;
      case 'Ts':
        gs.rise = num(o, 0);
        break;
      case 'Tf': {
        const name = o.names[0] ?? '';
        const fontObj = this.resource(ctx, 'Font', name);
        const dict = fontObj && fontObj.isDictionary() ? fontObj : null;
        gs.font = this.fonts.load(dict);
        gs.fontFallback = !dict || gs.font.fallbackReason !== undefined;
        gs.type3 = dict && gs.font.subtype === 'Type3' ? this.type3For(dict, ctx) : null;
        gs.fontResource = name;
        gs.fontSize = num(o, 0);
        break;
      }
      case 'Td':
        this.translateLine(num(o, 0), num(o, 1));
        break;
      case 'TD':
        gs.leading = -num(o, 1);
        this.translateLine(num(o, 0), num(o, 1));
        break;
      case 'Tm':
        this.tm = [num(o, 0), num(o, 1), num(o, 2), num(o, 3), num(o, 4), num(o, 5)];
        this.tlm = [...this.tm];
        break;
      case 'T*':
        this.translateLine(0, -gs.leading);
        break;
      case 'Tj':
      case 'TJ':
      case "'":
      case '"':
        this.showText(ctx, rec, op, o);
        break;
      // Color
      case 'CS':
      case 'cs':
        this.setColorSpace(ctx, op.op === 'cs' ? gs.fill : gs.stroke, o.names[0] ?? '');
        if (rec) {
          if (op.op === 'cs') gs.fillColorOps = [rec.id];
          else gs.strokeColorOps = [rec.id];
        }
        break;
      case 'SC':
      case 'sc':
      case 'SCN':
      case 'scn':
        this.setColor(ctx, op.op === 'sc' || op.op === 'scn' ? gs.fill : gs.stroke, o.names[0]);
        if ((op.op === 'sc' || op.op === 'scn') && rec) {
          // If a color space operation (cs) precedes it, keep it too (the value alone does not reveal the color space).
          const first = gs.fillColorOps[0];
          const cs = first !== undefined && this.ops[first]?.op === 'cs' ? [first] : [];
          gs.fillColorOps = [...cs, rec.id];
        } else if (rec) {
          const first = gs.strokeColorOps[0];
          const cs = first !== undefined && this.ops[first]?.op === 'CS' ? [first] : [];
          gs.strokeColorOps = [...cs, rec.id];
        }
        break;
      case 'G':
      case 'RG':
      case 'K':
        this.setColorSpace(ctx, gs.stroke, 'DeviceColor');
        if (rec) gs.strokeColorOps = [rec.id];
        break;
      case 'g':
      case 'rg':
      case 'k':
        this.setColorSpace(ctx, gs.fill, 'DeviceColor');
        if (rec) gs.fillColorOps = [rec.id];
        break;
      // Images, shades, XObjects
      case 'sh':
        if (this.hidden === 0 && o.names[0] && this.resource(ctx, 'Shading', o.names[0])) {
          this.paint(rec);
        }
        break;
      case 'BI':
        if (rec) this.addLimit(rec, 'inline-image');
        this.inlineImage(ctx, rec, op);
        break;
      case 'Do':
        this.execDo(ctx, rec, op, o);
        break;
      // marked content
      case 'd1':
        this.deviceMask = true;
        break;
      case 'BMC':
        this.pushMarked({
          mcid: null,
          oc: false,
          info: {
            opId: rec?.id ?? -1,
            tag: o.names[0] ?? '',
            mcid: null,
            actualText: false,
            insideText: this.inText,
          },
        });
        if (this.hidden > 0) this.hidden++;
        break;
      case 'BDC':
        this.beginMarked(ctx, rec, o);
        break;
      case 'EMC':
        this.marked.pop();
        this.markedSnap = null;
        if (this.hidden > 0) this.hidden--;
        break;
      default:
        break;
    }
  }

  /** Executes gs. false if the resource is missing. */
  private execGs(ctx: ExecCtx, name: string | undefined): boolean {
    if (!name) return false;
    const g = this.resource(ctx, 'ExtGState', name);
    if (!g || !g.isDictionary()) return false;
    const keys: string[] = [];
    g.forEach((_v, k) => void keys.push(String(k)));
    if (keys.some((k) => k !== 'Font' && k !== 'Type')) this.flushText();
    const lw = g.get('LW');
    if (lw.isNumber()) this.gs.lineWidth = lw.asNumber();
    const lj = g.get('LJ');
    if (lj.isNumber()) this.gs.lineJoin = lj.asNumber();
    const ml = g.get('ML');
    if (ml.isNumber()) this.gs.miterLimit = ml.asNumber();
    const ca = g.get('ca');
    if (ca.isNumber()) this.gs.fillAlpha = ca.asNumber();
    const CA = g.get('CA');
    if (CA.isNumber()) this.gs.strokeAlpha = CA.asNumber();
    const font = g.get('Font');
    if (font.isArray() && font.length >= 2) {
      const f = font.get(0);
      this.gs.font = this.fonts.load(f.isDictionary() ? f : null);
      this.gs.fontFallback = !f.isDictionary() || this.gs.font.fallbackReason !== undefined;
      this.gs.type3 =
        f.isDictionary() && this.gs.font.subtype === 'Type3' ? this.type3For(f, ctx) : null;
      this.gs.fontResource = '';
      this.gs.fontSize = font.get(1).asNumber();
    }
    return true;
  }

  private beginMarked(ctx: ExecCtx, rec: SourceOp | null, o: Operands): void {
    const tag = o.names[0] ?? '';
    let props: mupdf.PDFObject | null = null;
    if (o.names[1] !== undefined) props = this.resource(ctx, 'Properties', o.names[1]);
    let mcid: number | null = null;
    let actualText = false;
    if (o.dict) {
      mcid = dictNumber(o.dict, 'MCID');
      actualText = o.dict.some((t) => t.kind === 'name' && t.value === 'ActualText');
    } else if (props) {
      const m = props.get('MCID');
      if (m.isNumber()) mcid = m.asNumber();
      actualText = props.isDictionary() && !props.get('ActualText').isNull();
    }
    const isOC = tag === 'OC';
    this.pushMarked({
      mcid,
      oc: isOC,
      info: { opId: rec?.id ?? -1, tag, mcid, actualText, insideText: this.inText },
    });
    if (this.hidden > 0) {
      this.hidden++;
      return;
    }
    if (isOC && props && this.oc.isHidden(props)) this.hidden++;
  }

  // ---- Path ----

  private pathCmd(cmd: number[]): void {
    if (cmd[0] === 2) this.pathRight = false;
    const path = this.pathBuf;
    if (cmd[0] === 0) path.move = path.cmds.length;
    path.cmds.push(cmd);
    if (cmd[0] === 3) {
      // Close: sets the current point to the last move point (found by index, constant time regardless of path length).
      const move = path.move >= 0 ? path.cmds[path.move] : undefined;
      if (move) this.pathCur = [move[1]!, move[2]!];
    } else this.pathCur = [cmd.at(-2)!, cmd.at(-1)!];
  }

  /**
   * Gets the device-space bounds of the in-progress path and whether it is a right-angle path (MuPDF fz_bound_path), then clears the path.
   * With a right-angle CTM, transforms the path-space bounds and uses the creation-time decision. Otherwise re-decides from the transformed segments
   * (axis-alignment tolerance 0.001, curves are not right-angle, a trailing move is ignored).
   */
  private takePath(dev: Matrix): { box: Rect4; right: boolean; empty: boolean } {
    const cmds = this.pathBuf.cmds;
    const constructionRight = this.pathRight;
    this.pathBuf = newPath();
    this.pathRight = true;
    const rectilinear =
      (Math.abs(dev[1]) < 1.2e-7 && Math.abs(dev[2]) < 1.2e-7) ||
      (Math.abs(dev[0]) < 1.2e-7 && Math.abs(dev[3]) < 1.2e-7);
    if (rectilinear) {
      let b: Rect4 | null = null;
      for (const c of cmds) {
        for (let i = 1; i + 1 < c.length; i += 2) {
          const x = c[i]!;
          const y = c[i + 1]!;
          b = b
            ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]
            : [x, y, x, y];
        }
      }
      return {
        box: b ? transformRect(b, dev) : [0, 0, 0, 0],
        right: constructionRight,
        empty: b === null,
      };
    }
    const eq0 = (v: number) => v >= -0.001 && v <= 0.001;
    let rect: Rect4 = [0, 0, 0, 0];
    let first = true;
    let right = true;
    let trailing = false;
    let move: Point = [0, 0];
    let prev: Point = [0, 0];
    const expand = (p: Point) => {
      if (first) {
        rect = [p[0], p[1], p[0], p[1]];
        first = false;
      } else {
        rect = [
          Math.min(rect[0], p[0]),
          Math.min(rect[1], p[1]),
          Math.max(rect[2], p[0]),
          Math.max(rect[3], p[1]),
        ];
      }
    };
    for (const c of cmds) {
      if (c[0] === 0) {
        move = prev = apply(dev, c[1]!, c[2]!);
        trailing = true;
      } else if (c[0] === 1) {
        const p = apply(dev, c[1]!, c[2]!);
        expand(p);
        if (trailing) {
          trailing = false;
          expand(move);
        }
        if (right && !eq0(prev[0] - p[0]) && !eq0(prev[1] - p[1])) right = false;
        prev = p;
      } else if (c[0] === 2) {
        const p = apply(dev, c[1]!, c[2]!);
        expand(p);
        expand(apply(dev, c[3]!, c[4]!));
        expand(apply(dev, c[5]!, c[6]!));
        if (trailing) {
          trailing = false;
          expand(move);
        }
        right = false;
        prev = p;
      } else {
        if (right && !eq0(prev[0] - move[0]) && !eq0(prev[1] - move[1])) right = false;
        prev = move;
      }
    }
    return { box: rect, right, empty: first };
  }

  private deviceCtm(ctm: Matrix = this.gs.ctm): Matrix {
    return concat(ctm, this.userToPage);
  }

  private paintPath(rec: SourceOp | null, dofill: boolean, dostroke: boolean): void {
    const gs = this.gs;
    if (rec) rec.pathOps = [...this.pathBuf.ops];
    const dev = this.deviceCtm();
    const clipRect = this.pendingClip ? rectOfPath(this.pathBuf.cmds, dev) : null;
    const path = this.takePath(dev);
    let bbox = path.box;
    if (dostroke && !path.empty) bbox = this.expandForStroke(bbox, dev, path.right);
    if (this.hidden > 0) dofill = dostroke = false;
    if (dofill) this.paintMaterial(rec, 'fill', bbox);
    if (dostroke) this.paintMaterial(rec, 'stroke', bbox);
    if (this.pendingClip) {
      gs.clipDepth++;
      gs.clipRect = intersectRect(gs.clipRect, clipRect);
      this.paint(this.pendingClip.owner ?? rec);
      this.pendingClip = null;
    }
  }

  /** MuPDF adjust_rect_for_stroke: half-width expansion; right-angle paths and degenerate rectangles exclude the miter. */
  private expandForStroke(r: Rect4, dev: Matrix, rightAngles: boolean): Rect4 {
    let e = this.gs.lineWidth / 2 || 0.5;
    const degenerate = r[2] === r[0] || r[3] === r[1];
    if (!degenerate && !rightAngles && this.gs.lineJoin === 0 && this.gs.miterLimit > 0.5) {
      e *= this.gs.miterLimit * 2;
    }
    e *= maxExpansion(dev);
    return [r[0] - e, r[1] - e, r[2] + e, r[3] + e];
  }

  /** Paint callbacks per material for path painting: color 1, shading pattern clip+fillShade 2, tiling clip 1 + cell (when executed directly). */
  private paintMaterial(rec: SourceOp | null, what: 'fill' | 'stroke', bbox: Rect4): void {
    const m = this.gs[what];
    if (m.kind === 'color') {
      this.paint(rec);
    } else if (m.kind === 'shade') {
      this.paint(rec);
      this.paint(rec);
    } else if (m.pattern) {
      // MuPDF: pattern painting is skipped when alpha is 0 (path only).
      if ((what === 'fill' ? this.gs.fillAlpha : this.gs.strokeAlpha) === 0) return;
      this.paint(rec);
      this.showPattern(m, bbox, what, rec);
    }
  }

  private paint(owner: SourceOp | null): void {
    this.options.trace?.push('P');
    const seq = this.paintCounter++;
    // Painting inside a directly executed pattern cell is owned by that pattern-painting operation (contract amendment 3).
    const o = owner ?? this.cellOwner;
    if (o) (o.paintSeq ??= []).push(seq);
  }

  // ---- Pattern ----

  private loadPattern(obj: mupdf.PDFObject): TilingPattern | null {
    const bbox = numberArray(obj.get('BBox'), 4);
    const xstep = obj.get('XStep');
    const ystep = obj.get('YStep');
    if (!bbox || !xstep.isNumber() || !ystep.isNumber()) return null;
    const matrix = (numberArray(obj.get('Matrix'), 6) ?? [...IDENTITY]) as Matrix;
    const res = obj.get('Resources');
    let usesBlending = false;
    const gsDict = at(res, 'ExtGState');
    if (gsDict.isDictionary()) {
      gsDict.forEach((g) => {
        const bm = g.get('BM');
        const name = bm.isName()
          ? bm.asName()
          : bm.isArray() && bm.length > 0
            ? bm.get(0).asName()
            : '';
        if (name && name !== 'Normal' && name !== 'Compatible') usesBlending = true;
      });
    }
    const b = bbox as Rect4;
    const paintType = obj.get('PaintType');
    return {
      uncolored: paintType.isNumber() && paintType.asNumber() === 2,
      bbox: [
        Math.min(b[0], b[2]),
        Math.min(b[1], b[3]),
        Math.max(b[0], b[2]),
        Math.max(b[1], b[3]),
      ],
      xstep: xstep.asNumber(),
      ystep: ystep.asNumber(),
      matrix,
      stream: obj,
      resources: res.isNull() ? null : res,
      usesBlending,
    };
  }

  /** MuPDF pdf_show_pattern tile decision. On the direct execution path, runs the cell content for counting only, once per tile. */
  /** owner: the operation painting with the pattern (path painting, first operation of a text execution unit, image mask). */
  private showPattern(
    m: Material,
    area: Rect4,
    what: 'fill' | 'stroke',
    owner: SourceOp | null,
  ): void {
    const pat = m.pattern!;
    if (pat.xstep === 0 || pat.ystep === 0) return;
    const ptm = concat(pat.matrix, this.deviceCtm(m.base));
    const local = transformRect(area, invert(ptm));
    let fx0 = (local[0] - pat.bbox[0]) / pat.xstep;
    let fy0 = (local[1] - pat.bbox[1]) / pat.ystep;
    let fx1 = (local[2] - pat.bbox[0]) / pat.xstep;
    let fy1 = (local[3] - pat.bbox[1]) / pat.ystep;
    if (fx0 > fx1) [fx0, fx1] = [fx1, fx0];
    if (fy0 > fy1) [fy0, fy1] = [fy1, fy0];
    // beginTile path: core returns cached (1) so the cell is not executed (contract section 3).
    if ((fx1 - fx0 > 1 || fy1 - fy0 > 1) && !pat.usesBlending) return;
    const x0 = Math.floor(fx0 + 0.001);
    const y0 = Math.floor(fy0 + 0.001);
    let x1 = Math.ceil(fx1 - 0.001);
    let y1 = Math.ceil(fy1 - 0.001);
    if (fx1 > fx0 && x1 === x0) x1 = x0 + 1;
    if (fy1 > fy0 && y1 === y0) y1 = y0 + 1;
    const tiles = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    if (tiles > 4096 || this.patternDepth >= 4) return;
    const bytes = readStreamBytes(pat.stream);
    const invU = invert(this.userToPage);
    if (tiles === 0) return;
    // Cell content is outside page content (L4). The owner holds the paint number, and cell glyphs only consume numbers with no owner.
    const outer = this.cellOwner;
    if (!outer && owner) this.addLimit(owner, 'outside-page-content');
    this.cellOwner = outer ?? owner;
    this.patternDepth++;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const tileDev = preTranslate(ptm, x * pat.xstep, y * pat.ystep);
        this.runCountOnly(bytes, pat, what, concat(tileDev, invU), concat(ptm, invU));
      }
    }
    this.patternDepth--;
    this.cellOwner = outer;
  }

  /** Sub-execution that only consumes numbers with no owning operation (pattern cell). */
  private runCountOnly(
    bytes: Uint8Array,
    pat: TilingPattern,
    what: 'fill' | 'stroke',
    ctm: Matrix,
    parentCtm: Matrix,
  ): void {
    const resources = pat.resources;
    const saved = this.gs;
    const savedStack = this.gstack;
    const savedPath = this.pathBuf;
    const savedRight = this.pathRight;
    const savedClip = this.pendingClip;
    const savedInText = this.inText;
    const savedMarked = this.marked;
    this.inText = false;
    this.marked = [...savedMarked];
    this.markedSnap = null;
    this.gs = cloneGs(saved);
    this.gstack = [];
    this.gs.ctm = ctm;
    // MuPDF pdf_show_pattern: for a colored pattern only the painting-side material, for an uncolored pattern both revert to color.
    const unset = pat.uncolored ? [this.gs.fill, this.gs.stroke] : [this.gs[what]];
    for (const m of unset) {
      if (m.kind === 'pattern') {
        m.kind = 'color';
        m.pattern = null;
      }
    }
    this.pathBuf = newPath();
    this.pathRight = true;
    this.pendingClip = null;
    this.exec({
      bytes,
      segments: [
        { start: 0, end: bytes.byteLength, ref: { objectNumber: 0, contentsIndex: null } },
      ],
      resources: resources ? [resources, ...this.cur!.resources] : this.cur!.resources,
      formPath: [],
      owned: false,
      parentCtm,
      inheritsResources: false,
      structParents: false,
      formOC: false,
      doOrdinals: [0],
      depth: 99,
      opIds: [],
    });
    this.gs = saved;
    this.gstack = savedStack;
    this.pathBuf = savedPath;
    this.pathRight = savedRight;
    this.pendingClip = savedClip;
    this.inText = savedInText;
    this.marked = savedMarked;
    this.markedSnap = null;
  }

  // ---- Color ----

  private setColorSpace(ctx: ExecCtx, m: Material, name: string): void {
    let isPattern = name === 'Pattern';
    if (!isPattern) {
      const cs = this.resource(ctx, 'ColorSpace', name);
      if (cs && cs.isArray() && cs.length > 0 && cs.get(0).isName()) {
        isPattern = cs.get(0).asName() === 'Pattern';
      } else if (cs && cs.isName()) isPattern = cs.asName() === 'Pattern';
    }
    m.kind = isPattern ? 'pattern' : 'color';
    m.pattern = null;
    m.base = [...ctx.parentCtm];
  }

  private setColor(ctx: ExecCtx, m: Material, patternName: string | undefined): void {
    if (patternName === undefined) {
      m.base = [...ctx.parentCtm];
      return;
    }
    const p = this.resource(ctx, 'Pattern', patternName);
    if (!p) return;
    const type = p.get('PatternType');
    const t = type.isNumber() ? type.asNumber() : 0;
    if (t === 1) {
      m.kind = 'pattern';
      m.pattern = this.loadPattern(p);
    } else if (t === 2) {
      m.kind = 'shade';
      m.pattern = null;
    }
    m.base = [...ctx.parentCtm];
  }

  // ---- Text ----

  private translateLine(tx: number, ty: number): void {
    this.tlm = preTranslate(this.tlm, tx, ty);
    this.tm = [...this.tlm];
  }

  private showText(ctx: ExecCtx, rec: SourceOp | null, op: ContentOp, o: Operands): void {
    const gs = this.gs;
    const tmBefore: Matrix = [...this.tm];
    const tlmBefore: Matrix = [...this.tlm];
    if (op.op === "'" || op.op === '"') {
      if (op.op === '"') {
        gs.wordSpacing = num(o, 0);
        gs.charSpacing = num(o, 1);
      }
      this.translateLine(0, -gs.leading);
    }
    const font = gs.font;
    if (rec) {
      rec.text = {
        fontResource: gs.fontResource,
        fontObjectNumber: font?.objectNumber ?? null,
        fontSubtype: font?.subtype ?? null,
        fontSize: gs.fontSize,
        tm: tmBefore,
        charSpacing: gs.charSpacing,
        wordSpacing: gs.wordSpacing,
        horizontalScale: gs.hScale,
        leading: gs.leading,
        rise: gs.rise,
        renderMode: gs.render,
        glyphs: [],
        tlm: tlmBefore,
      };
      if (gs.render === 3) this.addLimit(rec, 'invisible-text');
      if (gs.render >= 4 && gs.render <= 7) this.addLimit(rec, 'clip-text');
      if (font?.subtype === 'Type3') this.addLimit(rec, 'type3-font');
      if (!font || font.unresolved.length > 0 || gs.fontFallback) {
        this.addLimit(rec, 'font-encoding-unresolved');
      }
    }
    // MuPDF: if there is no font (before Tf), nothing is drawn.
    if (!font) return;
    const items: (Token | number)[] = [];
    if (op.op === 'TJ') {
      // Text array: strings and numbers. MuPDF executes Tw and Tc keywords inside the array using the preceding number.
      for (const t of o.array ?? []) {
        if (t.kind === 'string' || t.kind === 'hexstring') items.push(t);
        else if (t.kind === 'number') items.push(t.value as number);
        else if (t.kind === 'keyword' && (t.value === 'Tw' || t.value === 'Tc')) {
          const last = items.at(-1);
          if (typeof last === 'number') {
            items.pop();
            if (t.value === 'Tw') gs.wordSpacing = last;
            else gs.charSpacing = last;
          }
        }
      }
    } else if (o.str) items.push(o.str);
    for (const item of items) {
      if (typeof item === 'number') {
        const tadj = -item * gs.fontSize * 0.001;
        if (font.wmode === 0) this.tm = preTranslate(this.tm, tadj * gs.hScale, 0);
        else this.tm = preTranslate(this.tm, 0, tadj);
        continue;
      }
      const s = decodeStringToken(ctx.bytes, item);
      for (const c of font.decode(s.data)) {
        const start = s.starts[c.offset] ?? item.start;
        const end = s.ends[c.offset + c.length - 1] ?? item.end;
        const { seg } = this.local(ctx, start, start);
        const glyph: SourceGlyph = {
          code: c.code,
          byteRange: [start - seg.start, Math.min(end, seg.end) - seg.start],
          origin: [0, 0],
          seq: null,
        };
        const cid = font.cid(c.code);
        if (cid >= 0) this.showChar(rec, glyph, font, cid);
        else glyph.origin = apply(this.deviceCtm(), this.tm[4], this.tm[5]);
        rec?.text?.glyphs.push(glyph);
        if (c.code === 32 && c.length === 1) {
          if (font.wmode === 0) this.tm = preTranslate(this.tm, gs.wordSpacing * gs.hScale, 0);
          else this.tm = preTranslate(this.tm, 0, gs.wordSpacing);
        }
      }
    }
  }

  private showChar(rec: SourceOp | null, glyph: SourceGlyph, font: PdfFont, cid: number): void {
    const gs = this.gs;
    const size = gs.fontSize;
    const tsm: Matrix = [size * gs.hScale, 0, 0, size, 0, gs.rise];
    let tx = 0;
    let ty = 0;
    let w0: number;
    if (font.wmode === 0) {
      w0 = font.advance(cid) * 0.001;
      tx = (w0 * size + gs.charSpacing) * gs.hScale;
    } else {
      const v = font.vertical(cid);
      tsm[4] -= v.x * size * gs.hScale * 0.001;
      tsm[5] -= v.y * size * 0.001;
      w0 = v.w * 0.001;
      ty = w0 * size + gs.charSpacing;
    }
    const trm = concat(tsm, this.tm);
    const dev = this.deviceCtm();
    glyph.origin = apply(dev, trm[4], trm[5]);
    const box = transformRect([0, -0.25, Math.max(Math.abs(w0), 0.5), 1], concat(trm, dev));
    const ref: GlyphRef = {
      glyph,
      op: rec,
      counted: false,
      trm,
      box: [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1],
    };

    // MuPDF pdf_show_char: execution-unit flush, Type3 mode correction, direct execution of uncacheable Type3 glyphs.
    const render = gs.render;
    const type3 = font.subtype === 'Type3';
    const t3 = type3 ? gs.type3 : null;
    const t3glyph = t3?.glyphs.get(cid);
    let renderDirect = t3glyph !== undefined && (t3glyph.flags & T3_UNCACHEABLE) !== 0;
    const type3hitr = type3 && render >= 4;
    if (!this.run || render !== this.tosMode || renderDirect || type3hitr) {
      this.flushText();
      this.run = { glyphs: [], owner: rec };
      this.tosMode = render;
    }
    if (type3hitr) this.tosMode -= 4;
    if (type3 && this.tosMode !== 3) this.tosMode = 0;
    // A colored (d0) Type3 glyph is executed directly rather than painted with the pattern color.
    if (t3glyph && t3glyph.flags & T3_COLOR && gs.fill.kind !== 'color') renderDirect = true;
    if (renderDirect && this.tosMode !== 3 && t3 && t3glyph) {
      this.renderType3Direct(rec, t3, t3glyph, trm);
      // The glyph is sent invisible (Tr 3) for extraction.
      this.tosMode = 3;
    }
    this.run.glyphs.push(ref);
    if (this.tosMode & 4) (this.clipAccum ??= []).push(ref);
    this.tm = preTranslate(this.tm, tx, ty);
  }

  private type3For(dict: mupdf.PDFObject, ctx: ExecCtx): Type3Font | null {
    const n = objNum(dict);
    const cached = n !== null ? this.type3Cache.get(n) : undefined;
    if (cached) return cached;
    const t3 = loadType3(dict, ctx.resources[0] ?? null);
    if (n !== null) this.type3Cache.set(n, t3);
    return t3;
  }

  /**
   * Directly executes the procedure of an uncacheable Type3 glyph on the device (MuPDF fz_render_t3_glyph_direct → pdf_run_glyph).
   * Like the new handler, the text object, hidden state and marked content are kept separate, the current gstate (color, line state) is inherited, and the font is
   * cleared. CTM = FontMatrix × glyph trm × CTM. The paint number is owned by that text operation, with outside-page-content (L4).
   */
  private renderType3Direct(
    rec: SourceOp | null,
    t3: Type3Font,
    glyph: Type3Glyph,
    trm: Matrix,
  ): void {
    if (this.type3Running.has(t3)) return; // MuPDF: recursive type3 font
    const saved = {
      gs: this.gs,
      gstack: this.gstack,
      tm: this.tm,
      tlm: this.tlm,
      run: this.run,
      tosMode: this.tosMode,
      clipAccum: this.clipAccum,
      hidden: this.hidden,
      marked: this.marked,
      pathBuf: this.pathBuf,
      pathRight: this.pathRight,
      pathCur: this.pathCur,
      pendingClip: this.pendingClip,
      cellOwner: this.cellOwner,
      deviceMask: this.deviceMask,
      inText: this.inText,
    };
    this.gs = cloneGs(saved.gs);
    this.gs.font = null;
    this.gs.type3 = null;
    this.gs.fontResource = '';
    this.gs.ctm = concat(concat(t3.matrix, trm), saved.gs.ctm);
    this.gstack = [];
    this.tm = [...IDENTITY];
    this.tlm = [...IDENTITY];
    this.run = null;
    this.tosMode = 0;
    this.clipAccum = null;
    this.hidden = 0;
    this.marked = [];
    this.markedSnap = null;
    this.inText = false;
    this.pathBuf = newPath();
    this.pathRight = true;
    this.pendingClip = null;
    if (!saved.cellOwner && rec) this.addLimit(rec, 'outside-page-content');
    this.cellOwner = saved.cellOwner ?? rec;
    this.type3Running.add(t3);
    this.exec({
      bytes: glyph.bytes,
      segments: [
        { start: 0, end: glyph.bytes.byteLength, ref: { objectNumber: 0, contentsIndex: null } },
      ],
      resources: t3.resources ? [t3.resources] : [],
      formPath: [],
      owned: false,
      parentCtm: [...this.gs.ctm],
      inheritsResources: false,
      structParents: false,
      formOC: false,
      doOrdinals: [0],
      depth: 99,
      opIds: [],
    });
    this.type3Running.delete(t3);
    this.gs = saved.gs;
    this.gstack = saved.gstack;
    this.tm = saved.tm;
    this.tlm = saved.tlm;
    this.run = saved.run;
    this.tosMode = saved.tosMode;
    this.clipAccum = saved.clipAccum;
    this.hidden = saved.hidden;
    this.marked = saved.marked;
    this.markedSnap = null;
    this.inText = saved.inText;
    this.pathBuf = saved.pathBuf;
    this.pathRight = saved.pathRight;
    this.pathCur = saved.pathCur;
    this.pendingClip = saved.pendingClip;
    this.cellOwner = saved.cellOwner;
    // MuPDF pdf_show_char: saves the device flags before direct execution and restores them afterwards.
    this.deviceMask = saved.deviceMask;
  }

  /** Flushes the execution unit (MuPDF pdf_flush_text). */
  private flushText(): void {
    const run = this.run;
    this.run = null;
    if (!run || run.glyphs.length === 0) return;
    const mode = this.tosMode;
    let dofill = mode === 0 || mode === 2 || mode === 4 || mode === 6;
    let dostroke = mode === 1 || mode === 2 || mode === 5 || mode === 6;
    const doinvisible = mode === 3;
    if (this.hidden > 0) dofill = dostroke = false;
    const glyphs = run.glyphs;
    if (doinvisible) this.arrive('ignore', glyphs);
    const gs = this.gs;
    const box = glyphs.reduce<Rect4>(
      (b, g) => [
        Math.min(b[0], g.box[0]),
        Math.min(b[1], g.box[1]),
        Math.max(b[2], g.box[2]),
        Math.max(b[3], g.box[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    const fillColor = dofill && gs.fill.kind === 'color';
    const strokeColor = dostroke && gs.stroke.kind === 'color';
    if (fillColor && strokeColor) {
      this.arrive('fill+stroke', glyphs);
      return;
    }
    if (dofill) this.textMaterial(run, 'fill', 'fill', 'clip', box);
    if (dostroke) this.textMaterial(run, 'stroke', 'stroke', 'clip-stroke', box);
  }

  private textMaterial(
    run: PendingRun,
    what: 'fill' | 'stroke',
    direct: Arrival,
    viaClip: Arrival,
    box: Rect4,
  ): void {
    const m = this.gs[what];
    if (m.kind === 'color') this.arrive(direct, run.glyphs);
    else if (m.kind === 'shade') {
      this.arrive(viaClip, run.glyphs);
      this.paint(run.owner);
    } else if (m.pattern) {
      this.arrive(viaClip, run.glyphs);
      this.showPattern(m, box, what, run.owner);
    }
  }

  /** Flushes the clip accumulation at ET (MuPDF pdf_flush_clip_text). */
  private flushClipText(): void {
    const glyphs = this.clipAccum;
    this.clipAccum = null;
    if (!glyphs || glyphs.length === 0) return;
    const mode = this.tosMode;
    if (mode === 3) this.arrive('ignore', glyphs);
    if (mode >= 4 && mode <= 7) {
      this.arrive('clip', glyphs);
      this.gs.clipDepth++;
      this.gs.clipRect = null;
    }
  }

  /** Glyph arrival → counting policy. For an arrival that receives a number, recomputes the origin with the CTM at that time. */
  private arrive(kind: Arrival, glyphs: readonly GlyphRef[]): void {
    this.options.trace?.push(
      `${kind}:${glyphs.length}:${glyphs.map((g) => (g.counted ? 'R' : 'N')).join('')}`,
    );
    const policy = this.options.policy;
    if (policy === 'no-clip' && (kind === 'clip' || kind === 'clip-stroke')) return;
    for (const g of glyphs) {
      if (g.counted) {
        if (policy === 'no-clip') this.glyphCounter++;
        continue;
      }
      g.counted = true;
      const seq = this.glyphCounter++;
      if (g.glyph) {
        g.glyph.seq = seq;
        // MuPDF sends the text object with the CTM at flush time (Q before ET resend, execution unit crossing a Form boundary).
        g.glyph.origin = apply(this.deviceCtm(), g.trm[4], g.trm[5]);
      }
    }
  }

  // ---- Images and XObjects ----

  private imagePaints(rec: SourceOp | null, isMask: boolean, hasMask: boolean, bbox: Rect4): void {
    if (this.hidden > 0) return;
    if (isMask) {
      // Mask without a color space: painted with the fill material (MuPDF pdf_show_image_imp).
      const m = this.gs.fill;
      if (m.kind === 'color') this.paint(rec);
      else if (m.kind === 'shade') {
        this.paint(rec);
        this.paint(rec);
      } else if (m.pattern) {
        this.paint(rec);
        this.showPattern(m, bbox, 'fill', rec);
      }
      return;
    }
    if (hasMask) this.paint(rec);
    this.paint(rec);
  }

  private inlineImage(_ctx: ExecCtx, rec: SourceOp | null, op: ContentOp): void {
    const e = inlineImageEntries(op.inlineDict ?? []);
    const isMask = e.get('ImageMask')?.[0]?.value === 'true';
    this.imagePaints(rec, isMask, false, transformRect([0, 0, 1, 1], this.deviceCtm()));
  }

  private execDo(ctx: ExecCtx, rec: SourceOp | null, op: ContentOp, o: Operands): void {
    const name = o.names[0];
    if (name === undefined) return;
    const nameTok = op.operands.find((t) => t.kind === 'name');
    const seg = this.segmentAt(ctx, op.start);
    const segIndex = ctx.segments.indexOf(seg);
    const doOrdinal = ctx.doOrdinals[segIndex] ?? 0;
    ctx.doOrdinals[segIndex] = doOrdinal + 1;
    const xobj = this.resource(ctx, 'XObject', name);
    if (!xobj) return;
    let subtype = xobj.get('Subtype');
    if (subtype.isName() && subtype.asName() === 'Form') {
      const st2 = xobj.get('Subtype2');
      if (st2.isName()) subtype = st2;
    }
    if (!subtype.isName()) return;
    const oc = xobj.get('OC');
    if (!oc.isNull() && this.oc.isHidden(oc)) return;
    const kind = subtype.asName();
    if (kind === 'Image') {
      // Image: only get() on an indirect reference (resolve() is forbidden).
      const im = xobj.get('ImageMask');
      const isMask = im.isBoolean() && im.asBoolean();
      const hasMask = !xobj.get('SMask').isNull() || xobj.get('Mask').isStream();
      if (!oc.isNull() && rec) this.addLimit(rec, 'optional-content');
      this.imagePaints(rec, isMask, hasMask, transformRect([0, 0, 1, 1], this.deviceCtm()));
      return;
    }
    if (kind !== 'Form') return;
    const number = objNum(xobj);
    const step: FormStep = {
      resourceName: name,
      doOrdinal,
      objectNumber: number ?? 0,
      stream: seg.ref,
      nameRange: nameTok
        ? [nameTok.start - seg.start, Math.min(nameTok.end, seg.end) - seg.start]
        : [0, 0],
      ctm: [...this.gs.ctm],
    };
    const formPath = [...ctx.formPath, step];
    // Cycle: MuPDF does not execute it either (no BBox clip). Depth limit: same condition as the xobject.ts index.
    if (number !== null && this.activeForms.has(number)) {
      if (rec) this.addLimit(rec, 'form-depth-exceeded');
      return;
    }
    if (formPath.length >= this.options.maxFormDepth) {
      if (rec) this.addLimit(rec, 'form-depth-exceeded');
      return;
    }
    const matrix = (numberArray(xobj.get('Matrix'), 6) ?? [...IDENTITY]) as Matrix;
    const ownRes = xobj.get('Resources');
    const savedGs = this.gs;
    const savedStack = this.gstack;
    // MuPDF keeps a separate marked content stack per Form (the hidden counter is shared). MCID is inherited from the outer one.
    const savedMarked = [...this.marked];
    this.gs = cloneGs(savedGs);
    this.gstack = [];
    this.gs.ctm = concat(matrix, this.gs.ctm);
    // BBox clip: consumes the in-progress path, as in pdf_show_path(clip).
    this.pathBuf = newPath();
    this.pathRight = true;
    this.pendingClip = null;
    this.gs.clipDepth++;
    const bbox = numberArray(xobj.get('BBox'), 4);
    const dev = this.deviceCtm();
    this.gs.clipRect =
      bbox && axisAligned(dev)
        ? intersectRect(
            this.gs.clipRect,
            transformRect(
              [
                Math.min(bbox[0]!, bbox[2]!),
                Math.min(bbox[1]!, bbox[3]!),
                Math.max(bbox[0]!, bbox[2]!),
                Math.max(bbox[1]!, bbox[3]!),
              ],
              dev,
            ),
          )
        : null;
    const savedInText = this.inText;
    this.inText = false;
    this.paint(rec);
    const bytes = readStreamBytes(xobj);
    const ref: ContentStreamRef = { objectNumber: number ?? 0, contentsIndex: null };
    if (ctx.owned && number !== null && !this.streamSeen.has(number)) {
      this.streamSeen.add(number);
      this.streams.push({ ...ref, decodedLength: bytes.byteLength, filters: filtersOf(xobj) });
    }
    if (number !== null) this.activeForms.add(number);
    const sp = xobj.get('StructParents');
    const sp1 = xobj.get('StructParent');
    this.exec({
      bytes,
      segments: [{ start: 0, end: bytes.byteLength, ref }],
      resources: ownRes.isNull() ? ctx.resources : [ownRes, ...ctx.resources],
      formPath: ctx.owned ? formPath : [],
      owned: ctx.owned,
      parentCtm: [...this.gs.ctm],
      inheritsResources: ctx.inheritsResources || ownRes.isNull(),
      structParents: ctx.structParents || !sp.isNull() || !sp1.isNull(),
      formOC: ctx.formOC || !oc.isNull(),
      doOrdinals: [0],
      depth: ctx.depth + 1,
      opIds: [],
    });
    if (number !== null) this.activeForms.delete(number);
    this.gs = savedGs;
    this.gstack = savedStack;
    this.marked = savedMarked;
    this.markedSnap = null;
    this.inText = savedInText;
  }
}

/** Body of buildSourceMap. The counting policy can be specified (for tests and policy comparison, not exported from the package index). */
export function buildSourceMapImpl(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  maxFormDepth: number,
  policy: GlyphSeqPolicy,
  trace?: string[],
): SourceMap {
  const t0 = now();
  const r = new ContentInterpreter(doc, pageIndex, {
    maxFormDepth,
    policy,
    ...(trace ? { trace } : {}),
  }).interpret();
  return {
    pageIndex,
    userToPage: r.userToPage,
    streams: r.streams,
    ops: r.ops,
    glyphCount: r.glyphCount,
    paintCount: r.paintCount,
    errors: r.errors,
    buildMs: now() - t0,
  };
}
