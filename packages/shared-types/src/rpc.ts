/** Viewer → viewer-owned module Worker RPC contract (Comlink, PLAN.md 5.2). */
import type { Rect } from './geometry.js';
import type {
  BeginEditResult,
  BeginPathEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
} from './edit.js';
import type { ExtractRequest, PageModel } from './page-model.js';
import type { PageLayout } from './page-layout.js';
import type { JournalAdvice, SaveRequest, SavePlan, SaveResult } from './save.js';
import type { SearchRequest, SearchResult } from './search.js';
import type { PageLinkage, SourceMap } from './source-map.js';

export interface PageSize {
  /** pt */
  width: number;
  /** pt */
  height: number;
}

/** How the source was passed to WASM. With stream, the input is not copied into the WASM heap on open (A3-1). */
export type InputMode = 'buffer' | 'stream';

export interface OpenResult {
  pageCount: number;
  /** First page size. The rest are looked up lazily via getPageInfo. */
  firstPage: PageSize;
  byteLength: number;
  openMs: number;
  inputMode: InputMode;
  /**
   * Save heap model input (M5 D5). Computed when idle after the first page is displayed, so it may be empty at open time (not included in open time).
   */
  documentStats?: DocumentStats;
}

/** Document statistics (`docs/m5-contract.md` section 3). Streams are not decoded; only /Length is summed. */
export interface DocumentStats {
  objectCount: number;
  streamCount: number;
  /** Sum of original (compressed) stream /Length (byte). */
  rawStreamBytes: number;
  /** true if it exceeded 1 s and was estimated from fixed-interval samples. */
  approximate: boolean;
}

/** Optional argument of `replayEdits` (contract D4 user decision 2026-10-21: recovery progress display). */
export interface ReplayOptions {
  /** If true, the journal is not enabled after applying and the next `replayEdits` call continues. Omit it or use false for the last call. */
  more?: boolean;
}

/** Summary of existing Redact annotations (count and pages from pdf-ops listRedactAnnots). */
export interface RedactAnnotSummary {
  total: number;
  /** Pages with Redact annotations (0-based). */
  pages: number[];
}

export interface PageInfo {
  pageIndex: number;
  /** `Page.getBounds()`, page space. */
  bounds: Rect;
  size: PageSize;
  /** /Rotate with inheritance applied. */
  rotation: number;
}

export interface RenderRequest {
  pageIndex: number;
  /** 1 = 72dpi. The viewer passes the value multiplied by devicePixelRatio. */
  scale: number;
  /** Renders only this area (page space) (M3 edit preview). The whole page if absent. */
  clip?: Rect;
}

export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  /** RGBA, opaque white background. Length = width * height * 4. Passed from the Worker by transfer. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  renderMs: number;
  /** Area actually rendered (page space, snapped to the pixel grid). null for the whole page. */
  clip: Rect | null;
}

export interface PdfWorkerApi {
  open(bytes: ArrayBuffer): Promise<OpenResult>;
  getPageInfo(pageIndex: number): Promise<PageInfo>;
  renderPage(request: RenderRequest): Promise<RenderedPage>;
  /** Extraction model. The same page may be cached until the document changes. */
  extractPage(request: ExtractRequest): Promise<PageModel>;
  /** Source link info (for debug overlays and edit planning). */
  getSourceMap(pageIndex: number): Promise<SourceMap>;
  /** Matching of the extractPage + getSourceMap results. */
  linkPage(pageIndex: number): Promise<PageLinkage>;
  searchText(request: SearchRequest): Promise<SearchResult>;
  /** Page layout (paragraphs, columns, tables, figures, reading order, M2). The same page may be cached until the document changes. */
  getPageLayout(pageIndex: number): Promise<PageLayout>;
  /** Pre-save classification (mode, options, expected peak heap). Does not save. */
  planSave(request: SaveRequest): Promise<SavePlan>;
  save(request: SaveRequest): Promise<SaveResult>;
  /** Journal limit check (M5 D4). Does not modify the document. The viewer asks after an edit commit and uses it for the "저장 후 다시 열기" ("save and reopen") prompt. */
  journalAdvice(): Promise<JournalAdvice>;
  close(): Promise<void>;

  // M3 paragraph editing (docs/m3-contract.md section 4). At most one draft per document.
  /** Per-flow-paragraph editability of a page (batch classification for hover display). */
  getPageEditability(pageIndex: number): Promise<PageEditability>;
  /** Editability classification, start text and area. Does not modify the document. */
  planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan>;
  /** Edit blocks of this page. */
  getPageEdits(pageIndex: number): Promise<PageEditInfo>;
  /**
   * Opens a journal operation and creates a draft with removal and insertion applied. Throws if revision differs from the current one or the paragraph cannot be edited.
   */
  beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
    /** Render scale for first.region. If absent, the last whole-page render scale; if that is absent too, 2 (contract amendment 4). */
    renderScale?: number,
  ): Promise<BeginEditResult>;
  /** Reflow → replace edit block → render changed area. */
  updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate>;
  /** Closes the journal operation and puts the EditOp into the log. */
  commitParagraphEdit(draftId: string): Promise<CommitResult>;
  /** Discards the draft. */
  cancelParagraphEdit(draftId: string): Promise<EditHistoryState>;
  // M4 vector path editing (docs/m4-contract.md). A path draft and a paragraph draft cannot be open at the same time.
  planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan>;
  beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult>;
  updatePathDraft(draftId: string, edit: PathEdit, renderScale: number): Promise<PathDraftUpdate>;
  commitPathEdit(draftId: string): Promise<CommitResult>;
  cancelPathEdit(draftId: string): Promise<EditHistoryState>;
  undo(): Promise<EditHistoryState>;
  redo(): Promise<EditHistoryState>;
  getEditHistory(): Promise<EditHistoryState>;
  /** Number and pages of the document's existing Redact annotations (A2-2, reported on open, contract amendment 4). */
  listRedactAnnots(): Promise<RedactAnnotSummary>;
  /**
   * Reapplies the log to a newly opened document (Worker recovery, contract D6). If `options.more` is true, the journal is not enabled and the next
   * `replayEdits` continues (applied in chunks for the recovery progress display n/N, contract D4 user decision 2026-10-21).
   */
  replayEdits(ops: EditOp[], options?: ReplayOptions): Promise<EditHistoryState>;
}
