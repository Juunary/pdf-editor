/**
 * 문단 편집(M3, docs/m3-contract.md): 편집 가능 판정(5.1), 제거(D2·5.2), 편집 블록 삽입(D3), 폰트 배정(D4),
 * 편집 블록 쓰기(5.5), 저장 메타(5.6). core 편집 세션이 아래 순서로 부른다.
 *
 *   planParagraphEdit → (FontManager.assign → reflow.layoutParagraph → writeEditBlock)* → 커밋
 *   prepareParagraphEdit 는 초안 시작 때 한 번(제거 + 빈 편집 블록 삽입). 저널 작업 열기·닫기는 core 가 한다.
 *
 * 계약 커밋의 연결부다. 시그니처는 고정이다. 구현: edit-plan.ts(판정), edit-apply.ts(제거·삽입),
 * font-assign.ts(폰트 배정), edit-block.ts(쓰기·목록), edit-meta.ts(저장 메타).
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
import type { FontSegment, ReflowResult } from '@pdf-editor/reflow';
import { now } from './clock.js';
import { latestWriteContext, prepareEdit, styleFor } from './edit-apply.js';
import { listBlocks, writeBlock } from './edit-block.js';
import { recordMetadata } from './edit-meta.js';
import { cellOfParagraph } from './cell-edit.js';
import { planPathEditability } from './path-edit.js';
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

/** 문서별 PdfFont 캐시(판정·적용 공용). 폴백 폰트는 FontState 가 따로 읽는다. */
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

/** 셀 시작 형식(D5): 가로 = 셀 − 여백(정렬한 변은 원 간격), 세로 = 글자 상자, 셀 정렬, 들여쓰기 0. */
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

/** 판정·제거에 쓰는 쪽 상태(core 캐시에서 가져온다). */
export interface ParagraphEditContext {
  doc: mupdf.PDFDocument;
  pageIndex: number;
  model: PageModel;
  map: SourceMap;
  linkage: PageLinkage;
  layout: PageLayout;
  /** 이 쪽의 편집 블록(listEditBlocks 결과). */
  editBlocks: EditBlockRef[];
}

/** 문서 안 편집 블록(전용 Form XObject, 스트림 사전 /PdfEditorEdit). */
export interface EditBlockRef {
  editId: string;
  /** 편집 블록 Form XObject 객체 번호. */
  objectNumber: number;
}

export interface PreparedEdit {
  editId: string;
  target: ParagraphTarget;
  block: EditBlockRef;
  /** 제거·삽입으로 바뀌거나 새로 생긴 객체 번호(객체 diff 기대값). */
  changedObjects: number[];
}

export interface WriteResult {
  /** 편집 블록 스트림 길이(byte, 압축 전). */
  streamBytes: number;
  /** 이 쓰기로 추가한 폰트·색공간 리소스 이름. */
  resources: string[];
  writeMs: number;
}

/**
 * 쪽의 흐름 문단별 편집 가능 여부(계약 5.1 일괄 판정). revision·ms 는 호출자가 채운다.
 *
 * 편집 블록은 한 항목이다. 커밋 뒤 레이아웃 복원은 블록의 줄을 다른 문단처럼 다시 나누거나(줄 간격·짧은 줄·강제
 * 줄바꿈·양쪽 정렬 간격) 이웃 문단 줄과 합칠 수 있다. 그런 레이아웃 문단은 어느 것을 편집해도 대상이 블록 전체이므로
 * (계약 D3) 블록마다 첫 문단 id 하나만 남기고, 상자는 블록 글자 상자(analyzeBlock)로 한다. 레이아웃 문단 상자를
 * 그대로 쓰면 한 블록이 여러 테두리로 갈라져 보이거나 이웃 문단까지 덮는다(2026-10-20 사용자 보고, docs/m3-integration.md 9절).
 * 표 셀은 셀마다 한 항목(첫 문단 id, 상자 = 셀 상자, M4 4.1). paths 는 planPathEditability(M4 4.2).
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
    // 셀은 한 항목(첫 문단 id, 상자 = 셀 상자, 계약 4.1).
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

/** 편집 가능 판정·시작 텍스트·영역(계약 5.1·5.3). 문서를 바꾸지 않는다. revision 은 호출자가 채운다. */
export function planParagraphEdit(
  ctx: ParagraphEditContext,
  fonts: FontManager,
  paragraphId: number,
): Omit<ParagraphEditPlan, 'revision'> {
  void fonts;
  const t0 = now();
  return planOne(makeEnv(ctx, fontCacheOf(ctx.doc)), paragraphId, t0);
}

/**
 * 원 문단 제거(D2) + 삽입점에 빈 편집 블록 호출 삽입(D3). plan.editable 이 false 이면 예외.
 * 대상이 편집 블록이면(target.editedBlock) 제거 없이 그 블록을 돌려준다.
 */
export function prepareParagraphEdit(
  ctx: ParagraphEditContext,
  plan: Omit<ParagraphEditPlan, 'revision'>,
  editId: string,
): PreparedEdit {
  return prepareEdit(ctx, plan, editId, fontCacheOf(ctx.doc));
}

/**
 * 리플로우 결과로 편집 블록 스트림과 /PdfEditorFormat 을 다시 쓴다(계약 5.5·D3). runs 는 result 의
 * WritableGlyph.runIndex 가 가리키는 배열이고, 모양 원천(sourceChar)의 폰트·채움 색·ExtGState 는 ctx 에서 찾는다.
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
 * 편집 블록마다 그 블록 글자가 있는 PageModel 줄 인덱스(오름차순). 레이아웃 복원 힌트
 * (`ReconOptions.fixedGroups`, docs/m3-integration.md 9.6)용 순수 함수(문서를 읽지 않는다).
 *
 * 글자의 소속은 원본 연결(`linkage.charOp` → `SourceOp.formPath`)에 블록 Form 객체 번호가 있는지로 정한다
 * (analyzeBlock 과 같은 규칙). 줄 하나에 블록 글자와 다른 글자가 섞이면 보이는 글자의 과반(절반 초과)이 속한
 * 블록에 준다. 과반이 없으면 어느 묶음에도 넣지 않는다(보통의 레이아웃 복원). 결과는 `blocks` 순서이고 빈 묶음은 뺀다.
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

/** 쪽 콘텐츠·Form 에서 /PdfEditorEdit 편집 블록을 찾는다(undo/redo 뒤 목록 재구성, 계약 5.7). */
export function listEditBlocks(doc: mupdf.PDFDocument, pageIndex: number): EditBlockRef[] {
  return listBlocks(doc, pageIndex);
}

/**
 * 커밋 작업 안에서 Info /PdfEditorEdits 를 기록한다(계약 5.6·D1 수정 4). pages 는 활성 편집 전체의 쪽 인덱스(0부터),
 * 같은 입력이면 멱등, 이전 세션 쪽 번호와 합집합. Info 사전은 core 가 저널을 켜기 전에 만들어 둔다(계약 수정 1).
 */
export function recordEditMetadata(
  doc: mupdf.PDFDocument,
  info: { pages: number[]; structureNotUpdated: boolean },
): void {
  recordMetadata(doc, info);
}

/**
 * 폴백 폰트(계약 D4 수정 1). core 가 저널을 켜기 직전(작업 밖)에 한 번 embedFont 해 둔다. 저널 밖 객체라 편집
 * 취소·undo 로 사라지지 않는다. FontManager 는 직접 embedFont 하지 않는다.
 */
export interface FallbackFontSource {
  /** 폰트 바이트(커버리지 판정·셰이핑). core 가 미리 await 해 둔다. */
  bytes(): Uint8Array;
  /** 임베딩한 폴백 폰트 객체(Type0). 저널을 켜기 전(판정 단계)에는 null. */
  ref(): mupdf.PDFObject | null;
}

/** 폰트 배정(계약 D4). 문서당 하나. */
export class FontManager {
  readonly #doc: mupdf.PDFDocument;
  readonly #fallback: FallbackFontSource;

  constructor(doc: mupdf.PDFDocument, fallback: FallbackFontSource) {
    this.#doc = doc;
    this.#fallback = fallback;
    fontStates.set(this, new FontState(this.#doc, this.#fallback));
  }

  /**
   * 텍스트를 글자(클러스터) 단위로 원본/폴백 폰트에 배정한다. segments 는 텍스트를 빈틈 없이 덮는다.
   * runs 의 sourceChar 는 그 초안의 판정 시점 PageModel 인덱스다(prepareParagraphEdit 가 해석을 보관한다).
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

  /** 저장 작업(계약 D9) 안에서만: 폴백 폰트를 쓴 글리프만 남긴 서브셋으로 바꾼다(A7-1). 작업을 버리면 되돌아간다. */
  finalizeForSave(): void {
    fontStateOf(this).finalizeForSave();
  }
}
