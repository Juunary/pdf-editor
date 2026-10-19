/**
 * 편집 가능 판정과 제거·삽입 분석(docs/m3-contract.md 5.1·D1·D2·D3). 문서를 바꾸지 않는다.
 *
 * 분석 결과(EditAnalysis)는 판정(planParagraphEdit·planPageEditability)과 적용(prepareParagraphEdit) 이 함께 쓴다.
 * 같은 문서·같은 SourceMap 이면 같은 결과다(적용은 판정을 다시 계산해 쓴다).
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
  ParagraphFormat,
  ParagraphLimit,
  ParagraphLimitReason,
  Rect,
  SourceOp,
  TextRun,
} from '@pdf-editor/shared-types';
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

/** 블록 스트림 사전의 /PdfEditorFormat(계약 D3·5.3). */
export interface BlockFormat {
  v: 1;
  format: ParagraphFormat;
  runs: {
    text: string;
    size: number;
    bold: boolean;
    italic: boolean;
    color: [number, number, number] | null;
    /** 원 폰트 이름(BaseFont). 폴백이면 폴백 폰트 이름. */
    font: string;
    synthetic: { bold: boolean; italic: boolean };
  }[];
  /** 쓴 글리프마다 텍스트 위치(스트림 순서). 재열기 뒤 sourceChar·캐럿 위치 복원에 쓴다. */
  glyphOffsets: number[];
  /** 쓰지 않은 글자(glyph-missing) 텍스트 위치. */
  missing: number[];
  insertion: InsertionInfo;
  areaLimit: Rect;
}

export interface OpRemoval {
  op: SourceOp;
  /** text.glyphs 인덱스별 지움 여부. */
  remove: boolean[];
  partial: boolean;
  analysis: ShowAnalysis;
}

export interface InsertionPoint {
  mode: 'before-bt' | 'split-bt';
  /** 삽입할 스트림과 바이트 위치(그 위치 앞에 넣는다). splitOp 가 있으면 그 연산 안(다시 쓴 TJ 사이). */
  stream: ContentStreamRef;
  offset: number;
  splitOp: number | null;
  splitGlyph: number | null;
  /** split-bt 에서 편집 블록 호출 뒤 이어 쓸 텍스트(`BT <Tlm> Tm [n] TJ`). before-bt 는 빈 문자열. */
  resume: string;
  /** 삽입점의 그래픽 상태를 가진 연산. */
  stateOp: SourceOp;
  /** 삽입점 CTM(그 스트림 콘텐츠 공간 → 사용자 공간). */
  ctm: Matrix;
  mcidKept: boolean | null;
  /** 규칙 3 으로 marked content 바깥으로 옮김. */
  moved: boolean;
}

export interface EditAnalysis {
  paragraph: LayoutParagraph;
  /** 대상 글자(PageModel.chars 인덱스, 문단 순서. 편집 블록이면 블록 글자 glyphSeq 순). */
  chars: number[];
  /** 대상이 편집 블록이면 그 블록. */
  block: EditBlockRef | null;
  blockStep: FormStep | null;
  blockFormat: BlockFormat | null;
  limits: ParagraphLimit[];
  warnings: EditWarning[];
  removals: OpRemoval[];
  /** 새 텍스트(편집 블록 호출)를 넣을 콘텐츠의 Form 사용 경로. 쪽 콘텐츠면 빈 배열. */
  formPath: FormStep[];
  insertion: InsertionPoint | null;
  areaLimit: Rect;
  /** ActualText 를 뺄 BDC 연산 id. */
  actualTextClears: number[];
  /** 복제할 Form 이 /StructParents 를 가져 복제본에서 지운다. */
  structParentsRemoved: boolean;
}

/** 한 번의 판정(쪽 하나) 안에서 공유하는 상태. */
export interface AnalyzeEnv {
  ctx: ParagraphEditContext;
  fonts: FontCache;
  streams: StreamCache;
  blockNums: Map<number, EditBlockRef>;
  links: Rect[];
  redacts: Rect[];
  formats: Map<number, BlockFormat | null>;
  /** (Form 경로, 폰트 리소스 이름) → 폰트 리소스 값. */
  fontRefs: Map<string, mupdf.PDFObject | null>;
  /** gs 연산 id → 그 사전의 /SMask(키가 없으면 undefined). */
  gsSMask: Map<number, mupdf.PDFObject | undefined>;
  /** 색 연산 id → 패턴 채움 여부. */
  patternOps: Map<number, boolean>;
  /** glyphSeq → PageModel 글자, 글자 → 문단 id(ActualText 판정, 처음 쓸 때 만든다). */
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

function readJson(obj: mupdf.PDFObject): BlockFormat | null {
  try {
    if (!obj.isString()) return null;
    const v = JSON.parse(obj.asString()) as BlockFormat;
    return v && v.v === 1 && Array.isArray(v.runs) ? v : null;
  } catch {
    return null;
  }
}

/** 편집 블록의 /PdfEditorFormat. 없거나 읽을 수 없으면 null. */
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

/** 글리프가 보이는가(번호를 받았고 Tr 3·7 이 아님). */
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

/** 연산을 명세 폭으로 분석한다(폰트 찾기 포함). */
function analyzeOp(env: AnalyzeEnv, op: SourceOp): ShowAnalysis | SkipInfo {
  if (!op.text || op.kind !== 'text-show') {
    return { code: 'not-text-show', detail: '텍스트 표시 연산 아님' };
  }
  const font = opFont(env, op);
  if (!font)
    return { code: 'no-font-resource', detail: `폰트 리소스 없음: ${op.text.fontResource}` };
  return analyzeShow(op, env.streams.opBytes(op), env.fonts.load(font));
}

/** 편집 블록 사용 단계(글자 연산의 Form 경로에서 편집 블록인 단계). */
function blockStepOf(env: AnalyzeEnv, op: SourceOp): FormStep | null {
  for (const s of op.formPath) if (env.blockNums.has(s.objectNumber)) return s;
  return null;
}

/** 문단 분석. */
export function analyzeParagraph(env: AnalyzeEnv, paragraphId: number): EditAnalysis {
  const { ctx } = env;
  const paragraph = ctx.layout.paragraphs.find((p) => p.id === paragraphId);
  if (!paragraph) throw new Error(`문단 없음: ${paragraphId}`);
  const limits = new Limits();
  const warnings: EditWarning[] = [];

  if (paragraph.table !== null || paragraph.figure !== null) {
    limits.add(
      'not-flow-paragraph',
      paragraph.table !== null ? '표 셀 문단(M4)' : '도형 라벨 문단',
      [],
    );
  }
  for (const li of paragraph.lines) {
    const line = ctx.model.lines[li];
    if (!line) continue;
    const angle = Math.abs(Math.atan2(line.dir[1], line.dir[0]));
    if (line.wmode === 1 || angle > ROTATION_TOLERANCE) {
      limits.add('vertical-or-rotated', '세로쓰기·회전 줄', line.chars);
    }
  }

  // 편집 블록 글자를 포함하면 대상은 블록 전체(계약 D3).
  for (const c of paragraph.chars) {
    const opId = ctx.linkage.charOp[c] ?? -1;
    const op = opId >= 0 ? ctx.map.ops[opId] : undefined;
    const step = op ? blockStepOf(env, op) : null;
    if (op && step) return analyzeBlock(env, paragraph, step, limits, warnings);
  }

  const chars = paragraph.chars;
  const result = analyzeChars(env, paragraph, chars, limits, warnings);
  return result;
}

function analyzeChars(
  env: AnalyzeEnv,
  paragraph: LayoutParagraph,
  chars: number[],
  limits: Limits,
  warnings: EditWarning[],
): EditAnalysis {
  const { ctx } = env;
  const ops = ctx.map.ops;
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
  };

  // 연산 연결·연산 제한.
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

  // 출처 섞임: 쪽 콘텐츠와 Form, 서로 다른 Form 사용 경로.
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

  // ActualText(D1): 지울 글리프가 /ActualText MC 안이면 그 MC 의 글리프를 모두 지운다. MuPDF 구조화 텍스트는
  // ActualText 로 글자를 바꾸므로 MC 의 일부 글리프는 어느 문단에도 들어가지 않는다(그런 글리프는 함께 지운다).
  // 다른 문단에 속한 글리프가 있으면 일부만 지우는 것이므로 편집 제한.
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
          if (owner !== undefined && owner !== paragraph.id) partial = true;
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
      rects: [paragraph.bbox],
    });
  }

  // 지울 글리프와 연산 분석(D2).
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

  // Form 복제본의 /StructParents(D1).
  for (const s of formPath) {
    const f = ctx.doc.newIndirect(s.objectNumber);
    if (!f.get('StructParents').isNull() || !f.get('StructParent').isNull()) {
      base.structParentsRemoved = true;
    }
  }

  // 삽입점(D3).
  const ins = findInsertion(env, base, limits);
  if (ins) {
    base.insertion = ins;
    checkInsertionState(env, base, ins, limits);
  }
  addPlacementWarnings(env, base);
  return base;
}

/** 삽입점 판정(계약 D3 규칙 1–3). 나눌 수 없으면 제한을 더하고 null. */
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
    // 복제할 Form 안에서 열린 MCID 는 /StructParents 를 지우면 구조와 끊긴다.
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

  // 규칙 1.
  if (!keptBefore(ref.id) && !keptVisible(ref, refGlyph)) return beforeBt();

  // 규칙 3: BT 안에서 열린 marked content 가 열려 있으면 가장 바깥 것 앞으로 옮기고 규칙 1·2 를 다시 적용한다.
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

  // 규칙 2 의 나누기 제한.
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
 * BT 시작부터 나누는 지점까지 텍스트 줄 행렬과 변위를 따라가 편집 블록 호출 뒤 이어 쓸 `BT … [n] TJ` 를 만든다
 * (계약 D3 규칙 2). 나누는 지점: target.glyph 가 null 이면 target.op 바로 앞, 아니면 그 연산의 target.glyph 글리프 앞.
 *
 * 줄 행렬(Tlm)은 계산값 하나(`<Tlm> Tm`)로 쓰지 않고, 마지막 Tm(없으면 BT)부터의 줄 설정 연산을 원 피연산자 그대로
 * 같은 순서로 다시 실행한다: Tm·Td 는 원 바이트, TD 는 `tx ty Td`(TL 부수 효과 없음), T*·'·" 의 줄 이동은
 * `0 -TL Td`(TL 을 알면) 또는 `T*`. 같은 연산을 같은 순서로 실행해야 엔진별 부동소수 누적까지 원래와 같아진다
 * (실측: pdf.js 는 `<Tlm> Tm` 이면 뒤 줄 글리프의 안티에일리어싱이 달라짐, Poppler 는 합친 Td 하나면 달라짐).
 * 계산할 수 없으면 사유.
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
  /** o 다음, 나누는 지점 전까지 TL 을 바꾸는 연산이 있는가. */
  const tlChangesAfter = (o: SourceOp) =>
    upto.some((x) => x.id > o.id && x.id < target.op.id && (x.op === 'TL' || x.op === 'TD'));
  /** o 다음 텍스트 표시 연산의 TL(그사이 TL 변경이 없을 때). */
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
        // 변위는 마지막 줄 설정 연산 뒤의 표시 연산만 필요하다(아래에서 한 번에 계산).
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

/** 삽입점 그래픽 상태 판정(D3): 특이 CTM, 클립, 패턴 채움, SMask. 영역 상한도 정한다. */
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
    // 직사각형 클립이라도 원 문단 글자를 다 덮지 않으면(다른 클립 아래 그린 글자가 섞임) 새 텍스트가 잘린다.
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
  // 판정에는 효력 있는 SMask 만 필요하다(gs 연산별로 한 번 읽는다. 쪽 끝까지 누적되는 gs 목록을 매번 합치지 않는다).
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
      rects: links,
    });
  }
  const redacts = env.redacts.filter((r) => overlaps(r, box));
  if (redacts.length > 0) {
    a.warnings.push({
      kind: 'redact-overlap',
      message: `편집 문단이 적용되지 않은 Redact 표시 ${redacts.length}개와 겹칩니다. 나중에 적용하면 새 텍스트도 지워집니다.`,
      rects: redacts,
    });
  }
}

/** 편집 블록 재편집(rewrite-block): 원 연산 제거 없이 블록 스트림만 다시 쓴다. */
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
  };
}

const concatAll = (list: Matrix[]): Matrix => list.reduce((acc, m) => concat(acc, m));

// ---------------------------------------------------------------- 시작 상태(5.3)

export interface StartState {
  runs: TextRun[];
  charIndexOfOffset: number[];
  format: ParagraphFormat;
}

/** 원 문단 텍스트 위치 → 글자 인덱스(합성 공백 -1). 문단 텍스트와 글자 텍스트를 앞에서부터 맞춘다. */
export function offsetMap(
  paragraph: LayoutParagraph,
  chars: readonly { text: string }[],
): number[] {
  const text = paragraph.text;
  const out = new Array<number>(text.length).fill(-1);
  let k = 0;
  const list = paragraph.chars;
  for (let o = 0; o < text.length;) {
    while (k < list.length) {
      const t = chars[list[k]!]?.text ?? '';
      if (t !== '' && text.startsWith(t, o)) break;
      // 줄 끝에서 지운 공백 글자·빈 글자는 건너뛴다.
      if (t.trim() === '') {
        k++;
        continue;
      }
      break;
    }
    const ci = list[k];
    const t = ci !== undefined ? (chars[ci]?.text ?? '') : '';
    if (ci !== undefined && t !== '' && text.startsWith(t, o)) {
      for (let j = 0; j < t.length; j++) out[o + j] = ci;
      o += t.length;
      k++;
    } else if (/\s/u.test(text[o]!)) {
      o++;
    } else if (ci !== undefined) {
      // 맞지 않는 글자(U+FFFD 등): 한 칸씩 맞춘다.
      out[o] = ci;
      o++;
      k++;
    } else o++;
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
  const styleOf = (ri: number) => {
    const r = paragraph.styleRuns[ri];
    const sc = r ? (paragraph.chars[r.start] ?? paragraph.chars[0]!) : paragraph.chars[0]!;
    return {
      sourceChar: sc,
      fontId: r?.fontId ?? ctx.model.chars[sc]?.fontId ?? 0,
      size: r?.size ?? ctx.model.chars[sc]?.size ?? 10,
      bold: r?.bold ?? false,
      italic: r?.italic ?? false,
      color: r?.color ?? null,
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
      overflow: null,
    },
  };
}

/** 편집 블록의 시작 상태(5.3): /PdfEditorFormat, 추출 텍스트와 다르면 추출 텍스트 + 블록 상자. */
export function blockStartState(ctx: ParagraphEditContext, a: EditAnalysis): StartState {
  const fmt = a.blockFormat;
  const chars = a.chars;
  const extracted = chars.map((c) => ctx.model.chars[c]!.text).join('');
  const strip = (s: string) => s.replace(/\s+/gu, '');
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
        overflow: null,
      },
    };
  };
  if (!fmt) return fromExtract();
  const text = fmt.runs.map((r) => r.text).join('');
  if (strip(text) !== strip(extracted) || fmt.glyphOffsets.length !== chars.length) {
    return fromExtract();
  }
  const map = new Array<number>(text.length).fill(-1);
  fmt.glyphOffsets.forEach((o, k) => {
    if (o >= 0 && o < map.length && map[o] === -1) map[o] = chars[k]!;
  });
  // 클러스터 나머지 UTF-16 위치도 같은 글자로 채운다.
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
      },
    };
  });
  return { runs, charIndexOfOffset: map, format: { ...fmt.format, overflow: fmt.format.overflow } };
}
