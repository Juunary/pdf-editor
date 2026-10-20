/**
 * 벡터 패스 편집(M4, docs/m4-contract.md 4.2·4.3·D2·D3·D4).
 *
 * 편집 단위는 칠하기 연산 하나(`S s f F f* B B* b b*`)다. 구성 연산(`m l c v y re h`)은 인터프리터가 채운
 * `SourceOp.pathOps` 로 찾는다. 쓰기는 스트림마다 원본 바이트 기준 교체 목록 하나로 한다(M3 D2 와 같음).
 *
 * - 기하: 구성 연산 숫자 피연산자를 콘텐츠 공간 좌표로 다시 쓴다(`cm` 을 덧씌우지 않음). `re` 는 결과가 축 정렬
 *   직사각형이면 `re` 그대로, 아니면 `m l l l h`.
 * - 속성: 첫 구성 연산 앞에 `q` + 색·`w`, 칠하기 연산 뒤에 `Q`. 구성 ~ 칠하기 사이에는 넣지 않는다.
 * - 삭제: 구성 연산 ~ 칠하기 연산을 `n` 하나로 바꾼다.
 * - Form 안 패스는 사용 경로(상위 체인 포함)를 복제해 이 사용 위치만 바꾼다. 같은 체인의 여러 패스는 복제본 하나를
 *   같이 쓴다. 공유 /Contents 는 사본.
 *
 * 점 번호(PathEdit.points)는 PageModel PathInfo.segments 순서다. 구성 연산과의 대응: `m`·`l` 점 1개, `c` 3개,
 * `v` 3개(첫 점은 현재점, 피연산자 없음), `y` 3개(셋째 = 둘째 피연산자), `re` 4개(MuPDF fz_rectto 순서:
 * (x,y)·(x+w,y)·(x+w,y+h)·(x,y+h) + 닫기), `h` 0개. 모델에 세그먼트가 있으면 이 대응을 세그먼트와 대조한다.
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

/** 패스 편집이 바꾸는 객체 번호 목록을 담은 준비 결과. */
export interface PreparedPathEdit {
  editId: string;
  target: PathTarget;
  /** 이 편집이 바꾸는 스트림 객체 번호. */
  changedObjects: number[];
}

// ---------------------------------------------------------------- 판정(4.2)

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

/** 구성 연산 하나. nums 는 준비(preparePathEdit) 때 읽는다(판정은 문법만 검사, 쪽 판정 시간 4.2). */
interface Construct {
  op: SourceOp;
  nums: number[];
}

/** 칠하기 연산 하나의 판정. */
interface PathItem {
  op: SourceOp;
  /** 구성 연산(실행 순서). */
  constructs: SourceOp[];
  /** PageModel.paths 인덱스(이 연산에 연결된 것 전부). */
  infos: number[];
  /** 대표 PathInfo(첫 fill·stroke, 없으면 첫 항목). */
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
 * PDF 숫자 토큰([+-]? 숫자 [. 숫자], 또는 [+-]? . 숫자). 아니면 NaN. 정수는 직접, 소수는 Number(십진 표기).
 * values 가 false 면 문법만 보고 0 을 돌려준다.
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
 * 구성 연산의 숫자 피연산자. 인터프리터가 채운 operandRanges(숫자·이름 토큰)로 바로 읽는다: 토큰 수 = 피연산자 수,
 * 첫 토큰이 연산 시작, 토큰 사이·마지막 토큰과 연산자 사이는 공백뿐, 모두 숫자. operandRanges 가 없으면 토큰 분리.
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

/** 쪽의 칠하기 연산 판정(SourceMap 별로 한 번). */
function analyzePage(ctx: ParagraphEditContext): PageAnalysis {
  const cached = analyses.get(ctx.map);
  if (cached) return cached;
  const ops = ctx.map.ops;
  const streams = new StreamCache(ctx.doc);
  // 칠하기 연산 → 연결된 PathInfo(PageModel.paths 는 paintSeq 순이라 연산별로 모인다).
  const infosOf = new Map<number, number[]>();
  const pathOp = ctx.linkage.pathOp;
  for (let i = 0; i < pathOp.length; i++) {
    const opId = pathOp[i]!;
    if (opId < 0) continue;
    const l = infosOf.get(opId);
    if (l) l.push(i);
    else infosOf.set(opId, [i]);
  }
  // BT 안 여부. 같은 콘텐츠 실행의 연산은 formPath 배열을 공유하므로 배열 자체를 키로 쓴다.
  const inText = new Uint8Array(ops.length);
  const textState = new Map<readonly FormStep[], boolean>();
  for (const o of ops) {
    if (o.op === 'BT') textState.set(o.formPath, true);
    else if (o.op === 'ET') textState.set(o.formPath, false);
    else if (o.kind === 'path-paint' && textState.get(o.formPath) === true) inText[o.id] = 1;
  }
  // 효력 있는 SMask: 뒤의 gs 가 이긴다. extGStateOps 배열은 실행 지점마다 하나라 마지막 gs id 로 결과를 기억한다
  // (gs 가 많은 쪽에서 칠하기마다 배열 전체를 다시 훑지 않게).
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
  // PathInfo 가 연결된 칠하기 연산만(연산 id 순 = paintSeq 순).
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
    // 패턴 칠하기도 MuPDF 는 clip + 내용으로 보내므로 클립 PathInfo 는 패턴이 아닐 때만 클립 사유다.
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

/** 53비트 해시(cyrb53) 16진. */
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

/** 지문 비교(상자는 반올림 경계 흔들림을 2e-3 까지 허용). */
export function sameFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return (
    a.paintOp === b.paintOp &&
    a.constructOpCount === b.constructOpCount &&
    a.constructHash === b.constructHash &&
    a.bbox.every((v, i) => Math.abs(v - b.bbox[i]!) <= 2e-3)
  );
}

/** 쪽의 모든 패스 판정(PageModel.paths 순서). */
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

/** paintSeq 들이 가리키는 판정 항목(중복 제거, 입력 순서). 없는 번호는 예외. */
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

/** Form 객체 번호를 이 쪽에서 Do 로 쓰는 횟수. */
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
      return !f.get('StructParents').isNull() || !f.get('StructParent').isNull();
    }),
  );
  if (tagged.length > 0) {
    warnings.push({
      kind: 'tagged-structure-unlinked',
      message:
        'Form 을 복제하면서 /StructParents 를 지웁니다. 태그 PDF 구조와 이 위치의 연결이 끊깁니다.',
      rects: tagged,
    });
  }
  return warnings;
}

/** 다른 쪽 Resources /XObject 에서 같은 Form 을 가리키는 쪽 수(+ 이 쪽). */
const pageUseCache = new WeakMap<mupdf.PDFDocument, Map<number, number>>();
function pageUses(ctx: ParagraphEditContext, step: FormStep): number {
  let m = pageUseCache.get(ctx.doc);
  if (!m) {
    m = new Map();
    pageUseCache.set(ctx.doc, m);
  }
  const hit = m.get(step.objectNumber);
  if (hit !== undefined) return hit;
  let n = 0;
  const pages = ctx.doc.countPages();
  for (let i = 0; i < pages; i++) {
    const xo = ctx.doc.findPage(i).getInheritable('Resources');
    const dict = xo.isNull() ? xo : xo.get('XObject');
    if (dict.isNull() || !dict.isDictionary()) continue;
    let used = false;
    dict.forEach((v) => {
      if (v.isIndirect() && v.asIndirect() === step.objectNumber) used = true;
    });
    if (used) n++;
  }
  m.set(step.objectNumber, n);
  return n;
}

function paintColorOf(ctx: ParagraphEditContext, it: PathItem, op: 'fill' | 'stroke') {
  const i = it.infos.find((k) => ctx.model.paths[k]!.op === op);
  return i === undefined ? null : ctx.model.paths[i]!;
}

/** 경로 공간 선 두께 → 페이지 공간 pt(√|det|, MuPDF fz_matrix_expansion). */
const expansion = (m: Matrix) => Math.sqrt(Math.abs(determinant(m)));

/** 선택한 패스의 편집 계획. revision 은 호출자가 채운다. */
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

// ---------------------------------------------------------------- 점 대응표(D4)

/** 점 하나의 출처: 구성 연산 번호와 그 안 점 번호. implicit = v 의 첫 점(현재점). */
export interface PointSlot {
  construct: number;
  k: number;
}

/** 구성 연산 → 점 목록(콘텐츠 공간)과 MuPDF 세그먼트(대조용). */
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

/** 세그먼트 목록의 점(PathEdit.points 번호 순서). */
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

/** 점 목록으로 구성 연산 텍스트를 다시 만든다. changed 가 false 인 연산은 null(원 바이트 유지). */
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
        // 첫 제어점이 (새) 현재점과 같으면 v 그대로, 아니면 c.
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

// ---------------------------------------------------------------- 쓰기(4.3·D3·D4)

/** 쓰기 대상 스트림(쪽 /Contents 칸 또는 Form 복제본). */
interface Holder {
  key: string;
  orig: Uint8Array;
  write(bytes: Uint8Array): void;
  /** Do 이름 교체 등 편집과 무관한 고정 교체. */
  fixed: Replacement[];
  /** Form 복제본의 Resources(자식 복제본 등록용). 쪽은 null(쪽 Resources 를 쓴다). */
  res: mupdf.PDFObject | null;
}

interface PreparedItem {
  holder: string;
  constructs: Construct[];
  paint: SourceOp;
  toPage: Matrix;
  bbox: Rect;
  /** 구성 점의 페이지 공간 상자(선 폭 제외). 칠한 상자와의 차이가 선 폭 여백이다. */
  pointsBox: Rect;
  pathIndex: number;
  fill: PaintColor | null;
  stroke: PaintColor | null;
  /** 경로 공간 선 두께(stroke 계열만). */
  lineWidth: number | null;
  clipRect: Rect | null;
  /** 모델 세그먼트(있으면 점 번호 대조용). */
  segments: PathSegment[] | null;
}

interface PreparedState {
  editId: string;
  holders: Map<string, Holder>;
  items: PreparedItem[];
  tables: Rect[];
  warnings: EditWarning[];
}

const prepared = new WeakMap<mupdf.PDFDocument, Map<string, PreparedState>>();

function stateOf(doc: mupdf.PDFDocument, editId: string): PreparedState {
  const s = prepared.get(doc)?.get(editId);
  if (!s) throw new Error(`preparePathEdit 결과 없음: ${editId}`);
  return s;
}

/** 편집 준비(필요하면 Form 복제 등). 저널 작업 안에서 호출한다. */
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
      write: (b) => doc.newIndirect(target).writeStream(b),
      fixed: [],
      res: null,
    };
    holders.set(key, h);
    return h;
  };
  const holderOfStream = (s: ContentStreamRef, path: readonly FormStep[]): Holder =>
    s.contentsIndex !== null ? slotHolder(s) : formHolder(path);
  /** 사용 경로 path(길이 ≥ 1)의 가장 안쪽 Form 복제본. 같은 경로 접두는 복제본 하나. */
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
    const res = ownResources(doc, clone, null);
    changed.add(clone.asIndirect());
    const parentRes = parent.res ?? ownPageRes();
    const name = putUniqueResource(ownSubdict(doc, parentRes, 'XObject'), clone, 'PEF');
    parent.fixed.push({ start: step.nameRange[0], end: step.nameRange[1], text: `/${name}` });
    h = {
      key,
      orig: streams.get(step.objectNumber).slice(),
      write: (b) => clone.writeStream(b),
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
      fill: fill?.color ?? null,
      stroke: stroke?.color ?? null,
      lineWidth: stroke?.lineWidth ?? null,
      clipRect: clip ? ([...clip] as Rect) : null,
      segments: info?.segments ?? null,
    };
  });
  // 복제본은 빈 스트림으로 만들었으므로 고정 교체만으로 한 번 쓴다.
  for (const h of holders.values()) h.write(applyReplacements(h.orig, h.fixed));

  let map = prepared.get(doc);
  if (!map) {
    map = new Map();
    prepared.set(doc, map);
  }
  map.set(editId, {
    editId,
    holders,
    items: pItems,
    tables: ctx.layout.tables.filter((t) => t.strategy === 'lines').map((t) => [...t.bbox] as Rect),
    warnings: [],
  });
  return {
    editId,
    target: plan.target,
    changedObjects: [...changed].sort((a, b) => a - b),
  };
}

/** 8비트 반올림 비교(D3: 같으면 그 채널은 쓰지 않음). */
const same8 = (a: RGB, b: RGB | null) =>
  b !== null && a.every((v, i) => Math.round(v * 255) === Math.round(b[i]! * 255));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 새 색 연산(D3). 원래 색공간 계열의 Device 공간, 표현할 수 없으면 DeviceRGB + 경고. */
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

/** 페이지 공간 아핀 transform 이 이동·확대축소만인지. */
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
      reps: [{ start: first.range[0], end: paint.range[1], text: 'n' }],
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

  // 속성.
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

  // 새 상자: 점 상자 + 원래 선 폭 여백(두께 비율 반영).
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

/** 패스 편집을 스트림에 쓴다. 같은 초안에서 반복 호출할 수 있다. */
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
  const single = st.items.length === 1;
  for (const it of st.items) {
    const r = itemReplacements(it, edit, single);
    const l = lists.get(it.holder) ?? [];
    l.push(...r.reps);
    lists.set(it.holder, l);
    bbox = union(bbox, r.bbox);
    if (r.spaceChanged) spaceRects.push(r.bbox);
    if (!edit.delete && it.clipRect && !inside(r.bbox, it.clipRect)) clipped.push(r.bbox);
    if (edit.delete && st.tables.some((t) => intersectsArea(it.bbox, t))) ruleRects.push(it.bbox);
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
  st.warnings = warnings;
  return { bbox: bbox ?? prepared.target.bbox, writeMs: now() - t0 };
}

/** 겹침(1pt 여유, 폭 0 선 포함). */
const intersectsArea = (a: Rect, b: Rect) =>
  a[0] <= b[2] + 1 && a[2] >= b[0] - 1 && a[1] <= b[3] + 1 && a[3] >= b[1] - 1;

/**
 * 마지막 writePathEdit 의 편집 경고(`color-space-changed`·`path-clipped`·`table-rule-removed`). 계획 경고
 * (PathEditPlan.warnings)는 포함하지 않는다. writePathEdit 의 반환 시그니처가 고정이라 따로 둔다.
 */
export function pathEditWarnings(
  ctx: ParagraphEditContext,
  prepared: PreparedPathEdit,
): EditWarning[] {
  return stateOf(ctx.doc, prepared.editId).warnings.map((w) => ({ ...w, rects: [...w.rects] }));
}
