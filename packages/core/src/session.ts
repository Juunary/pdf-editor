// 첫 import 유지: mupdf 가 초기화되기 전에 Module 설정 객체를 등록해야 WASM 힙 측정(`wasmHeapBytes`)이 연결된다. Worker 번들은
// 이 모듈과 mupdf 를 한 청크에 넣고 import 순서대로 실행한다(뒤에 두면 저장 힙 모델이 배율 모델로 떨어진다, docs/m5-heap.md 4.3).
import './wasm-module.js';
import * as mupdf from 'mupdf';
import {
  FULL_SAVE_OPTIONS,
  STREAM_INPUT_PEAK_HEAP_RATIO,
  buildSourceMap,
  decideSaveMethod,
  editBlockLineGroups,
  estimateSaveHeap,
  journalAdvice,
  linkPage,
  listRedactAnnots,
  type JournalAdvice,
  type SaveSizeInput,
} from '@pdf-editor/pdf-ops';
import { reconstructPage } from '@pdf-editor/layout-recon';
import type {
  RedactAnnotSummary,
  BeginEditResult,
  BeginPathEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  ExtractRequest,
  InputMode,
  OpenResult,
  PageInfo,
  PageLayout,
  PageLinkage,
  PageModel,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
  Rect,
  RenderRequest,
  RenderedPage,
  SavePlan,
  SaveRequest,
  SaveResult,
  SearchRequest,
  SearchResult,
  SourceMap,
} from '@pdf-editor/shared-types';
import { defaultEditAdapter, type EditAdapter } from './edit-adapter.js';
import { EditEngine, EditStateError, type EditHost } from './edit-engine.js';
import { extractPageModel } from './extract.js';
import { computeDocumentStats, openPdf, type DocumentStatsDetail } from './open.js';
import { pageRotation } from './page-geometry.js';
import { renderPageRegionRgba, renderPageRgba } from './render.js';
import { searchDocument } from './search.js';
import { wasmHeapBytes } from './wasm-module.js';

/** 추출 모델·원본 연결 정보를 캐시하는 최대 쪽 수(추출 모델은 요청 종류별로 센다). */
const PAGE_CACHE_LIMIT = 16;

/** 최근 사용 순 캐시에서 꺼내며 순서를 올린다. */
function touch<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** 넣고, 상한을 넘으면 가장 오래된 항목을 뺀다. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);
  if (cache.size > PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

export interface PdfSessionOptions {
  /**
   * 한글 폴백 폰트(Noto Sans KR glyf 서브셋 TTF) 바이트. 문단 편집에서 처음 필요할 때 한 번 부른다
   * (docs/m3-contract.md 5.7). 확장은 번들 파일을, Node 테스트는 assets/fonts 파일을 읽는다.
   */
  loadFallbackFont?: () => Promise<Uint8Array>;
  /** pdf-ops·reflow 편집 함수 경계(docs/m3-core.md 3절). 기본은 실제 구현, 테스트는 가짜를 넣는다. */
  editAdapter?: EditAdapter;
  /** 편집 id·초안 id 생성(기본 `crypto.randomUUID()`). 테스트에서 고정한다. */
  createId?: () => string;
}

/** 쪽 전체 렌더를 한 번도 하지 않았을 때의 변경 영역 렌더 배율(`beginParagraphEdit` 첫 미리보기). */
const DEFAULT_RENDER_SCALE = 2;

function noDocument(): never {
  throw new Error('열린 문서 없음');
}

/**
 * 문서 1개의 상태. 뷰어 소유 Worker 안에서만 생성한다(PLAN.md 5.2).
 * 원본 바이트는 편집 로그 재적용(PLAN.md 3.2)을 위해 보관한다.
 */
export class PdfSession {
  readonly #options: PdfSessionOptions;
  #original: Uint8Array | null = null;
  #doc: mupdf.PDFDocument | null = null;
  #inputMode: InputMode = 'buffer';
  #pageCache = new Map<string, PageModel>();
  #sourceMapCache = new Map<number, SourceMap>();
  #layoutCache = new Map<number, PageLayout>();
  #linkageCache = new Map<number, { map: SourceMap; linkage: PageLinkage }>();
  #edit: EditEngine | null = null;
  #lastRenderScale = DEFAULT_RENDER_SCALE;
  /** 이 세션에서 전체 저장을 한 번이라도 했다(A3-9: 이후 저장도 전체 저장). */
  #fullSaved = false;
  /** 저장 힙 모델 기본값: 문서 열기 완료 직후 WASM 힙(D5). 측정 객체가 없으면 null. */
  #baseHeapBytes: number | null = null;
  /** 저장 힙 모델 입력(D5). 첫 쪽 렌더 뒤 유휴 시나 첫 planSave 에서 한 번 계산한다. */
  #stats: DocumentStatsDetail | null = null;
  #statsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: PdfSessionOptions = {}) {
    this.#options = options;
  }

  get document(): mupdf.PDFDocument {
    if (!this.#doc) throw new Error('열린 문서 없음');
    return this.#doc;
  }

  get originalBytes(): Uint8Array {
    if (!this.#original) throw new Error('열린 문서 없음');
    return this.#original;
  }

  /**
   * 문서를 연다. 기본은 Stream 입력(A3-1): 보관 중인 원본 바이트를 MuPDF 가 필요한 구간만 읽어
   * 입력 크기만큼의 WASM 힙을 쓰지 않는다. `buffer` 는 비교·측정용이다.
   */
  open(bytes: ArrayBuffer | Uint8Array, inputMode: InputMode = 'stream'): OpenResult {
    this.close();
    const t0 = performance.now();
    const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = openPdf(original, { inputMode });
    this.#original = original;
    this.#doc = doc;
    this.#inputMode = inputMode;
    this.#fullSaved = false;
    this.#stats = null;
    this.#lastRenderScale = DEFAULT_RENDER_SCALE;
    this.#edit = new EditEngine(this.#editHost(doc), {
      adapter: this.#options.editAdapter ?? defaultEditAdapter,
      loadFallbackFont: this.#options.loadFallbackFont,
      createId: this.#options.createId,
    });
    const page = doc.loadPage(0);
    const [x0, y0, x1, y1] = page.getBounds();
    page.destroy();
    this.#baseHeapBytes = wasmHeapBytes();
    return {
      pageCount: doc.countPages(),
      firstPage: { width: x1 - x0, height: y1 - y0 },
      byteLength: original.byteLength,
      openMs: performance.now() - t0,
      inputMode: this.#inputMode,
    };
  }

  getPageInfo(pageIndex: number): PageInfo {
    const page = this.document.loadPage(pageIndex);
    try {
      const bounds = page.getBounds() as Rect;
      return {
        pageIndex,
        bounds,
        size: { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] },
        rotation: pageRotation(page),
      };
    } finally {
      page.destroy();
    }
  }

  /**
   * 쪽 렌더. `clip`(페이지 공간)이 있으면 그 영역만 렌더하고 `RenderedPage.clip` 에 픽셀 격자에 맞춘 실제 영역을
   * 돌려준다(M3 편집 미리보기). 편집 초안이 열려 있으면 초안 상태의 문서를 그린다(docs/m3-contract.md D7).
   */
  renderPage({ pageIndex, scale, clip }: RenderRequest): RenderedPage {
    const page = this.document.loadPage(pageIndex);
    try {
      const t0 = performance.now();
      if (clip) {
        const region = renderPageRegionRgba(page, scale, clip);
        const { width, height, rgba } = region;
        return {
          pageIndex,
          width,
          height,
          rgba,
          renderMs: performance.now() - t0,
          clip: region.clip,
        };
      }
      this.#lastRenderScale = scale;
      const { width, height, rgba } = renderPageRgba(page, scale);
      this.#scheduleStats();
      return { pageIndex, width, height, rgba, renderMs: performance.now() - t0, clip: null };
    } finally {
      page.destroy();
    }
  }

  /**
   * 페이지 추출 모델. 같은 요청은 문서가 바뀌기 전까지 캐시하고(최근 사용 순 최대 PAGE_CACHE_LIMIT 쪽),
   * 같은 객체를 돌려준다. 호출자는 바꾸지 않는다. 문서를 편집하면 `invalidatePageCache` 를 부른다.
   */
  extractPage(request: ExtractRequest): PageModel {
    const key = `${request.pageIndex}:${request.includePathSegments === true ? 1 : 0}`;
    const cached = touch(this.#pageCache, key);
    if (cached) return cached;
    const page = this.document.loadPage(request.pageIndex);
    let model: PageModel;
    try {
      model = extractPageModel(page, request);
    } finally {
      page.destroy();
    }
    remember(this.#pageCache, key, model);
    return model;
  }

  /**
   * 추출·원본 연결 정보·레이아웃 캐시를 비운다. 쪽을 지정하면 그 쪽만. 문서 내용(콘텐츠·리소스·쪽 순서)이 바뀐
   * 뒤에 부른다.
   */
  invalidatePageCache(pageIndex?: number): void {
    if (pageIndex === undefined) {
      this.#pageCache.clear();
      this.#sourceMapCache.clear();
      this.#layoutCache.clear();
      this.#linkageCache.clear();
      return;
    }
    this.#layoutCache.delete(pageIndex);
    this.#linkageCache.delete(pageIndex);
    for (const key of [...this.#pageCache.keys()]) {
      if (key.startsWith(`${pageIndex}:`)) this.#pageCache.delete(key);
    }
    this.#sourceMapCache.delete(pageIndex);
  }

  /**
   * 쪽 레이아웃(M2, docs/m2-contract.md). 경로 세그먼트를 포함한 추출 모델로 복원하고, 추출 캐시와 같은
   * 규칙(최근 사용 순 최대 PAGE_CACHE_LIMIT 쪽)으로 캐시한다. 호출자는 결과를 바꾸지 않는다.
   */
  getPageLayout(pageIndex: number): PageLayout {
    const cached = touch(this.#layoutCache, pageIndex);
    if (cached) return cached;
    // 이웃 쪽(±1·±2) 추출 모델: 러닝헤드·쪽 번호 반복 판정용(계약 2.5). 추출 캐시를 거친다.
    const count = this.document.countPages();
    const neighbors = [-2, -1, 1, 2]
      .map((k) => pageIndex + k)
      .filter((n) => n >= 0 && n < count)
      .map((n) => this.extractPage({ pageIndex: n }));
    const layout = reconstructPage(this.extractPage({ pageIndex, includePathSegments: true }), {
      neighbors,
      fixedGroups: this.#editBlockGroups(pageIndex),
    });
    remember(this.#layoutCache, pageIndex, layout);
    return layout;
  }

  /**
   * 편집 블록마다 그 글자가 있는 줄 묶음(레이아웃 복원 힌트 `fixedGroups`, docs/m3-integration.md 9.6). 커밋한 편집
   * 블록은 쪽 레이아웃에서 문단 하나다(오버레이·읽기 순서가 블록을 여러 문단으로 가르거나 이웃 문단과 합치지 않는다).
   * 블록 목록은 편집 엔진 캐시(커밋·undo·redo·초안 시작 때 갱신), 소속은 원본 연결(linkPage)로 정한다. 블록이 없는
   * 쪽은 원본 연결을 만들지 않는다. 레이아웃 캐시와 같이 비워지므로(invalidateAround) 따로 캐시하지 않는다.
   */
  #editBlockGroups(pageIndex: number): number[][] {
    const blocks = this.#edit?.editBlocks(pageIndex) ?? [];
    if (blocks.length === 0) return [];
    return editBlockLineGroups(
      this.extractPage({ pageIndex }),
      this.getSourceMap(pageIndex),
      this.linkPage(pageIndex),
      blocks,
    );
  }

  /**
   * 쪽의 원본 연결 정보. extractPage 와 같이 쪽마다 캐시하고 같은 객체를 돌려준다. `linkPage` 가 이 객체의
   * `ops[].limits` 에 `unmatched` 를 더하므로, linkPage 뒤의 getSourceMap 은 그 표시를 담는다.
   */
  getSourceMap(pageIndex: number): SourceMap {
    const cached = touch(this.#sourceMapCache, pageIndex);
    if (cached) return cached;
    const map = buildSourceMap(this.document, pageIndex);
    remember(this.#sourceMapCache, pageIndex, map);
    return map;
  }

  /**
   * 캐시한 추출 모델과 원본 연결 정보를 매칭한다(원본 연결 정보에 `unmatched` 표시). 쪽마다 캐시하고 같은
   * 객체를 돌려준다(`invalidatePageCache` 로 비운다).
   */
  linkPage(pageIndex: number): PageLinkage {
    // 원본 연결 정보가 캐시에서 빠져 다시 만들어졌으면 매칭도 다시 한다(`unmatched` 표시는 그 객체에 붙는다).
    const map = this.getSourceMap(pageIndex);
    const cached = touch(this.#linkageCache, pageIndex);
    if (cached && cached.map === map) return cached.linkage;
    const linkage = linkPage(this.extractPage({ pageIndex }), map);
    remember(this.#linkageCache, pageIndex, { map, linkage });
    return linkage;
  }

  /**
   * 문서가 바뀐 쪽의 캐시를 비운다. 이웃 쪽 레이아웃(머리·꼬리 반복 판정이 이 쪽 추출 모델을 쓴다, M2)도
   * ±2쪽까지 비운다(docs/m3-contract.md 5.7).
   */
  invalidateAround(pageIndex: number): void {
    this.invalidatePageCache(pageIndex);
    for (const k of [-2, -1, 1, 2]) this.#layoutCache.delete(pageIndex + k);
  }

  /**
   * 저장 힙 모델 입력(D5, `computeDocumentStats`). 처음 부를 때 계산해 문서를 닫을 때까지 보관한다. 열기 시간에 넣지 않도록
   * 첫 쪽 전체 렌더 뒤 다음 작업 틈에 미리 계산해 두고(`#scheduleStats`), 그 전에 planSave 가 부르면 그때 계산한다.
   */
  documentStats(): DocumentStatsDetail {
    return (this.#stats ??= computeDocumentStats(this.document));
  }

  /** 첫 쪽 전체 렌더 응답이 나간 뒤(Worker 의 다음 작업 틈) 통계를 계산하도록 한 번 예약한다. */
  #scheduleStats(): void {
    if (this.#stats || this.#statsTimer) return;
    this.#statsTimer = setTimeout(() => {
      this.#statsTimer = null;
      if (this.#doc) this.documentStats();
    }, 0);
  }

  searchText(request: SearchRequest): SearchResult {
    return searchDocument(this.document, request);
  }

  /**
   * 저장 전 판정. 로그가 더하는 변경 종류(`content-stream`·`font-embed`)를 `changes` 에 합치고 편집 요약
   * (`SavePlan.edits`)을 채운다. 편집을 커밋·재적용한 문서와 전체 저장을 한 번이라도 한 세션은 전체 저장이다
   * (docs/m3-contract.md D9·A3-9). 초안이 열려 있으면 예외.
   */
  planSave({ changes }: SaveRequest): SavePlan & { warnings: string[] } {
    const edit = this.#edit;
    if (edit?.hasDraft) {
      throw new EditStateError(
        '편집 초안이 열려 있어 저장할 수 없습니다. 먼저 커밋하거나 취소하세요.',
      );
    }
    const canBeSavedIncrementally = this.document.canBeSavedIncrementally();
    const size = this.#saveSize();
    const merged = [...new Set([...changes, ...(edit?.changeKinds() ?? [])])];
    let decision = decideSaveMethod(merged, canBeSavedIncrementally, size);
    if (
      decision.method === 'incremental' &&
      (this.#fullSaved || edit?.edited || edit?.hasNewObjects)
    ) {
      // 증분 구간에는 되돌린(undo) 객체의 흔적이 남을 수 있고 xref 형식도 섞인다(A3-9). 전체 저장으로 올린다.
      decision = {
        method: 'full',
        options: FULL_SAVE_OPTIONS,
        reason: this.#fullSaved
          ? '세션에서 전체 저장을 한 번 했음(A3-9)'
          : '편집을 시작한 문서(되돌린 객체 흔적·미사용 폴백 폰트, D9)',
        heap: estimateSaveHeap('full', size),
      };
    }
    if (!decision.heap) throw new Error('예상 피크 힙 계산 실패');
    return {
      method: decision.method,
      options: decision.options,
      reason: decision.reason,
      canBeSavedIncrementally,
      heap: decision.heap,
      edits: edit?.editSummary() ?? null,
      warnings: edit?.saveWarnings() ?? [],
    };
  }

  /**
   * 저장 힙 모델 입력(D5). 계수 모델은 Stream 입력에서 잰 값이라 Stream 열기이고 힙 측정 객체가 있을 때만 쓴다. 그 밖에는
   * 배율 모델(`ratio-v0`). 문서 통계를 아직 계산하지 않았으면 여기서 계산한다(첫 쪽 렌더 뒤 유휴 계산이 보통 먼저 끝난다).
   */
  #saveSize(): SaveSizeInput {
    const inputBytes = this.originalBytes.byteLength;
    const current = wasmHeapBytes();
    if (this.#inputMode !== 'stream' || current === null) {
      return {
        inputBytes,
        ...(this.#inputMode === 'stream' ? { ratio: STREAM_INPUT_PEAK_HEAP_RATIO } : {}),
      };
    }
    const stats = this.documentStats();
    return {
      inputBytes,
      model: {
        objectCount: stats.objectCount,
        rawStreamBytes: stats.rawStreamBytes,
        objectStreamBytes: stats.objectStreamBytes,
        approximate: stats.approximate,
        currentHeapBytes: current,
        baseHeapBytes: this.#baseHeapBytes ?? current,
        journalBytes: this.#edit?.journalBytes ?? 0,
      },
    };
  }

  /**
   * 저널 상한 판정(D4): 저널 보유 추정 + 예상 전체 저장 증가분이 경고선(저장 힙 warn 경계)을 넘으면 `advised`. 뷰어가 커밋
   * 뒤 "저장 후 다시 열기" 안내에 쓴다. 계수 모델을 쓸 수 없는 환경(Buffer 입력·힙 측정 없음)이면 저널 0 으로 본다.
   */
  journalAdvice(): JournalAdvice {
    return journalAdvice('full', this.#saveSize());
  }

  /** 저장. 편집 RPC 를 쓴 문서는 저널 작업으로 감싼다(`EditEngine.runSave`, D9). 초안이 열려 있으면 예외. */
  save(request: SaveRequest): SaveResult & { warnings: string[] } {
    const doc = this.document;
    const plan = this.planSave(request);
    const t0 = performance.now();
    const write = (): Uint8Array<ArrayBuffer> => {
      const buffer = doc.saveToBuffer(plan.options);
      try {
        return buffer.asUint8Array().slice();
      } finally {
        buffer.destroy();
      }
    };
    const bytes = this.#edit ? this.#edit.runSave(write) : write();
    if (plan.method === 'full') this.#fullSaved = true;
    return {
      bytes,
      method: plan.method,
      canBeSavedIncrementally: plan.canBeSavedIncrementally,
      options: plan.options,
      saveMs: performance.now() - t0,
      wasmHeapBytes: wasmHeapBytes(),
      heap: plan.heap,
      warnings: plan.warnings,
    };
  }

  // M3 문단 편집(docs/m3-contract.md 4절·5.7). 상태는 EditEngine 이 맡는다(docs/m3-core.md).

  get #engine(): EditEngine {
    return this.#edit ?? noDocument();
  }

  /** 폴백 폰트 로드 실패 사유(R-L5, 진단용). 폴백을 얻었거나 시도하지 않았으면 null. */
  get fallbackLoadError(): string | null {
    return this.#edit?.fallbackLoadError ?? null;
  }

  async getPageEditability(pageIndex: number): Promise<PageEditability> {
    return this.#engine.getPageEditability(pageIndex);
  }

  async planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan> {
    return this.#engine.planParagraphEdit(pageIndex, paragraphId);
  }

  async getPageEdits(pageIndex: number): Promise<PageEditInfo> {
    return this.#engine.getPageEdits(pageIndex);
  }

  async beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
    renderScale?: number,
  ): Promise<BeginEditResult> {
    return this.#engine.beginParagraphEdit(pageIndex, paragraphId, revision, renderScale);
  }

  /** 기존 Redact 주석 수·쪽(A2-2). 문서를 바꾸지 않는다. */
  listRedactAnnots(): RedactAnnotSummary {
    const report = listRedactAnnots(this.document);
    return { total: report.total, pages: report.pages };
  }

  async updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate> {
    return this.#engine.updateParagraphDraft(draftId, input);
  }

  async commitParagraphEdit(draftId: string): Promise<CommitResult> {
    return this.#engine.commitParagraphEdit(draftId);
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    return this.#engine.cancelParagraphEdit(draftId);
  }

  async planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan> {
    return this.#engine.planPathEdit(pageIndex, paintSeqs);
  }

  async beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult> {
    return this.#engine.beginPathEdit(pageIndex, paintSeqs, revision);
  }

  async updatePathDraft(
    draftId: string,
    edit: PathEdit,
    renderScale: number,
  ): Promise<PathDraftUpdate> {
    return this.#engine.updatePathDraft(draftId, edit, renderScale);
  }

  async commitPathEdit(draftId: string): Promise<CommitResult> {
    return this.#engine.commitPathEdit(draftId);
  }

  async cancelPathEdit(draftId: string): Promise<EditHistoryState> {
    return this.#engine.cancelPathEdit(draftId);
  }

  async undo(): Promise<EditHistoryState> {
    return this.#engine.undo();
  }

  async redo(): Promise<EditHistoryState> {
    return this.#engine.redo();
  }

  async getEditHistory(): Promise<EditHistoryState> {
    return this.#engine.getEditHistory();
  }

  async replayEdits(ops: EditOp[]): Promise<EditHistoryState> {
    return this.#engine.replayEdits(ops);
  }

  /** 편집 엔진에 빌려주는 쪽 캐시·렌더. */
  #editHost(doc: mupdf.PDFDocument): EditHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      document: doc,
      pageState: (pageIndex) => ({
        // 레이아웃과 같은 모델(세그먼트 포함). pdf-ops 패스 점 편집이 점 번호를 모델 세그먼트로 대조한다
        // (docs/m4-pdf-ops.md 7절 #4). 레이아웃이 이미 만든 캐시라 추출이 늘지 않는다.
        model: this.extractPage({ pageIndex, includePathSegments: true }),
        map: this.getSourceMap(pageIndex),
        linkage: this.linkPage(pageIndex),
        layout: this.getPageLayout(pageIndex),
      }),
      invalidateAround: (pageIndex) => this.invalidateAround(pageIndex),
      renderRegion: (pageIndex, scale, clip) => this.renderPage({ pageIndex, scale, clip }),
      get renderScale() {
        return self.#lastRenderScale;
      },
    };
  }

  close(): void {
    if (this.#statsTimer) clearTimeout(this.#statsTimer);
    this.#statsTimer = null;
    this.#stats = null;
    this.#pageCache.clear();
    this.#sourceMapCache.clear();
    this.#layoutCache.clear();
    this.#linkageCache.clear();
    this.#edit?.dispose();
    this.#edit = null;
    this.#doc?.destroy();
    this.#doc = null;
    this.#original = null;
  }
}
