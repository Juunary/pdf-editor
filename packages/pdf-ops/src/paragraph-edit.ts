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
import { latestWriteContext, prepareEdit } from './edit-apply.js';
import { listBlocks, writeBlock } from './edit-block.js';
import { recordMetadata } from './edit-meta.js';
import {
  analyzeParagraph,
  blockStartState,
  makeEnv,
  originalStartState,
  type AnalyzeEnv,
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
  const { ctx } = env;
  const a = analyzeParagraph(env, paragraphId);
  const editable = a.limits.length === 0;
  const start = a.block ? blockStartState(ctx, a) : originalStartState(ctx, a.paragraph);
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
  return {
    pageIndex: ctx.pageIndex,
    paragraphId,
    target: {
      pageIndex: ctx.pageIndex,
      glyphSeqs: a.chars.map((c) => ctx.model.chars[c]!.glyphSeq),
      editedBlock: a.block?.editId ?? null,
      bbox: [...a.paragraph.bbox] as Rect,
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

/** 쪽의 흐름 문단별 편집 가능 여부(계약 5.1 일괄 판정). revision·ms 는 호출자가 채운다. */
export function planPageEditability(
  ctx: ParagraphEditContext,
  fonts: FontManager,
): Omit<PageEditability, 'revision' | 'ms'> {
  void fonts;
  const env = makeEnv(ctx, fontCacheOf(ctx.doc));
  return {
    pageIndex: ctx.pageIndex,
    paragraphs: ctx.layout.paragraphs.map((p) => {
      const plan = planOne(env, p.id, now());
      return {
        paragraphId: p.id,
        bbox: [...p.bbox] as Rect,
        editable: plan.editable,
        editedBlock: plan.target.editedBlock,
        reasons: [...new Set(plan.limits.map((l) => l.reason))],
      };
    }),
  };
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

/** 쪽 콘텐츠·Form 에서 /PdfEditorEdit 편집 블록을 찾는다(undo/redo 뒤 목록 재구성, 계약 5.7). */
export function listEditBlocks(doc: mupdf.PDFDocument, pageIndex: number): EditBlockRef[] {
  return listBlocks(doc, pageIndex);
}

/** 저장 작업(계약 D9) 안에서 Info /PdfEditorEdits 를 기록한다(계약 5.6·D1). Info 사전은 core 가 저널을 켜기 전에 만들어 둔다(계약 수정 1). */
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
    const cached = wc && wc.pageIndex === ctx.pageIndex ? wc.styles : null;
    return fontStateOf(this).assign(
      text,
      runs,
      (sc) => cached?.get(sc) ?? resolveStyle(ctx, sc),
      ctx.map,
    );
  }

  /** 저장 작업(계약 D9) 안에서만: 폴백 폰트를 쓴 글리프만 남긴 서브셋으로 바꾼다(A7-1). 작업을 버리면 되돌아간다. */
  finalizeForSave(): void {
    fontStateOf(this).finalizeForSave();
  }
}
