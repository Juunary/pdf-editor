/**
 * 콘텐츠 스트림 인터프리터(PLAN.md 3.4, docs/m1-contract.md 3절·5.1절).
 *
 * MuPDF 1.28 pdf-op-run.c 의 Device 전달 동작을 에뮬레이션해 연산마다 바이트 범위·상태·글리프 원점과
 * glyphSeq·paintSeq 를 기록한다. 전달 시점 모델(docs/m1-pdf-ops.md 3.1):
 * - 텍스트는 "실행 단위"(같은 tos 모드의 연속 글리프)로 모였다가 플러시 시점(색·선 상태·gs·Q·cm·W·ET·
 *   marked content·페이지 끝, 다음 글리프의 Tr 변경)에 Device 로 간다. Tr 4–7 글리프는 클립 누적에도 들어가
 *   ET 에서 다시 간다(ET 재전송: 마지막 실행 단위 모드가 4–7 이면 clip, 3 이면 ignore, 그 밖은 없음).
 * - 글리프마다 도착(fill·stroke·fill+stroke·ignore·clip·clip-stroke)을 기록하고, 계수 정책
 *   (GlyphSeqPolicy)이 도착 → glyphSeq 를 정한다. 정책 전환은 상수 1개다.
 * - 칠하기 콜백(paintSeq)은 계약 3절 paintSeq 표를 따른다. 타일링 패턴은 MuPDF 와 같은 조건으로
 *   beginTile 경로(셀 미계수)와 직접 실행 경로(셀 내용을 타일 수만큼 번호만 소비)를 가른다.
 * - 이미지 XObject 는 간접 참조에서 get() 만 쓴다(resolve() 금지, PLAN.md 7절 리스크 7).
 */
import type * as mupdf from 'mupdf';
import type {
  SourceMap,
  ContentStreamInfo,
  ContentStreamRef,
  EditLimitReason,
  FormStep,
  Matrix,
  Point,
  SourceGlyph,
  SourceMapError,
  SourceOp,
  SourceOpKind,
} from '@pdf-editor/shared-types';
import {
  decodeStringToken,
  inlineImageEntries,
  parseContentOpsLenient,
  type ContentOp,
  type Token,
} from './content-stream.js';
import { now } from './clock.js';
import { pageTransform, readStreamBytes } from './mupdf-util.js';
import { OptionalContent } from './optional-content.js';
import { FontCache, type PdfFont } from './pdf-fonts.js';
import { loadType3, T3_COLOR, T3_UNCACHEABLE, type Type3Font, type Type3Glyph } from './type3.js';

/**
 * glyphSeq 계수 정책(계약 3.1 결정 대기).
 * - first-arrival: 글리프가 Device 에 처음 도착할 때 센다(pdf-ops 안 A).
 * - no-clip: clipText·clipStrokeText 도착은 세지 않는다. 그 밖의 도착은 모두 센다(core 안 A).
 *   이미 번호가 있는 글리프가 다시 세어지면(ET ignore 재전송) 그 번호는 소유 글리프 없이 소비된다.
 */
export type GlyphSeqPolicy = 'first-arrival' | 'no-clip';
export const GLYPH_SEQ_POLICY: GlyphSeqPolicy = 'first-arrival';

export interface InterpretOptions {
  maxFormDepth: number;
  policy: GlyphSeqPolicy;
  /** 테스트용: Device 전달 순서 추적(텍스트 도착 `종류:글리프 수`, 칠하기 `P`). */
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

/** 연산자 실행 시 텍스트 실행 단위를 플러시하는 연산(MuPDF pdf_flush_text 호출 위치). */
const FLUSHING = new Set(
  'CS cs SC SCN sc scn G g RG rg K k w j J M d ri Q cm W W* BMC BDC EMC MP DP'.split(' '),
);

interface TilingPattern {
  /** PaintType 2(색 없는 패턴). 셀 안에서 채움·선 재질을 모두 해제한다. */
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
  /** kind = pattern 일 때 설정된 타일링 패턴(없으면 칠하지 않음). */
  pattern: TilingPattern | null;
  /** 패턴 기준 행렬: 설정 시점 상위 콘텐츠 시작 CTM(콘텐츠 → 사용자 공간). */
  base: Matrix;
}

interface GState {
  ctm: Matrix;
  clipDepth: number;
  font: PdfFont | null;
  /** Tf 리소스가 없거나 MuPDF 가 로드하지 못해 hail-mary 글꼴로 대체됨. */
  fontFallback: boolean;
  /** Type3 폰트면 글리프 준비 결과(직접 실행 판정용). */
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
}

const cloneGs = (g: GState): GState => ({
  ...g,
  fill: { ...g.fill },
  stroke: { ...g.stroke },
});

/** 글리프 1개(또는 소유 없는 계수용 글리프). */
interface GlyphRef {
  glyph: SourceGlyph | null;
  op: SourceOp | null;
  counted: boolean;
  /** 텍스트 공간 → 콘텐츠 공간 글리프 행렬(MuPDF fz_text 의 trm). 원점은 도착 시점 CTM 으로 계산한다. */
  trm: Matrix;
  /** 디바이스 공간 근사 경계(타일링 패턴 텍스트 판정용). */
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
  /** 리소스 체인(안쪽 먼저). MuPDF pdf_lookup_resource 는 바깥 콘텐츠 리소스까지 찾는다. */
  resources: mupdf.PDFObject[];
  formPath: FormStep[];
  /** false = 패턴 셀 등 계수 전용(연산 기록 없음). */
  owned: boolean;
  /** 이 콘텐츠 시작 시 CTM(패턴 기준). */
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

/** 널 객체에서도 안전한 get(mupdf 의 null PDFObject 는 get 을 부를 수 없다). */
const at = (o: mupdf.PDFObject, key: string) => (o.isNull() ? o : o.get(key));

/** 토큰 목록에서 MuPDF 식 피연산자: 최상위 숫자(앞에서부터), 이름(첫째·둘째), 마지막 문자열, 마지막 배열·사전. */
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

/** 사전 토큰에서 /key 다음 숫자. */
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
  /** MuPDF tos.text_mode: 마지막 실행 단위 모드(Type3 보정 포함). */
  private tosMode = 0;
  private clipAccum: GlyphRef[] | null = null;
  private hidden = 0;
  private marked: { mcid: number | null; oc: boolean }[] = [];
  /**
   * 진행 중 경로(콘텐츠 공간): [0,x,y] 이동, [1,x,y] 선, [2,x1,y1,x2,y2,x3,y3] 곡선, [3] 닫기.
   * pathRight = MuPDF only_right_angles(생성 시 판정).
   */
  private pathCmds: number[][] = [];
  private pathRight = true;
  private pathCur: Point = [0, 0];
  private pendingClip: { owner: SourceOp | null } | null = null;
  private readonly activeForms = new Set<number>();
  private readonly fonts: FontCache;
  private readonly oc: OptionalContent;
  private readonly userToPage: Matrix;
  private aborted = false;
  private patternDepth = 0;
  /** 직접 실행 중인 패턴 셀·Type3 글리프의 소유 연산(바깥 기준). */
  private cellOwner: SourceOp | null = null;
  /**
   * MuPDF 장치 MASK 플래그(d1 이 켠다). 켜진 동안 색 연산은 색도 바꾸지 않고 텍스트도 플러시하지 않는다
   * (pdf_run_cs 등의 MASK 검사). Type3 직접 실행 뒤에는 MuPDF 가 장치 플래그를 되돌리므로 글리프 프로시저 안에서만
   * 유효하다. 페이지 콘텐츠의 d1(비표준)은 페이지 끝까지 남는다.
   */
  private deviceMask = false;
  private readonly type3Cache = new Map<number, Type3Font>();
  private readonly type3Running = new Set<Type3Font>();
  /** 실행 중인 콘텐츠(지연 플러시의 패턴 리소스 체인용). */
  private cur: ExecCtx | null = null;

  constructor(
    private readonly doc: mupdf.PDFDocument,
    private readonly pageIndex: number,
    private readonly options: InterpretOptions,
  ) {
    this.fonts = new FontCache(doc);
    this.oc = new OptionalContent(doc);
    this.userToPage = pageTransform(doc, pageIndex);
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
    // MuPDF 는 /Contents 배열을 공백(0x20) 1바이트로 이어 붙여 한 스트림처럼 해석한다(fz_open_concat pad).
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
      if (seqs.length > 0) op.glyphSeq = [Math.min(...seqs), Math.max(...seqs) + 1];
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

  // ---- 실행 ----

  private exec(ctx: ExecCtx): void {
    const { ops, error } = parseContentOpsLenient(ctx.bytes);
    const prev = this.cur;
    this.cur = ctx;
    for (const op of ops) {
      if (this.aborted) break;
      this.execOp(ctx, op);
    }
    // 콘텐츠 끝(MuPDF pdf_process_end → op_END): 실행 단위만 플러시한다. 클립 누적은 남는다.
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
    };
    if (op.end > seg.end) this.addLimit(rec, 'spans-stream-boundary');
    if (ctx.inheritsResources) this.addLimit(rec, 'form-inherits-resources');
    if (rec.mcids.length > 0 || ctx.structParents) this.addLimit(rec, 'tagged-content');
    if (rec.optionalContent) this.addLimit(rec, 'optional-content');
    this.ops.push(rec);
    ctx.opIds.push(rec.id);
    return rec;
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
    switch (op.op) {
      // 그래픽 상태
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
          // MuPDF: 클립 텍스트 누적 중 CTM 변경은 예외로 페이지 해석을 끝낸다.
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
        break;
      case 'j':
        gs.lineJoin = Math.min(2, Math.max(0, Math.trunc(num(o, 0))));
        break;
      case 'M':
        gs.miterLimit = num(o, 0);
        break;
      case 'gs':
        this.execGs(ctx, o.names[0]);
        break;
      // 경로
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
        // MuPDF fz_rectto: 이동 + 선 3개 + 닫기.
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
      // 텍스트
      case 'BT':
        this.tm = [...IDENTITY];
        this.tlm = [...IDENTITY];
        break;
      case 'ET':
        this.flushText();
        this.flushClipText();
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
      // 색
      case 'CS':
      case 'cs':
        this.setColorSpace(ctx, op.op === 'cs' ? gs.fill : gs.stroke, o.names[0] ?? '');
        break;
      case 'SC':
      case 'sc':
      case 'SCN':
      case 'scn':
        this.setColor(ctx, op.op === 'sc' || op.op === 'scn' ? gs.fill : gs.stroke, o.names[0]);
        break;
      case 'G':
      case 'RG':
      case 'K':
        this.setColorSpace(ctx, gs.stroke, 'DeviceColor');
        break;
      case 'g':
      case 'rg':
      case 'k':
        this.setColorSpace(ctx, gs.fill, 'DeviceColor');
        break;
      // 이미지·셰이드·XObject
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
        this.marked.push({ mcid: null, oc: false });
        if (this.hidden > 0) this.hidden++;
        break;
      case 'BDC':
        this.beginMarked(ctx, o);
        break;
      case 'EMC':
        this.marked.pop();
        if (this.hidden > 0) this.hidden--;
        break;
      default:
        break;
    }
  }

  private execGs(ctx: ExecCtx, name: string | undefined): void {
    if (!name) return;
    const g = this.resource(ctx, 'ExtGState', name);
    if (!g || !g.isDictionary()) return;
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
  }

  private beginMarked(ctx: ExecCtx, o: Operands): void {
    const tag = o.names[0] ?? '';
    let props: mupdf.PDFObject | null = null;
    if (o.names[1] !== undefined) props = this.resource(ctx, 'Properties', o.names[1]);
    let mcid: number | null = null;
    if (o.dict) mcid = dictNumber(o.dict, 'MCID');
    else if (props) {
      const m = props.get('MCID');
      if (m.isNumber()) mcid = m.asNumber();
    }
    const isOC = tag === 'OC';
    this.marked.push({ mcid, oc: isOC });
    if (this.hidden > 0) {
      this.hidden++;
      return;
    }
    if (isOC && props && this.oc.isHidden(props)) this.hidden++;
  }

  // ---- 경로 ----

  private pathCmd(cmd: number[]): void {
    if (cmd[0] === 2) this.pathRight = false;
    this.pathCmds.push(cmd);
    if (cmd[0] === 3) {
      const move = [...this.pathCmds].reverse().find((c) => c[0] === 0);
      if (move) this.pathCur = [move[1]!, move[2]!];
    } else this.pathCur = [cmd.at(-2)!, cmd.at(-1)!];
  }

  /**
   * 진행 중 경로의 디바이스 공간 경계와 직각 경로 여부(MuPDF fz_bound_path)를 구하고 경로를 비운다.
   * 직각 CTM 이면 경로 공간 경계를 변환하고 생성 시 판정을 쓴다. 그 밖은 변환한 선분으로 다시 판정한다
   * (축 정렬 허용치 0.001, 곡선은 직각 아님, 끝의 이동은 무시).
   */
  private takePath(dev: Matrix): { box: Rect4; right: boolean; empty: boolean } {
    const cmds = this.pathCmds;
    const constructionRight = this.pathRight;
    this.pathCmds = [];
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
    const dev = this.deviceCtm();
    const path = this.takePath(dev);
    let bbox = path.box;
    if (dostroke && !path.empty) bbox = this.expandForStroke(bbox, dev, path.right);
    if (this.hidden > 0) dofill = dostroke = false;
    if (dofill) this.paintMaterial(rec, 'fill', bbox);
    if (dostroke) this.paintMaterial(rec, 'stroke', bbox);
    if (this.pendingClip) {
      gs.clipDepth++;
      this.paint(this.pendingClip.owner ?? rec);
      this.pendingClip = null;
    }
  }

  /** MuPDF adjust_rect_for_stroke: 반폭 확장, 직각 경로·퇴화 사각형은 마이터 제외. */
  private expandForStroke(r: Rect4, dev: Matrix, rightAngles: boolean): Rect4 {
    let e = this.gs.lineWidth / 2 || 0.5;
    const degenerate = r[2] === r[0] || r[3] === r[1];
    if (!degenerate && !rightAngles && this.gs.lineJoin === 0 && this.gs.miterLimit > 0.5) {
      e *= this.gs.miterLimit * 2;
    }
    e *= maxExpansion(dev);
    return [r[0] - e, r[1] - e, r[2] + e, r[3] + e];
  }

  /** 경로 칠하기 재질별 콜백: 색 1, 셰이딩 패턴 clip+fillShade 2, 타일링 clip 1 + 셀(직접 실행 시). */
  private paintMaterial(rec: SourceOp | null, what: 'fill' | 'stroke', bbox: Rect4): void {
    const m = this.gs[what];
    if (m.kind === 'color') {
      this.paint(rec);
    } else if (m.kind === 'shade') {
      this.paint(rec);
      this.paint(rec);
    } else if (m.pattern) {
      // MuPDF: 패턴 칠하기는 알파 0 이면 건너뛴다(경로만).
      if ((what === 'fill' ? this.gs.fillAlpha : this.gs.strokeAlpha) === 0) return;
      this.paint(rec);
      this.showPattern(m, bbox, what, rec);
    }
  }

  private paint(owner: SourceOp | null): void {
    this.options.trace?.push('P');
    const seq = this.paintCounter++;
    // 직접 실행한 패턴 셀 안의 칠하기는 그 패턴 칠하기 연산이 소유한다(계약 수정 3).
    const o = owner ?? this.cellOwner;
    if (o) (o.paintSeq ??= []).push(seq);
  }

  // ---- 패턴 ----

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

  /** MuPDF pdf_show_pattern 의 타일 판정. 직접 실행 경로면 셀 내용을 타일 수만큼 계수 전용으로 실행한다. */
  /** owner: 패턴으로 칠하는 연산(경로 칠하기·텍스트 실행 단위 첫 연산·이미지 마스크). */
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
    // beginTile 경로: core 는 캐시됨(1)을 돌려 셀을 실행시키지 않는다(계약 3절).
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
    // 셀 내용은 페이지 콘텐츠 밖(L4). 칠하기 번호는 owner 가 갖고, 셀 글리프는 소유 없이 번호만 소비한다.
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

  /** 소유 연산 없이 번호만 소비하는 하위 실행(패턴 셀). */
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
    const savedPath = this.pathCmds;
    const savedRight = this.pathRight;
    const savedClip = this.pendingClip;
    this.gs = cloneGs(saved);
    this.gstack = [];
    this.gs.ctm = ctm;
    // MuPDF pdf_show_pattern: 색 있는 패턴은 칠하는 쪽 재질만, 색 없는 패턴은 둘 다 색으로 되돌린다.
    const unset = pat.uncolored ? [this.gs.fill, this.gs.stroke] : [this.gs[what]];
    for (const m of unset) {
      if (m.kind === 'pattern') {
        m.kind = 'color';
        m.pattern = null;
      }
    }
    this.pathCmds = [];
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
    this.pathCmds = savedPath;
    this.pathRight = savedRight;
    this.pendingClip = savedClip;
  }

  // ---- 색 ----

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

  // ---- 텍스트 ----

  private translateLine(tx: number, ty: number): void {
    this.tlm = preTranslate(this.tlm, tx, ty);
    this.tm = [...this.tlm];
  }

  private showText(ctx: ExecCtx, rec: SourceOp | null, op: ContentOp, o: Operands): void {
    const gs = this.gs;
    const tmBefore: Matrix = [...this.tm];
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
      };
      if (gs.render === 3) this.addLimit(rec, 'invisible-text');
      if (gs.render >= 4 && gs.render <= 7) this.addLimit(rec, 'clip-text');
      if (font?.subtype === 'Type3') this.addLimit(rec, 'type3-font');
      if (!font || font.unresolved.length > 0 || gs.fontFallback) {
        this.addLimit(rec, 'font-encoding-unresolved');
      }
    }
    // MuPDF: 폰트가 없으면(Tf 전) 그리지 않는다.
    if (!font) return;
    const items: (Token | number)[] = [];
    if (op.op === 'TJ') {
      // 텍스트 배열: 문자열과 숫자. MuPDF 는 배열 안 Tw·Tc 키워드를 앞 숫자로 실행한다.
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

    // MuPDF pdf_show_char: 실행 단위 플러시, Type3 모드 보정, 캐시 불가 Type3 글리프 직접 실행.
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
    // 색 있는(d0) Type3 글리프는 패턴 색으로 칠하지 않고 직접 실행한다.
    if (t3glyph && t3glyph.flags & T3_COLOR && gs.fill.kind !== 'color') renderDirect = true;
    if (renderDirect && this.tosMode !== 3 && t3 && t3glyph) {
      this.renderType3Direct(rec, t3, t3glyph, trm);
      // 글리프는 추출용으로 보이지 않게(Tr 3) 보낸다.
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
   * 캐시 불가 Type3 글리프의 프로시저를 장치로 직접 실행한다(MuPDF fz_render_t3_glyph_direct → pdf_run_glyph).
   * 새 처리기와 같이 텍스트 객체·숨김·marked content 는 따로 두고, 현재 gstate(색·선 상태)를 이어 받으며 글꼴은
   * 비운다. CTM = FontMatrix × 글리프 trm × CTM. 칠하기 번호는 그 텍스트 연산이 소유하고 outside-page-content(L4).
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
      pathCmds: this.pathCmds,
      pathRight: this.pathRight,
      pathCur: this.pathCur,
      pendingClip: this.pendingClip,
      cellOwner: this.cellOwner,
      deviceMask: this.deviceMask,
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
    this.pathCmds = [];
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
    this.pathCmds = saved.pathCmds;
    this.pathRight = saved.pathRight;
    this.pathCur = saved.pathCur;
    this.pendingClip = saved.pendingClip;
    this.cellOwner = saved.cellOwner;
    // MuPDF pdf_show_char: 직접 실행 전 장치 플래그를 저장했다가 되돌린다.
    this.deviceMask = saved.deviceMask;
  }

  /** 실행 단위 플러시(MuPDF pdf_flush_text). */
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

  /** ET 의 클립 누적 플러시(MuPDF pdf_flush_clip_text). */
  private flushClipText(): void {
    const glyphs = this.clipAccum;
    this.clipAccum = null;
    if (!glyphs || glyphs.length === 0) return;
    const mode = this.tosMode;
    if (mode === 3) this.arrive('ignore', glyphs);
    if (mode >= 4 && mode <= 7) {
      this.arrive('clip', glyphs);
      this.gs.clipDepth++;
    }
  }

  /** 글리프 도착 → 계수 정책. 번호를 받는 도착에서 원점을 그 시점 CTM 으로 다시 계산한다. */
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
        // MuPDF 는 텍스트 객체를 플러시 시점의 CTM 으로 보낸다(ET 재전송 전 Q, Form 경계를 넘는 실행 단위).
        g.glyph.origin = apply(this.deviceCtm(), g.trm[4], g.trm[5]);
      }
    }
  }

  // ---- 이미지·XObject ----

  private imagePaints(rec: SourceOp | null, isMask: boolean, hasMask: boolean, bbox: Rect4): void {
    if (this.hidden > 0) return;
    if (isMask) {
      // 색 공간 없는 마스크: 채움 재질로 칠한다(MuPDF pdf_show_image_imp).
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
      // 이미지: 간접 참조에서 get() 만(resolve() 금지).
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
    // 순환: MuPDF 도 실행하지 않는다(BBox 클립 없음). 깊이 상한: xobject.ts 색인과 같은 조건.
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
    // MuPDF 는 Form 마다 marked content 스택을 따로 둔다(숨김 카운터는 공유). MCID 는 바깥 것을 이어 받는다.
    const savedMarked = [...this.marked];
    this.gs = cloneGs(savedGs);
    this.gstack = [];
    this.gs.ctm = concat(matrix, this.gs.ctm);
    // BBox 클립: pdf_show_path(clip) 와 같이 진행 중 경로를 소비한다.
    this.pathCmds = [];
    this.pathRight = true;
    this.pendingClip = null;
    this.gs.clipDepth++;
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
  }
}

/** buildSourceMap 본체. 계수 정책을 지정할 수 있다(테스트·정책 비교용, 패키지 index 에서 내보내지 않음). */
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
