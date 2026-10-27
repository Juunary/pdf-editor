// Keep as the first import: the Module settings object must be registered before mupdf initializes so that the WASM heap measurement (`wasmHeapBytes`) is connected. The Worker bundle
// puts this module and mupdf in one chunk and runs them in import order (if placed later, the save-heap model falls back to the ratio model, docs/m5-heap.md 4.3).
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
  usedHeapAfterSave,
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
  ReplayOptions,
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

/** Maximum number of pages for which extraction models and source-link info are cached (extraction models are counted per request kind). */
const PAGE_CACHE_LIMIT = 16;

/** Model without path segments (the remaining arrays are shared). */
function withoutPathSegments(model: PageModel): PageModel {
  return {
    ...model,
    paths: model.paths.map((p) => (p.segments === null ? p : { ...p, segments: null })),
  };
}

/** Takes from the most-recently-used cache and moves the entry up in the order. */
function touch<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** Inserts, and if over the limit, drops the oldest entry. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);
  if (cache.size > PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

export interface PdfSessionOptions {
  /**
   * Bytes of the Korean fallback font (Noto Sans KR glyf subset TTF). Called once, the first time paragraph editing needs it
   * (docs/m3-contract.md 5.7). The extension reads a bundled file; Node tests read a file under assets/fonts.
   */
  loadFallbackFont?: () => Promise<Uint8Array>;
  /** Boundary of the pdf-ops and reflow edit functions (docs/m3-core.md section 3). The default is the real implementation; tests inject a fake. */
  editAdapter?: EditAdapter;
  /** Generates edit ids and draft ids (default `crypto.randomUUID()`). Fixed in tests. */
  createId?: () => string;
}

/** Render scale of the changed-area render when no full-page render has ever been done (first preview of `beginParagraphEdit`). */
const DEFAULT_RENDER_SCALE = 2;

function noDocument(): never {
  throw new Error('열린 문서 없음');
}

/**
 * State of one document. Created only inside the viewer-owned Worker (PLAN.md 5.2).
 * The original bytes are kept for reapplying the edit log (PLAN.md 3.2).
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
  /** A full save has been done at least once in this session (A3-9: later saves are also full saves). */
  #fullSaved = false;
  /** Default of the save-heap model: WASM heap right after the document finished opening (D5). null if there is no measurement object. */
  #baseHeapBytes: number | null = null;
  /** Input of the save-heap model (D5). Computed once, at idle after the first page render or at the first planSave. */
  #stats: DocumentStatsDetail | null = null;
  #statsTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Record of the previous save (H1): that save's in-use heap estimate and the WASM heap right after the save (measured peak). Used so that the next planSave does not count the space the save used and freed
   * as in use (`usedHeapAfterSave`). Cleared when a document is newly opened.
   */
  #lastSave: { usedHeapBytes: number; heapAfterBytes: number } | null = null;

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
   * Opens the document. The default is Stream input (A3-1): MuPDF reads only the needed ranges of the retained original bytes,
   * so no WASM heap of the input size is used. `buffer` is for comparison and measurement.
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
    this.#lastSave = null;
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
   * Page render. If `clip` (page space) is given, only that area is rendered and the actual area aligned to the pixel grid is returned in `RenderedPage.clip`
   * (M3 edit preview). If an edit draft is open, the document in draft state is drawn (docs/m3-contract.md D7).
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
   * Page extraction model. The same request is cached until the document changes (most recently used, at most PAGE_CACHE_LIMIT pages),
   * and the same object is returned. The caller does not modify it. After editing the document, call `invalidatePageCache`.
   */
  extractPage(request: ExtractRequest): PageModel {
    const withSegments = request.includePathSegments === true;
    const key = `${request.pageIndex}:${withSegments ? 1 : 0}`;
    const cached = touch(this.#pageCache, key);
    if (cached) return cached;
    // Page classification (M5 4.1): if, after the extraction for the text layer (without path segments), the edit classification asks again for an extraction with segments,
    // the same page content is interpreted twice. Collect segments in one pass, and build the model without segments from it.
    const page = this.document.loadPage(request.pageIndex);
    let full: PageModel;
    try {
      full = extractPageModel(page, { ...request, includePathSegments: true });
    } finally {
      page.destroy();
    }
    const plain = withoutPathSegments(full);
    remember(this.#pageCache, `${request.pageIndex}:1`, full);
    remember(this.#pageCache, `${request.pageIndex}:0`, plain);
    return withSegments ? full : plain;
  }

  /**
   * Clears the extraction, source-link info and layout caches. If a page is given, only that page. Call it after the document content (content, resources, page order)
   * changes.
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
   * Page layout (M2, docs/m2-contract.md). Reconstructed from the extraction model including path segments, and cached with the same
   * rule as the extraction cache (most recently used, at most PAGE_CACHE_LIMIT pages). The caller does not modify the result.
   */
  getPageLayout(pageIndex: number): PageLayout {
    const cached = touch(this.#layoutCache, pageIndex);
    if (cached) return cached;
    // Extraction models of neighboring pages (±1, ±2): for classifying repeated running heads and page numbers (contract 2.5). Goes through the extraction cache.
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
   * For each edit block, the group of lines holding its characters (layout reconstruction hint `fixedGroups`, docs/m3-integration.md 9.6). A committed edit
   * block is one paragraph in the page layout (the overlay and reading order do not split a block into several paragraphs or merge it with a neighboring paragraph).
   * The block list comes from the edit engine cache (updated at commit, undo, redo and draft start), and membership is decided by the source link (linkPage). For a page
   * with no blocks, no source link is created. It is cleared together with the layout cache (invalidateAround), so it is not cached separately.
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
   * Source-link info of a page. Cached per page like extractPage and returns the same object. `linkPage` adds `unmatched` to this object's
   * `ops[].limits`, so getSourceMap after linkPage carries that mark.
   */
  getSourceMap(pageIndex: number): SourceMap {
    const cached = touch(this.#sourceMapCache, pageIndex);
    if (cached) return cached;
    const map = buildSourceMap(this.document, pageIndex);
    remember(this.#sourceMapCache, pageIndex, map);
    return map;
  }

  /**
   * Matches the cached extraction model with the source-link info (marks `unmatched` on the source-link info). Cached per page and returns the same
   * object (cleared by `invalidatePageCache`).
   */
  linkPage(pageIndex: number): PageLinkage {
    // If the source-link info dropped out of the cache and was rebuilt, match again (the `unmatched` mark is attached to that object).
    const map = this.getSourceMap(pageIndex);
    const cached = touch(this.#linkageCache, pageIndex);
    if (cached && cached.map === map) return cached.linkage;
    const linkage = linkPage(this.extractPage({ pageIndex }), map);
    remember(this.#linkageCache, pageIndex, { map, linkage });
    return linkage;
  }

  /**
   * Clears the caches of pages whose document changed. Layouts of neighboring pages (the header/footer repetition check uses this page's extraction model, M2) are also
   * cleared up to ±2 pages (docs/m3-contract.md 5.7).
   */
  invalidateAround(pageIndex: number): void {
    this.invalidatePageCache(pageIndex);
    for (const k of [-2, -1, 1, 2]) this.#layoutCache.delete(pageIndex + k);
  }

  /**
   * Input of the save-heap model (D5, `computeDocumentStats`). Computed on first call and kept until the document is closed. So that it is not added to open time,
   * it is precomputed in the next gap after the first full page render (`#scheduleStats`); if planSave calls before that, it is computed then.
   */
  documentStats(): DocumentStatsDetail {
    return (this.#stats ??= computeDocumentStats(this.document, { bytes: this.originalBytes }));
  }

  /** Schedules once to compute stats after the first full page render response is sent (in the Worker's next gap between tasks). */
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
   * Pre-save classification. Merges the change kinds the log adds (`content-stream`, `font-embed`) into `changes` and fills the edit summary
   * (`SavePlan.edits`). A document with committed or reapplied edits, and a session that has done a full save even once, gets a full save
   * (docs/m3-contract.md D9, A3-9). Throws if a draft is open.
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
      // The incremental section may keep traces of undone objects and mixes xref formats (A3-9). Promote to a full save.
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
      warningCodes: edit?.saveWarningCodes() ?? [],
    };
  }

  /**
   * Input of the save-heap model (D5). The coefficient model was measured with Stream input, so it is used only for Stream opens when a heap measurement object exists. Otherwise the
   * ratio model (`ratio-v0`). If document stats have not been computed yet, they are computed here (the idle computation after the first page render usually finishes first).
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
    const last = this.#lastSave;
    return {
      inputBytes,
      model: {
        objectCount: stats.objectCount,
        rawStreamBytes: stats.rawStreamBytes,
        objectStreamBytes: stats.objectStreamBytes,
        approximate: stats.approximate,
        currentHeapBytes: current,
        ...(last
          ? {
              usedHeapBytes: usedHeapAfterSave(last, current),
              priorSavePeakBytes: last.heapAfterBytes,
            }
          : {}),
        baseHeapBytes: this.#baseHeapBytes ?? current,
        journalBytes: this.#edit?.journalBytes ?? 0,
      },
    };
  }

  /**
   * Journal limit check (D4): `advised` if journal retention estimate + expected full-save increase exceeds the warning line (save-heap warn boundary). The viewer uses it after a commit
   * for the "save and reopen" notice. In environments where the coefficient model cannot be used (Buffer input, no heap measurement), the journal is taken as 0.
   */
  journalAdvice(): JournalAdvice {
    return journalAdvice('full', this.#saveSize());
  }

  /** Save. A document that used edit RPCs is wrapped in a journal operation (`EditEngine.runSave`, D9). Throws if a draft is open. */
  save(request: SaveRequest): SaveResult & { warnings: string[] } {
    const doc = this.document;
    const plan = this.planSave(request);
    const t0 = performance.now();
    // From the second save on, clear the resource cache the render accumulated (MuPDF store: decoded images, fonts, etc.) before saving. The cache piled up inside the free space the previous save left
    // does not show up as heap size, so the in-use heap estimate (`usedHeapAfterSave`) misses it (without clearing, 2 corpus cases are missed). Before the first
    // save it is not cleared: clearing made the save peak bigger because of free fragments (synthetic image 900 pages 1,370 -> 1,924 MiB, docs/m5-heap.md 4.4).
    if (this.#lastSave) mupdf.emptyStore();
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
    const heapAfter = wasmHeapBytes();
    if (heapAfter !== null && plan.heap.usedHeapBytes !== undefined) {
      this.#lastSave = { usedHeapBytes: plan.heap.usedHeapBytes, heapAfterBytes: heapAfter };
    }
    return {
      bytes,
      method: plan.method,
      canBeSavedIncrementally: plan.canBeSavedIncrementally,
      options: plan.options,
      saveMs: performance.now() - t0,
      wasmHeapBytes: heapAfter,
      heap: plan.heap,
      warnings: plan.warnings,
    };
  }

  // M3 paragraph editing (docs/m3-contract.md section 4 and 5.7). State is held by EditEngine (docs/m3-core.md).

  get #engine(): EditEngine {
    return this.#edit ?? noDocument();
  }

  /** Reason the fallback font load failed (R-L5, for diagnostics). null if the fallback was obtained or not attempted. */
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

  /** Number and pages of existing Redact annotations (A2-2). Does not change the document. */
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

  async replayEdits(ops: EditOp[], options?: ReplayOptions): Promise<EditHistoryState> {
    return this.#engine.replayEdits(ops, options);
  }

  /** Page cache and render lent to the edit engine. */
  #editHost(doc: mupdf.PDFDocument): EditHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      document: doc,
      pageState: (pageIndex) => ({
        // Same model as the layout (including segments). pdf-ops path point editing matches point numbers against the model segments
        // (docs/m4-pdf-ops.md section 7 #4). It is a cache the layout already built, so extraction does not increase.
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
