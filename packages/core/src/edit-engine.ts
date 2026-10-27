/**
 * Paragraph edit engine (M3, docs/m3-contract.md 4, 5.7, D6, D9, docs/m3-core.md). Owns the journal operations, edit log and draft of one document,
 * and calls pdf-ops and reflow only through `EditAdapter`. `PdfSession` lends its page cache and render to it as `EditHost`.
 *
 * State model
 * - Journal (MuPDF): one paragraph edit = one operation. Draft = open operation, commit = `endOperation`, cancel = `abandonOperation`.
 * - Log: `base` (re-applied with replayEdits, cannot be undone) + `undo` stack + `redo` stack. 1:1 with journal steps.
 * - While an operation is open, MuPDF throws from `canUndo()` and `getJournal()`, so all history queries are answered from this state.
 * - The moment an operation first changes an object, MuPDF discards the redo steps, and `abandonOperation` on that operation does not restore them
 *   (docs/m3-core.md 2.4). So the redo stack is aligned with the journal at the moment a draft starts and after a classification or save operation that changed objects.
 */
import * as mupdf from 'mupdf';
import type {
  BeginEditResult,
  BeginPathEditResult,
  ChangeKind,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  EditPathOp,
  ReplaceParagraphOp,
  EditWarning,
  EditedBlock,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
  ParagraphTarget,
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
  PathEditability,
  PathTarget,
  Rect,
  ReplayOptions,
  RenderedPage,
  ReflowSummary,
  SaveEditSummary,
  SaveWarningCode,
  TextRun,
} from '@pdf-editor/shared-types';
import type {
  EditAdapter,
  EditBlockRef,
  ParagraphEditContext,
  PreparedEdit,
  PathWriteResult,
  PreparedPathEdit,
} from './edit-adapter.js';
import {
  coreWarnings,
  declaresPdfA,
  ensureInfoDictionary,
  inflateRect,
  mergeWarnings,
  pathCoreWarnings,
  tagFallbackSubset,
  unionRect,
} from './edit-util.js';
import {
  compactStreams,
  embedFont,
  uncompressedStreams,
  type FallbackFontSource,
  type FontManager,
  type UncompressedStream,
} from '@pdf-editor/pdf-ops';

/** BaseFont name of the fallback font embedded in the document (a subset tag is attached on save). */
const FALLBACK_FONT_NAME = 'NotoSansKR';

/** No-change edit: used to revert to the original bytes when an update write failed and there is no previous edit. */
const IDENTITY_PATH_EDIT: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};

/** Margin (pt) added to the changed-area render. Same as the change-allowed area margin in contract 8.3. */
const REGION_MARGIN_PT = 2;

/** What the session lends to the edit engine. */
export interface EditHost {
  readonly document: mupdf.PDFDocument;
  /** Classification inputs on top of the page cache (extraction model, source link, matching, layout). */
  pageState(pageIndex: number): Pick<ParagraphEditContext, 'model' | 'map' | 'linkage' | 'layout'>;
  /** Clears that page's extraction, source-link and layout caches and the ±2-page layout caches (contract 5.7). */
  invalidateAround(pageIndex: number): void;
  renderRegion(pageIndex: number, scale: number, clip: Rect): RenderedPage;
  /** Scale of the last full-page render (scale of the first preview of beginParagraphEdit). */
  readonly renderScale: number;
}

export interface EditEngineOptions {
  adapter: EditAdapter;
  loadFallbackFont?: (() => Promise<Uint8Array>) | undefined;
  /** Generates edit ids and draft ids. Default `crypto.randomUUID()`. Fixed in tests. */
  createId?: (() => string) | undefined;
}

/** State where the edit RPCs cannot be used now (during a draft, no open document, reapply failure, etc.). */
export class EditStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditStateError';
  }
}

/** The revision in `beginParagraphEdit` differs from the current one (stale paragraph id). */
export class StaleRevisionError extends EditStateError {
  constructor(expected: number, actual: number) {
    super(`문서가 바뀌었습니다(revision ${actual}, 요청 ${expected}). 문단 판정을 다시 하세요.`);
    this.name = 'StaleRevisionError';
  }
}

/** Original block id of the paragraph edit that re-edited an edit block. null for path edits. */
function editedBlockOf(op: EditOp): string | null {
  return op.kind === 'replace-paragraph' ? op.target.editedBlock : null;
}

/** Log entry: one committed edit and its result. Distinguished by `op.kind` (docs/m4-contract.md 4.4). */
interface ParagraphLogEntry {
  op: ReplaceParagraphOp;
  warnings: EditWarning[];
  summary: ReflowSummary;
  /** The edit block actually used fallback font glyphs (even if only spaces were fallback, regardless of warnings). Basis for save subsetting and font-embed. */
  usesFallback: boolean;
}

/** Path edit entry: has no edit block or reflow, so it has neither a `summary` nor fallback font use. */
interface PathLogEntry {
  op: EditPathOp;
  warnings: EditWarning[];
}

type LogEntry = ParagraphLogEntry | PathLogEntry;

function isParagraphEntry(entry: LogEntry): entry is ParagraphLogEntry {
  return entry.op.kind === 'replace-paragraph';
}

const usesFallbackOf = (entry: LogEntry): boolean => isParagraphEntry(entry) && entry.usesFallback;

/** Pages the edit changes. For now both are the same page. Used by undo and redo for cache invalidation and meta recording. */
const pagesOf = (op: EditOp): number[] => [op.target.pageIndex];

/** Sum of /Length of the streams among the object numbers. Only dictionaries are queried (streams are not read). */
function streamLengths(doc: mupdf.PDFDocument, objectNumbers: readonly number[]): number {
  let sum = 0;
  for (const num of objectNumbers) {
    const obj = doc.newIndirect(num);
    try {
      if (!obj.isStream()) continue;
      const n = obj.get('Length');
      if (n.isNumber()) sum += Math.max(0, n.asNumber());
    } finally {
      obj.destroy();
    }
  }
  return sum;
}

interface ParagraphDraft {
  kind: 'paragraph';
  draftId: string;
  pageIndex: number;
  paragraphId: number;
  /** Page state at classification and removal time. Writes refer to the PageModel indices (sourceChar) of this moment. */
  ctx: ParagraphEditContext;
  plan: Omit<ParagraphEditPlan, 'revision'>;
  prepared: PreparedEdit;
  /** Edit id to record in the log. */
  opId: string;
  runs: TextRun[];
  format: ParagraphFormat;
  summary: ReflowSummary;
  warnings: EditWarning[];
  usesFallback: boolean;
  /** Failed to restore the previous state after an update failure. Only cancel is possible. */
  broken: boolean;
  /** Committing (waiting for stream compression, `#compactDraft`). During this time updates, commits and cancels of this draft are rejected. */
  committing?: boolean;
}

/**
 * Path draft. Writes are always absolute edits against the original bytes, so an update rewrites regardless of the previous state.
 * At start, `#redo` is cleared (MuPDF discards redo at the first change) and a backup is kept, so canceling without a change restores it.
 */
interface PathDraft {
  kind: 'path';
  draftId: string;
  pageIndex: number;
  ctx: ParagraphEditContext;
  plan: Omit<PathEditPlan, 'revision'>;
  prepared: PreparedPathEdit;
  opId: string;
  /** Last edit written. null if nothing was written yet (cannot commit). */
  edit: PathEdit | null;
  /** Path box after the last write (initially the target box). The "before edit" box of the next update. */
  bbox: Rect;
  warnings: EditWarning[];
  broken: boolean;
  redoBackup: LogEntry[];
  /** Committing (waiting for stream compression). */
  committing?: boolean;
}

type Draft = ParagraphDraft | PathDraft;

interface Composed {
  summary: ReflowSummary;
  warnings: EditWarning[];
  usesFallback: boolean;
}

export class EditEngine {
  readonly #host: EditHost;
  readonly #adapter: EditAdapter;
  readonly #options: EditEngineOptions;
  readonly #doc: mupdf.PDFDocument;

  #fonts: FontManager | null = null;
  #fallbackBytes: Uint8Array | null = null;
  #fallbackLoading: Promise<void> | null = null;
  /** Fallback font loading has failed before and has not been obtained (R-L5). Proceeds without a fallback. */
  #fallbackLoadError: string | null = null;
  /** Fallback font object embedded once just before the journal is turned on (outside an operation). null before that. */
  #fallbackRef: mupdf.PDFObject | null = null;

  #journalOn = false;
  /** A replay applied in parts (`replayEdits(…, { more: true })`) is in progress. The journal is still off. */
  #replayOpen = false;
  /** The document has been changed at least once by a commit or reapply (true even after undoing it). */
  #edited = false;
  #disposed = false;
  #failure: string | null = null;
  #revision = 0;
  #base: LogEntry[] = [];
  #undo: LogEntry[] = [];
  #redo: LogEntry[] = [];
  #draft: Draft | null = null;
  #blocks = new Map<number, EditBlockRef[]>();
  #lastAffected: number[] = [];
  #pdfa: boolean | null = null;
  /** Journal retention estimate (D4): for each committed operation, the sum of /Length of the stream objects it changed or created. */
  readonly #journalCost = new WeakMap<LogEntry, number>();

  constructor(host: EditHost, options: EditEngineOptions) {
    this.#host = host;
    this.#adapter = options.adapter;
    this.#options = options;
    this.#doc = host.document;
  }

  // ---- State queries ----

  get hasDraft(): boolean {
    return this.#draft !== null;
  }

  /** An edit RPC turned the journal on (later saves are D9 wrapped saves). */
  get journalOn(): boolean {
    return this.#journalOn;
  }

  /**
   * An edit has been reflected in the document at least once (true even after undoing). The incremental section may keep traces of undone objects,
   * so saving this document is a full save (D9, A3-9).
   */
  get edited(): boolean {
    return this.#edited;
  }

  /**
   * Turning on the journal put a fallback font (an unused object that garbage removes on save) and Info newly into the document. An incremental save appends all new objects,
   * so saving this document is a full save.
   */
  get hasNewObjects(): boolean {
    return this.#journalOn;
  }

  get revision(): number {
    return this.#revision;
  }

  /**
   * Journal retention estimate (bytes, D4). The journal holds the pre-operation content of objects changed by each operation (docs/m3-core.md 2.5: about
   * 0.97x of the replaced stream), and one undone step also remains for redo. So the cost of operations in the undo and redo lists is added. When a new edit
   * discards redo, that cost drops out too. Reapplied edits (`#base`) are outside the journal and are not counted.
   */
  get journalBytes(): number {
    let total = 0;
    for (const e of this.#undo) total += this.#journalCost.get(e) ?? 0;
    for (const e of this.#redo) total += this.#journalCost.get(e) ?? 0;
    return total;
  }

  /**
   * Journal cost of a committed operation: sum of /Length of streams among the changed and new objects reported by pdf-ops (`changedObjects`, including edit blocks) (dictionary
   * lookup only). For a paragraph edited for the first time, it covers the page content and the new block; for re-editing an existing block, only that block. Large streams are
   * compressed at commit (`#compactDraft`), so this is the compressed size. The first replacement of a stream that was in the original file may not make MuPDF copy the content, so this leans toward
   * overestimation (docs/m5-heap.md section 5).
   */
  #noteJournalCost(entry: LogEntry, changedObjects: readonly number[]): void {
    let bytes = 0;
    try {
      bytes = streamLengths(this.#doc, changedObjects);
    } catch {
      // It is an estimate, so use 0 on failure.
    }
    this.#journalCost.set(entry, bytes);
  }

  /**
   * Reason the fallback font load failed (R-L5). null if it succeeded or was not attempted. On failure, editing proceeds without a fallback and only characters
   * absent from the original font become `glyph-missing`. After the journal is on, a fallback font cannot be put into the document, so it is not retried.
   */
  get fallbackLoadError(): string | null {
    return this.#fallbackLoadError;
  }

  /** MuPDF journal position and step (null while an operation is open). For tests and diagnostics. */
  journalState(): { position: number; steps: string[] } | null {
    if (!this.#journalOn || this.#draft) return null;
    return this.#doc.getJournal();
  }

  /**
   * When closing the document (session close). Releases the pdf-ops draft state and FontManager (original font probes, fallback `mupdf.Font`) (R-L3).
   * May be called multiple times.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#draft = null;
    this.#releaseDraftState();
    this.#disposeFonts();
  }

  /**
   * Discards the pdf-ops draft state (WriteContext and path preparation state). There is one draft per document, so when a draft ends (commit, cancel, failure cleanup) and
   * after a reapply, all of this document's state is discarded. Cleanup failure does not affect the edit result, so it is swallowed.
   */
  #releaseDraftState(): void {
    try {
      this.#adapter.releaseEdit(this.#doc);
    } catch {
      // Cleanup that only drops references, so failure does not affect later behavior.
    }
  }

  #disposeFonts(): void {
    const fonts = this.#fonts;
    this.#fonts = null;
    try {
      fonts?.dispose();
    } catch {
      // Ignore release failure (already released, etc.).
    }
  }

  // ---- Classification (does not change the document) ----

  async getPageEditability(pageIndex: number): Promise<PageEditability> {
    await this.#prepareRead();
    this.#requireNoDraft('getPageEditability');
    const t0 = performance.now();
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const result = this.#probe(() => {
      const page = this.#adapter.planPageEditability(ctx, fonts);
      const paths = this.#planPaths(ctx);
      return { ...page, ...paths };
    });
    return { ...result, revision: this.#revision, ms: performance.now() - t0 };
  }

  async planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan> {
    await this.#prepareRead();
    this.#requireNoDraft('planParagraphEdit');
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const plan = this.#probe(() => this.#adapter.planParagraphEdit(ctx, fonts, paragraphId));
    return { ...plan, revision: this.#revision };
  }

  /**
   * Path classification list of a page (adapter result). A path classification error blocks only path edits of this page: returns an empty list and a diagnostic string
   * (`pathError`) and leaves paragraph classification as is (review M4).
   */
  #planPaths(ctx: ParagraphEditContext): { paths: PathEditability[]; pathError?: string } {
    try {
      return { paths: this.#adapter.planPathEditability(ctx) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { paths: [], pathError: message };
    }
  }

  /**
   * Edit block list of this page (based on the working document, cached per page). For layout reconstruction hints (docs/m3-integration.md 9.6).
   * An empty list if the list cannot be built (normal layout without hints).
   */
  editBlocks(pageIndex: number): EditBlockRef[] {
    try {
      return this.#blocksFor(pageIndex);
    } catch {
      return [];
    }
  }

  /** Edit blocks of this page (including draft blocks during a draft, based on the working document). */
  getPageEdits(pageIndex: number): PageEditInfo {
    this.#assertUsable();
    const entries = [...this.#base, ...this.#undo];
    const blocks: EditedBlock[] = [];
    for (const ref of this.#blocksFor(pageIndex)) {
      const draft = this.#draft;
      if (
        draft?.kind === 'paragraph' &&
        draft.pageIndex === pageIndex &&
        draft.prepared.block.objectNumber === ref.objectNumber
      ) {
        blocks.push({
          editId: ref.editId,
          contentBox: draft.summary.contentBox,
          area: draft.summary.area,
        });
        continue;
      }
      // A re-edit can keep the block id (op.id is newly created). Use the latest entry.
      const entry = [...entries]
        .reverse()
        .filter(isParagraphEntry)
        .find((e) => e.op.id === ref.editId || editedBlockOf(e.op) === ref.editId);
      if (entry) {
        blocks.push({
          editId: ref.editId,
          contentBox: entry.summary.contentBox,
          area: entry.summary.area,
        });
        continue;
      }
      const bounds = this.#adapter.blockBounds(this.#doc, pageIndex, ref.objectNumber);
      if (bounds) blocks.push({ editId: ref.editId, contentBox: bounds, area: bounds });
    }
    return { pageIndex, blocks };
  }

  // ---- Draft ----

  async beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
    renderScale?: number,
  ): Promise<BeginEditResult> {
    if (renderScale !== undefined && !(renderScale > 0)) {
      throw new RangeError('renderScale 은 0 보다 커야 함');
    }
    await this.#prepareEdit();
    this.#requireNoDraft('beginParagraphEdit');
    if (revision !== this.#revision) throw new StaleRevisionError(revision, this.#revision);
    const doc = this.#doc;
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const plan = this.#probe(() => this.#adapter.planParagraphEdit(ctx, fonts, paragraphId));
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 문단입니다: ${reasons || '사유 없음'}`);
    }
    const editId = this.#newId();
    const t0 = performance.now();
    doc.beginOperation('paragraph-edit');
    try {
      const prepared = this.#adapter.prepareParagraphEdit(ctx, plan, editId);
      const composed = this.#compose(ctx, plan, prepared, paragraphId, plan.runs, plan.format);
      const draft: ParagraphDraft = {
        kind: 'paragraph',
        draftId: this.#newId(),
        pageIndex,
        paragraphId,
        ctx,
        plan,
        prepared,
        opId: this.#uniqueOpId(prepared.editId, editId),
        runs: plan.runs,
        format: plan.format,
        summary: composed.summary,
        warnings: composed.warnings,
        usesFallback: composed.usesFallback,
        broken: false,
      };
      this.#blocks.set(pageIndex, this.#adapter.listEditBlocks(doc, pageIndex));
      this.#host.invalidateAround(pageIndex);
      const clip = inflateRect(
        unionRect(plan.target.bbox, composed.summary.contentBox),
        REGION_MARGIN_PT,
      );
      const region = this.#host.renderRegion(
        pageIndex,
        renderScale ?? this.#host.renderScale,
        clip,
      );
      this.#draft = draft;
      // MuPDF discarded the redo steps the moment the document was changed by removal or insertion (they do not come back even on cancel).
      this.#redo = [];
      return {
        draftId: draft.draftId,
        plan: { ...plan, revision: this.#revision },
        first: {
          draftId: draft.draftId,
          reflow: composed.summary,
          warnings: composed.warnings,
          region,
          updateMs: performance.now() - t0,
        },
      };
    } catch (error) {
      this.#rollback(pageIndex);
      throw error;
    }
  }

  async updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate> {
    this.#assertUsable();
    const draft = this.#requireParagraphDraft(draftId);
    if (!(input.renderScale > 0)) throw new RangeError('renderScale 은 0 보다 커야 함');
    if (draft.broken) throw new EditStateError('초안이 손상되어 갱신할 수 없습니다. 취소하세요.');
    const t0 = performance.now();
    const previous = draft.summary.contentBox;
    let composed: Composed;
    try {
      composed = this.#compose(
        draft.ctx,
        draft.plan,
        draft.prepared,
        draft.paragraphId,
        input.runs,
        input.format,
      );
    } catch (error) {
      // If the write failed midway, the document's block may be between the new and old content. Rewrite with the previous content,
      // and if that also fails, this draft allows only cancel (committing would make the log and document differ).
      try {
        this.#compose(
          draft.ctx,
          draft.plan,
          draft.prepared,
          draft.paragraphId,
          draft.runs,
          draft.format,
        );
      } catch {
        draft.broken = true;
      }
      this.#host.invalidateAround(draft.pageIndex);
      throw error;
    }
    draft.runs = input.runs;
    draft.format = input.format;
    draft.summary = composed.summary;
    draft.warnings = composed.warnings;
    draft.usesFallback = composed.usesFallback;
    this.#host.invalidateAround(draft.pageIndex);
    const clip = inflateRect(unionRect(previous, composed.summary.contentBox), REGION_MARGIN_PT);
    const region = this.#host.renderRegion(draft.pageIndex, input.renderScale, clip);
    return {
      draftId,
      reflow: composed.summary,
      warnings: composed.warnings,
      region,
      updateMs: performance.now() - t0,
    };
  }

  async commitParagraphEdit(draftId: string): Promise<CommitResult> {
    this.#assertUsable();
    const draft = this.#requireParagraphDraft(draftId);
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
    const large = this.#largeUncompressed([
      ...draft.prepared.changedObjects,
      draft.prepared.block.objectNumber,
    ]);
    if (large.length > 0) await this.#compactDraft(draft, large);
    const op: ReplaceParagraphOp = {
      kind: 'replace-paragraph',
      id: draft.opId,
      target: draft.prepared.target,
      runs: draft.runs,
      format: draft.format,
    };
    const entry: ParagraphLogEntry = {
      op,
      warnings: draft.warnings,
      summary: draft.summary,
      usesFallback: draft.usesFallback,
    };
    // Write Info inside this edit operation: it is recorded in the journal and moves together with undo and redo, and the save operation does not need to change
    // the document (changing it would drop the redo steps, docs/m3-core.md 2.4).
    this.#writeMetadata([...this.#active(), entry]);
    this.#doc.endOperation();
    this.#draft = null;
    this.#releaseDraftState();
    // If the operation closed but the journal steps did not increase (closed again after a close failure, etc.), the log and journal are out of sync.
    if (this.#doc.getJournal().position !== this.#undo.length + 1) {
      this.#failure = '커밋한 편집이 저널에 기록되지 않음';
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
    this.#undo.push(entry);
    this.#redo = [];
    this.#noteJournalCost(entry, [
      ...new Set([...draft.prepared.changedObjects, draft.prepared.block.objectNumber]),
    ]);
    this.#edited = true;
    this.#revision++;
    this.#touched([draft.pageIndex]);
    return { op, history: this.#history() };
  }

  // ---- M4 path editing (docs/m4-contract.md 4.4) ----

  /** Edit plan of the selected path. Does not change the document (if the journal is on, it is wrapped in an operation that is discarded). */
  async planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan> {
    this.#assertUsable();
    this.#requireNoDraft('planPathEdit');
    const ctx = this.#context(pageIndex);
    const plan = this.#probe(() => this.#adapter.planPathEdit(ctx, paintSeqs));
    return { ...plan, revision: this.#revision };
  }

  async beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult> {
    // Even if the first edit-family call is a path, the fallback font must be embedded before the journal is turned on so that later paragraph edits can use it.
    await this.#prepareEdit();
    this.#requireNoDraft('beginPathEdit');
    if (revision !== this.#revision) throw new StaleRevisionError(revision, this.#revision);
    const doc = this.#doc;
    const ctx = this.#context(pageIndex);
    const plan = this.#probe(() => this.#adapter.planPathEdit(ctx, paintSeqs));
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 패스입니다: ${reasons || '사유 없음'}`);
    }
    const editId = this.#newId();
    const redoBackup = this.#redo;
    doc.beginOperation('path-edit');
    try {
      const prepared = this.#adapter.preparePathEdit(ctx, plan, editId);
      const draft: PathDraft = {
        kind: 'path',
        draftId: this.#newId(),
        pageIndex,
        ctx,
        plan,
        prepared,
        opId: this.#uniqueOpId(prepared.editId, editId),
        edit: null,
        bbox: plan.target.bbox,
        warnings: [...plan.warnings],
        broken: false,
        redoBackup,
      };
      this.#host.invalidateAround(pageIndex);
      this.#draft = draft;
      // If preparation or the first write changes the document, MuPDF discards the redo steps. Canceling without a change restores them (`#cancelPath`).
      this.#redo = [];
      return { draftId: draft.draftId, plan: { ...plan, revision: this.#revision } };
    } catch (error) {
      this.#rollback(pageIndex);
      throw error;
    }
  }

  /**
   * Rewrites the edit content into the stream (inside an operation; an absolute edit against the original, so it can be called repeatedly) and renders the changed area (previous written box ∪ new box).
   * The previous box of the first update is the target box.
   */
  async updatePathDraft(
    draftId: string,
    edit: PathEdit,
    renderScale: number,
  ): Promise<PathDraftUpdate> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    if (!(renderScale > 0)) throw new RangeError('renderScale 은 0 보다 커야 함');
    if (draft.broken) throw new EditStateError('초안이 손상되어 갱신할 수 없습니다. 취소하세요.');
    const t0 = performance.now();
    const previous = draft.bbox;
    let written: ReturnType<EditAdapter['writePathEdit']>;
    try {
      written = this.#adapter.writePathEdit(draft.ctx, draft.prepared, edit);
    } catch (error) {
      // If the write failed midway, the stream may be between the new and old content. Rewrite the previous edit (or the no-change state if none)
      // to revert, and if that also fails, this draft allows only cancel (committing would make the log and document differ).
      try {
        if (draft.edit) this.#adapter.writePathEdit(draft.ctx, draft.prepared, draft.edit);
        else this.#adapter.writePathEdit(draft.ctx, draft.prepared, IDENTITY_PATH_EDIT);
      } catch {
        draft.broken = true;
      }
      this.#host.invalidateAround(draft.pageIndex);
      throw error;
    }
    draft.edit = edit;
    draft.bbox = written.bbox;
    draft.warnings = pathWarnings(draft.plan, edit, draft.ctx, written);
    this.#host.invalidateAround(draft.pageIndex);
    const clip = inflateRect(unionRect(previous, written.bbox), REGION_MARGIN_PT);
    const region = this.#host.renderRegion(draft.pageIndex, renderScale, clip);
    return {
      draftId,
      target: draft.prepared.target,
      bbox: written.bbox,
      warnings: draft.warnings,
      region,
      updateMs: performance.now() - t0,
    };
  }

  async commitPathEdit(draftId: string): Promise<CommitResult> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
    if (!draft.edit) {
      throw new EditStateError('적용된 변경이 없어 커밋할 수 없습니다. 취소하세요.');
    }
    const large = this.#largeUncompressed(draft.prepared.changedObjects);
    if (large.length > 0) await this.#compactDraft(draft, large);
    const op: EditPathOp = {
      kind: 'edit-path',
      id: draft.opId,
      target: draft.prepared.target,
      edit: draft.edit,
    };
    const entry: PathLogEntry = { op, warnings: draft.warnings };
    this.#writeMetadata([...this.#active(), entry]);
    this.#doc.endOperation();
    this.#draft = null;
    this.#releaseDraftState();
    if (this.#doc.getJournal().position !== this.#undo.length + 1) {
      this.#failure = '커밋한 편집이 저널에 기록되지 않음';
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
    this.#undo.push(entry);
    this.#redo = [];
    this.#noteJournalCost(entry, draft.prepared.changedObjects);
    this.#edited = true;
    this.#revision++;
    this.#touched(pagesOf(op));
    return { op, history: this.#history() };
  }

  async cancelPathEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    this.#draft = null;
    this.#releaseDraftState();
    this.#abandonOrFail();
    // If MuPDF still has redo after discarding the operation (the document was not changed), restore core's redo as well.
    this.#redo = this.#doc.canRedo() ? draft.redoBackup : [];
    this.#touched([draft.pageIndex]);
    return this.#history();
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requireParagraphDraft(draftId);
    this.#draft = null;
    this.#releaseDraftState();
    this.#abandonOrFail();
    this.#reconcileRedo();
    this.#touched([draft.pageIndex]);
    return this.#history();
  }

  // ---- undo / redo ----

  async undo(): Promise<EditHistoryState> {
    this.#assertUsable();
    this.#requireNoDraft('undo');
    const entry = this.#undo.pop();
    if (!entry) return this.#unchanged();
    try {
      this.#requireJournal(this.#doc.canUndo(), 'undo');
      this.#doc.undo();
    } catch (error) {
      this.#undo.push(entry);
      throw error;
    }
    this.#redo.push(entry);
    this.#revision++;
    this.#touched(pagesOf(entry.op));
    return this.#history();
  }

  async redo(): Promise<EditHistoryState> {
    this.#assertUsable();
    this.#requireNoDraft('redo');
    const entry = this.#redo.pop();
    if (!entry) return this.#unchanged();
    try {
      this.#requireJournal(this.#doc.canRedo(), 'redo');
      this.#doc.redo();
    } catch (error) {
      this.#redo.push(entry);
      throw error;
    }
    this.#undo.push(entry);
    this.#revision++;
    this.#touched(pagesOf(entry.op));
    return this.#history();
  }

  async getEditHistory(): Promise<EditHistoryState> {
    this.#assertUsable();
    return this.#history();
  }

  // ---- Recovery (D6) ----

  /**
   * Reapplies the log to a newly opened document. Applies with the journal off to reduce the heap, and turns the journal on afterwards (applied edits
   * cannot be undone). Usable only in a session that has never called an edit RPC. If it fails midway the document is only partly changed,
   * so all edit RPCs of this session are blocked and the document must be reopened.
   */
  async replayEdits(ops: EditOp[], options: ReplayOptions = {}): Promise<EditHistoryState> {
    await this.#loadFallbackBytes();
    this.#assertUsable();
    this.#requireNoDraft('replayEdits');
    if (this.#journalOn || this.#undo.length > 0 || (this.#base.length > 0 && !this.#replayOpen)) {
      throw new EditStateError(
        'replayEdits 는 편집 RPC 를 부르기 전, 새로 연 문서에서만 쓸 수 있습니다.',
      );
    }
    const fonts = this.#ensureFonts();
    // With the journal off, Info and the fallback font go into the base document. Reapplied characters use the fallback font, so create it first.
    this.#prepareDocument();
    const pages = new Set<number>(this.#replayOpen ? this.#lastAffected : []);
    const done = this.#base.length;
    for (const [index, op] of ops.entries()) {
      try {
        this.#replayOne(fonts, op);
      } catch (error) {
        this.#replayOpen = false;
        this.#failure = `재적용 실패(${done + index + 1}/${done + ops.length}번째, 편집 ${op.id})`;
        const reason = error instanceof Error ? error.message : String(error);
        throw new EditStateError(`${this.#failure}: ${reason}`);
      }
      for (const page of pagesOf(op)) pages.add(page);
      this.#releaseDraftState();
    }
    if (options.more === true) {
      // Applying in parts (contract D4 progress display): meta recording and turning on the journal are done once, in the last call.
      this.#replayOpen = true;
      this.#edited ||= ops.length > 0;
      this.#lastAffected = [...pages].sort((a, b) => a - b);
      return this.#history();
    }
    this.#replayOpen = false;
    if (this.#base.length > 0) {
      try {
        this.#writeMetadata(this.#base);
      } catch (error) {
        this.#failure = '재적용 뒤 메타 기록 실패';
        const reason = error instanceof Error ? error.message : String(error);
        throw new EditStateError(`${this.#failure}: ${reason}`);
      }
    }
    this.#startJournal();
    this.#edited ||= this.#base.length > 0;
    this.#revision++;
    this.#lastAffected = [...pages].sort((a, b) => a - b);
    return this.#history();
  }

  #replayOne(fonts: FontManager, op: EditOp): void {
    if (op.kind === 'edit-path') {
      this.#replayPath(op);
      return;
    }
    const pageIndex = op.target.pageIndex;
    const ctx = this.#context(pageIndex);
    const plans = new Map<number, Omit<ParagraphEditPlan, 'revision'>>();
    const planOf = (id: number): Omit<ParagraphEditPlan, 'revision'> => {
      let plan = plans.get(id);
      if (!plan) {
        plan = this.#adapter.planParagraphEdit(ctx, fonts, id);
        plans.set(id, plan);
      }
      return plan;
    };
    const paragraphId = findParagraphId(ctx, op.target, (id) => {
      try {
        return planOf(id).target;
      } catch {
        return null;
      }
    });
    const plan = planOf(paragraphId);
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 문단입니다: ${reasons || '사유 없음'}`);
    }
    const prepared = this.#adapter.prepareParagraphEdit(ctx, plan, op.id);
    const composed = this.#compose(ctx, plan, prepared, paragraphId, op.runs, op.format);
    this.#base.push({
      op,
      warnings: composed.warnings,
      summary: composed.summary,
      usesFallback: composed.usesFallback,
    });
    this.#touched([pageIndex], false);
  }

  /**
   * Path edit reapply (contract 4.4): the target is found by `paintSeq`, and the fingerprint (paint operator name, number of construct operators, box, construct operator hash) must match.
   * If it does not match, it fails without editing a different path. paintSeq is based on the model at apply time, so it is valid only when applied in log order.
   */
  #replayPath(op: EditPathOp): void {
    const pageIndex = op.target.pageIndex;
    const ctx = this.#context(pageIndex);
    const plan = this.#adapter.planPathEdit(ctx, op.target.paintSeqs);
    const mismatch = fingerprintMismatch(op.target, plan.target);
    if (mismatch) {
      throw new EditStateError(`재적용 대상 패스가 다름(${pageIndex + 1}쪽): ${mismatch}`);
    }
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 패스입니다: ${reasons || '사유 없음'}`);
    }
    const prepared = this.#adapter.preparePathEdit(ctx, plan, op.id);
    const written = this.#adapter.writePathEdit(ctx, prepared, op.edit);
    this.#base.push({
      op,
      warnings: pathWarnings(plan, op.edit, ctx, written),
    });
    this.#touched([pageIndex], false);
  }

  // ---- Save (D9) ----

  /** Pre-save summary (5.8) if there are active edits, otherwise null. */
  editSummary(): SaveEditSummary | null {
    const entries = this.#active();
    if (entries.length === 0) return null;
    return {
      pages: [...new Set(entries.flatMap((e) => pagesOf(e.op)))].sort((a, b) => a - b),
      structureUnlinked: this.#unlinkedBlocks(entries),
      pdfaDeclared: (this.#pdfa ??= declaresPdfA(this.#doc)),
    };
  }

  /**
   * Save change kinds the log adds (contract D9). `font-embed` if there is an active edit that actually used fallback font glyphs.
   * Same criterion as the subset swap in runSave (the `font-fallback` warning does not count space fallback, so it is not used as the criterion).
   */
  changeKinds(): ChangeKind[] {
    const entries = this.#active();
    if (entries.length === 0) return [];
    return entries.some(usesFallbackOf) ? ['content-stream', 'font-embed'] : ['content-stream'];
  }

  /**
   * Wraps a save in a journal operation: `beginOperation('save')` -> fallback subset swap -> `fn` (saveToBuffer) ->
   * `abandonOperation`. A save creates no journal step and the working document stays in its pre-save state. A document with the journal off
   * (no edit RPC ever called) is not wrapped. Throws if a draft is open.
   *
   * Contract D9 says to record Info (`recordEditMetadata`) inside this operation too, but changing objects inside the operation makes MuPDF
   * discard the redo steps, and they do not come back even on abandon. So Info is recorded inside the commit operation
   * (`commitParagraphEdit`), and this operation changes the document only when there is an active edit that used the fallback font (subset swap). In that case
   * a save right after undo loses redo (docs/m3-core.md 2.4).
   */
  runSave<T>(fn: () => T): T {
    if (this.#disposed) throw new EditStateError('문서가 닫혔습니다.');
    // R-M4: a failed engine state does not block saving. The journal state cannot be trusted, so export the current document as is without wrapping
    // (undo is already blocked, so a save step in the journal does no harm). Warnings are reported via `saveWarnings()`.
    if (this.#failure) {
      this.#finalizeFallbackBestEffort();
      return fn();
    }
    this.#requireNoDraft('save');
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    const usesFallback = this.#active().some(usesFallbackOf);
    doc.beginOperation('save');
    let result: T;
    try {
      if (usesFallback) {
        this.#fonts?.finalizeForSave();
        // R-L2: the pdf-ops subset swap leaves /BaseFont as is. Attach a subset tag to the font name in the saved file.
        if (this.#fallbackRef) tagFallbackSubset(this.#doc, this.#fallbackRef);
      }
      result = fn();
    } catch (error) {
      try {
        this.#abandonOrFail();
      } catch {
        // Prefer the original exception (the session is already marked unusable).
      }
      this.#reconcileRedo();
      throw error;
    }
    this.#abandonOrFail();
    this.#reconcileRedo();
    return result;
  }

  /**
   * Warnings to tell the user at save time (R-M4). If the engine is in a failed state, it saves without wrapping in the journal, so whether the last edit was reflected in the document
   * must be checked. Empty array when normal.
   */
  /** Cause code of `saveWarnings()` (for screens in other languages). */
  saveWarningCodes(): SaveWarningCode[] {
    return this.#failure ? ['edit-engine-failed'] : [];
  }

  saveWarnings(): string[] {
    if (!this.#failure) return [];
    return [
      `편집 엔진 오류(${this.#failure}) 상태에서 저장합니다. 저널 보호 없이 현재 문서를 그대로 내보냅니다.`,
      '마지막 편집이 빠졌거나 일부만 반영됐을 수 있고, 취소한 초안의 변경이 저장 파일에 들어갈 수 있습니다. 저장 뒤 파일을 확인하고 문서를 다시 여세요.',
    ];
  }

  /**
   * Even in a failed-state save (R-M4), tries the fallback subset swap (D9) and the subset name tag (R-L2). Not wrapped in the journal, so it stays
   * in the working document, but this session's edit RPCs are blocked and it is not written again (both steps give the same result for the same input). Failures are ignored
   * (it is saved with the full font and an untagged name, but the content is the same).
   */
  #finalizeFallbackBestEffort(): void {
    try {
      if (!this.#active().some(usesFallbackOf)) return;
      this.#fonts?.finalizeForSave();
      if (this.#fallbackRef) tagFallbackSubset(this.#doc, this.#fallbackRef);
    } catch {
      // Best effort: continue saving.
    }
  }

  // ---- Internals ----

  #active(): LogEntry[] {
    return [...this.#base, ...this.#undo];
  }

  #history(): EditHistoryState {
    return {
      revision: this.#revision,
      activeEditIds: this.#active().map((e) => e.op.id),
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      edits: this.#base.length + this.#undo.length,
      affectedPages: [...this.#lastAffected],
    };
  }

  /** undo/redo with nothing to do: changes neither the document nor the revision. */
  #unchanged(): EditHistoryState {
    this.#lastAffected = [];
    return this.#history();
  }

  /** Updates the caches and block lists of pages whose document changed (contract 5.7). */
  #touched(pages: number[], affected = true): void {
    for (const page of pages) {
      this.#host.invalidateAround(page);
      try {
        this.#blocks.set(page, this.#adapter.listEditBlocks(this.#doc, page));
      } catch {
        // The document and log have already changed. The list is rebuilt the next time it is needed.
        this.#blocks.delete(page);
      }
    }
    if (affected) this.#lastAffected = [...pages].sort((a, b) => a - b);
  }

  #requireJournal(ok: boolean, what: string): void {
    if (!ok) throw new EditStateError(`로그와 MuPDF 저널이 어긋남: ${what} 불가`);
  }

  #newId(): string {
    return (this.#options.createId ?? (() => crypto.randomUUID()))();
  }

  #uniqueOpId(preferred: string | undefined, fallback: string): string {
    const taken = new Set([...this.#base, ...this.#undo, ...this.#redo].map((e) => e.op.id));
    return preferred && !taken.has(preferred) ? preferred : fallback;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new EditStateError('문서가 닫혔습니다.');
    if (this.#failure) {
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
  }

  #requireNoDraft(what: string): void {
    if (this.#draft) {
      throw new EditStateError(
        `편집 초안이 열려 있어 ${what} 를 할 수 없습니다. 먼저 커밋하거나 취소하세요.`,
      );
    }
  }

  #requireDraft(draftId: string): Draft {
    const draft = this.#draft;
    if (!draft || draft.draftId !== draftId) {
      throw new EditStateError(`열린 초안이 아닙니다: ${draftId}`);
    }
    if (draft.committing) throw new EditStateError(`커밋하는 중인 초안입니다: ${draftId}`);
    return draft;
  }

  /**
   * Just before commit (inside the draft operation): compresses with Flate the large streams this edit rewrote uncompressed (page content, Form copies, large edit blocks).
   * The MuPDF journal keeps the pre-operation content of objects changed by each operation as the whole stream buffer, so once compressed, the buffer that goes to the journal when the next edit changes this page again
   * is the compressed size, not the uncompressed one (docs/m5-followup.md 5.1, corpus 8.9 MB page -> 1.35 MB). It is within the same operation,
   * so no journal step is added. Compression is asynchronous, so the draft is blocked as `committing` meanwhile. If it cannot be compressed, it is left uncompressed (behavior is
   * the same and it only saves less memory). If the inserted stream cannot be reverted either, the draft is left as broken and the commit is rejected (canceling returns to before the operation).
   */
  async #compactDraft(draft: Draft, streams: readonly UncompressedStream[]): Promise<void> {
    // Block before the first await (so that a second commit of the same draft does not slip in while waiting for compression).
    draft.committing = true;
    try {
      await compactStreams(this.#doc, streams, () => !this.#disposed && this.#draft === draft);
    } catch {
      draft.broken = true;
    } finally {
      draft.committing = false;
    }
    this.#assertUsable();
    if (this.#draft !== draft) throw new EditStateError('커밋하는 동안 초안이 바뀌었습니다.');
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
  }

  /**
   * Large streams to compress among the objects the commit changed (page content and Form copies written uncompressed, etc., `COMPACT_MIN_BYTES` or more). If there are none, the commit finishes without waiting,
   * as before. If picking fails (read error), nothing is compressed.
   */
  #largeUncompressed(objectNumbers: readonly number[]): UncompressedStream[] {
    try {
      return uncompressedStreams(this.#doc, objectNumbers);
    } catch {
      return [];
    }
  }

  #requireParagraphDraft(draftId: string): ParagraphDraft {
    const draft = this.#requireDraft(draftId);
    if (draft.kind !== 'paragraph') {
      throw new EditStateError(`패스 초안입니다(문단 RPC 로 다룰 수 없음): ${draftId}`);
    }
    return draft;
  }

  #requirePathDraft(draftId: string): PathDraft {
    const draft = this.#requireDraft(draftId);
    if (draft.kind !== 'path') {
      throw new EditStateError(`문단 초안입니다(패스 RPC 로 다룰 수 없음): ${draftId}`);
    }
    return draft;
  }

  #requireFonts(): FontManager {
    if (!this.#fonts) throw new EditStateError('편집 준비가 되지 않았습니다.');
    return this.#fonts;
  }

  /**
   * Preparation of a classification RPC: load fallback font bytes (if it fails, proceed without a fallback, R-L5) -> FontManager. Does not change the document or turn on the journal. At this stage
   * `FallbackFontSource.ref()` is null (contract 5.7).
   */
  async #prepareRead(): Promise<void> {
    await this.#loadFallbackBytes();
    this.#assertUsable();
    this.#ensureFonts();
  }

  /**
   * Preparation of the first `beginParagraphEdit`: classification preparation -> Info dictionary and fallback font embedding (outside the journal, once) -> turn on the journal. Objects created
   * outside the journal do not disappear on edit cancel or undo (contract D4 and D9 fix 1, docs/m3-core.md 2.2 and 2.3).
   */
  async #prepareEdit(): Promise<void> {
    await this.#prepareRead();
    if (this.#journalOn) return;
    if (this.#replayOpen) {
      throw new EditStateError('재적용이 끝나지 않았습니다(replayEdits 마지막 호출 전).');
    }
    this.#prepareDocument();
    this.#startJournal();
  }

  /** Once, before turning on the journal (outside an operation): create the Info dictionary and embed the fallback font. */
  #prepareDocument(): void {
    ensureInfoDictionary(this.#doc);
    if (!this.#fallbackRef && this.#fallbackBytes) {
      const { font, ref } = embedFont(this.#doc, FALLBACK_FONT_NAME, this.#fallbackBytes);
      // The document holds the font file stream. The parsed `mupdf.Font` is no longer used, so release it right away (R-L3, about 4 MB per cycle).
      font.destroy();
      // Font dictionary marker: lets the fallback font be recognized inside the document (it becomes a subset in the saved file).
      ref.put('PdfEditorFallback', this.#doc.newBoolean(true));
      this.#fallbackRef = ref;
    }
  }

  #startJournal(): void {
    this.#doc.enableJournal();
    this.#journalOn = true;
  }

  /**
   * Loads the fallback font bytes. Even on failure it does not raise an exception (R-L5) and proceeds without a fallback: if `FallbackFontSource.bytes()`
   * throws, FontManager treats it as no fallback, and only characters absent from the original font become `glyph-missing`. Failures are not cached,
   * so the next call before the journal is turned on tries again.
   */
  async #loadFallbackBytes(): Promise<void> {
    const load = this.#options.loadFallbackFont;
    if (this.#fallbackBytes || !load) return;
    // After the journal is on, a fallback font cannot be embedded, so retrying would not make it usable.
    if (this.#fallbackLoadError !== null && this.#journalOn) return;
    const pending = (this.#fallbackLoading ??= load().then((bytes) => {
      this.#fallbackBytes = bytes;
    }));
    try {
      await pending;
      if (this.#fallbackLoadError !== null) {
        // FontManager caches the no-fallback classification. If obtained late, build a new one (no state before the edit).
        this.#fallbackLoadError = null;
        this.#disposeFonts();
      }
    } catch (error) {
      this.#fallbackLoadError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#fallbackLoading === pending) this.#fallbackLoading = null;
    }
  }

  #ensureFonts(): FontManager {
    const source: FallbackFontSource = {
      bytes: () => {
        if (!this.#fallbackBytes) {
          throw new EditStateError(
            '폴백 폰트가 없습니다(PdfSessionOptions.loadFallbackFont 미설정).',
          );
        }
        return this.#fallbackBytes;
      },
      ref: () => this.#fallbackRef,
    };
    this.#fonts ??= this.#adapter.createFonts(this.#doc, source);
    return this.#fonts;
  }

  #context(pageIndex: number): ParagraphEditContext {
    return {
      doc: this.#doc,
      pageIndex,
      ...this.#host.pageState(pageIndex),
      editBlocks: this.#blocksFor(pageIndex),
    };
  }

  #blocksFor(pageIndex: number): EditBlockRef[] {
    let blocks = this.#blocks.get(pageIndex);
    if (!blocks) {
      blocks = this.#adapter.listEditBlocks(this.#doc, pageIndex);
      this.#blocks.set(pageIndex, blocks);
    }
    return blocks;
  }

  /**
   * Wraps a classification call in a discarded operation. Classification must not change the document, but even if font assignment makes changes such as inserting a fallback font,
   * a change outside an operation throws on a document with the journal on, and a remaining change would put the undo steps out of sync.
   */
  #probe<T>(fn: () => T): T {
    // While the journal is off (before the first `beginParagraphEdit`) the document cannot be changed, so no wrapping is needed.
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    doc.beginOperation('probe');
    let result: T;
    try {
      result = fn();
    } catch (error) {
      try {
        this.#abandonOrFail();
      } catch {
        // Prefer the original exception (the session is already marked unusable).
      }
      this.#reconcileRedo();
      throw error;
    }
    this.#abandonOrFail();
    this.#reconcileRedo();
    return result;
  }

  /** Discards the open operation. If it cannot be discarded the operation stays open and later operations would overlap, so the session is left in an unusable state. */
  #abandonOrFail(): void {
    try {
      this.#doc.abandonOperation();
    } catch (error) {
      this.#failure = '저널 작업을 버리지 못함';
      throw error;
    }
  }

  /** Number of edited paragraphs whose structure link was broken: for items that re-edited the same block, only the last one is counted (contract 5.8). */
  #unlinkedBlocks(entries: LogEntry[]): number {
    // For paragraph edits, only the last entry of a block chain counts; for path edits (Form duplication clears /StructParents), every entry counts.
    const paragraphs = entries.filter(isParagraphEntry);
    const byId = new Map(paragraphs.map((e) => [e.op.id, e]));
    const rootOf = (e: ParagraphLogEntry): string => {
      let cur = e;
      const seen = new Set<string>();
      for (
        let block = editedBlockOf(cur.op);
        block && !seen.has(cur.op.id);
        block = editedBlockOf(cur.op)
      ) {
        seen.add(cur.op.id);
        const parent = byId.get(block);
        if (!parent) return block;
        cur = parent;
      }
      return cur.op.id;
    };
    const latest = new Map<string, LogEntry>();
    for (const e of paragraphs) latest.set(rootOf(e), e);
    return (
      [...latest.values()].filter((e) => hasWarning(e, 'tagged-structure-unlinked')).length +
      entries.filter((e) => !isParagraphEntry(e) && hasWarning(e, 'tagged-structure-unlinked'))
        .length
    );
  }

  /**
   * If MuPDF discarded the redo steps (abandon after changing objects inside an operation), core's redo stack is cleared too. Call only when no operation
   * is open.
   */
  #reconcileRedo(): void {
    if (this.#redo.length > 0 && !this.#doc.canRedo()) this.#redo = [];
  }

  /** Records Info `/PdfEditorEdits` from the active edits (including reapplied ones) (contract 5.6). Call inside an open operation or while the journal is off. */
  #writeMetadata(entries: LogEntry[]): void {
    this.#adapter.recordEditMetadata(this.#doc, {
      pages: [...new Set(entries.flatMap((e) => pagesOf(e.op)))].sort((a, b) => a - b),
      structureNotUpdated: entries.some(
        (e) => hasWarning(e, 'tagged-structure-kept') || hasWarning(e, 'tagged-structure-unlinked'),
      ),
    });
  }

  /** Discards the open draft operation and reverts the caches (begin failure path). */
  #rollback(pageIndex: number): void {
    try {
      this.#abandonOrFail();
      this.#reconcileRedo();
    } catch {
      // Prefer the original exception (the session is already marked unusable).
    }
    this.#draft = null;
    this.#releaseDraftState();
    this.#host.invalidateAround(pageIndex);
    this.#blocks.delete(pageIndex);
  }

  /** Font assignment -> reflow -> edit block write. Common to draft and reapply. Call inside an open journal operation (or with the journal off). */
  #compose(
    ctx: ParagraphEditContext,
    plan: Omit<ParagraphEditPlan, 'revision'>,
    prepared: PreparedEdit,
    paragraphId: number,
    runs: TextRun[],
    format: ParagraphFormat,
  ): Composed {
    const fonts = this.#requireFonts();
    const text = runs.map((r) => r.text).join('');
    const { segments, warnings: fontWarnings } = fonts.assign(ctx, text, runs);
    const result = this.#adapter.layoutParagraph({
      text,
      segments,
      format,
      areaLimit: plan.areaLimit,
    });
    this.#adapter.writeEditBlock(ctx, prepared, runs, format, result, fonts);
    // Fallback use is decided by the glyphs actually used: used if the layout result has even one glyph in a range assigned to the fallback face.
    const fallbackKeys = new Set(
      segments.flatMap((seg) => (seg.face?.kind === 'fallback' ? [seg.face.key] : [])),
    );
    const usesFallback =
      fallbackKeys.size > 0 &&
      result.lines.some((line) => line.some((g) => fallbackKeys.has(g.faceKey)));
    const warnings = mergeWarnings(
      plan.warnings,
      fontWarnings,
      coreWarnings({
        summary: result.summary,
        areaLimit: plan.areaLimit,
        layout: ctx.layout,
        paragraphId,
        originalBox: plan.target.bbox,
      }),
    );
    return { summary: result.summary, warnings, usesFallback };
  }
}

/**
 * Path edit warnings = plan warnings + write warnings (same kinds merged into one). If the adapter gives write warnings (pdf-ops `pathEditWarnings`, including an empty
 * array), only those are used; if not, the core approximation (`pathCoreWarnings`) substitutes. Using both together would let a false positive of the approximation
 * (`table-rule-removed`) override the accurate classification.
 */
function pathWarnings(
  plan: Omit<PathEditPlan, 'revision'>,
  edit: PathEdit,
  ctx: ParagraphEditContext,
  written: PathWriteResult,
): EditWarning[] {
  return mergeWarnings(
    plan.warnings,
    written.warnings ?? pathCoreWarnings(plan, edit, ctx.layout),
    [],
  );
}

function hasWarning(entry: LogEntry, kind: EditWarning['kind']): boolean {
  return entry.warnings.some((w) => w.kind === kind);
}

/** Tolerance for comparing fingerprint boxes (S1 fills them rounded to 1e-3 pt). */
const FINGERPRINT_BOX_TOLERANCE = 2e-3;

/** How the log's path target differs from the current plan's target (null if none). paintSeq was found by the plan from the log value, so only fingerprints are compared. */
export function fingerprintMismatch(logged: PathTarget, current: PathTarget): string | null {
  if (logged.fingerprints.length !== current.fingerprints.length) {
    return `칠하기 연산 수 ${logged.fingerprints.length} → ${current.fingerprints.length}`;
  }
  for (const [k, want] of logged.fingerprints.entries()) {
    const got = current.fingerprints[k]!;
    if (want.paintOp !== got.paintOp)
      return `${k + 1}번째 칠하기 연산 ${want.paintOp} → ${got.paintOp}`;
    if (want.constructOpCount !== got.constructOpCount) {
      return `${k + 1}번째 구성 연산 수 ${want.constructOpCount} → ${got.constructOpCount}`;
    }
    if (want.constructHash !== got.constructHash) return `${k + 1}번째 구성 연산 해시 불일치`;
    if (want.bbox.some((v, i) => Math.abs(v - got.bbox[i]!) > FINGERPRINT_BOX_TOLERANCE)) {
      return `${k + 1}번째 패스 상자 불일치`;
    }
  }
  return null;
}

const sortedEqual = (a: number[], b: number[]): boolean =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/**
 * Finds, in the current page layout, the paragraph that matches the log's target glyph list (glyphSeq). Reapply goes in the same order,
 * so the PageModel at apply time must be the same and the glyph list must match (contract `ParagraphTarget`).
 */
export function findParagraphId(
  ctx: ParagraphEditContext,
  target: ParagraphTarget,
  targetOf?: (paragraphId: number) => ParagraphTarget | null,
): number {
  const wanted = target.glyphSeqs;
  if (target.cell && wanted.length > 0) return findCellParagraphId(ctx, target, target.cell);
  if (wanted.length > 0) {
    for (const paragraph of ctx.layout.paragraphs) {
      if (paragraph.chars.length !== wanted.length) continue;
      if (paragraph.chars.every((ci, k) => ctx.model.chars[ci]?.glyphSeq === wanted[k])) {
        return paragraph.id;
      }
    }
    // Re-editing an edit block (R4): the layout may split the committed block's lines into several paragraphs or merge them with a neighboring paragraph's lines. In that case
    // classification emits only the block's first paragraph and widens the target characters to the whole block (pdf-ops analyzeParagraph), so the log's
    // glyphSeqs equals no layout paragraph. For each paragraph that has block characters, check that the plan's target equals the log's.
    if (target.editedBlock !== null && targetOf) {
      const wantedSet = new Set(wanted);
      const seqOf = (ci: number): number => ctx.model.chars[ci]?.glyphSeq ?? -1;
      const candidates = ctx.layout.paragraphs
        .filter((p) => p.chars.some((ci) => wantedSet.has(seqOf(ci))))
        .sort(
          (a, b) =>
            Number(b.chars.some((ci) => seqOf(ci) === wanted[0])) -
            Number(a.chars.some((ci) => seqOf(ci) === wanted[0])),
        );
      for (const paragraph of candidates) {
        const planned = targetOf(paragraph.id);
        if (
          planned &&
          planned.editedBlock === target.editedBlock &&
          planned.glyphSeqs.length === wanted.length &&
          planned.glyphSeqs.every((seq, k) => seq === wanted[k])
        ) {
          return paragraph.id;
        }
      }
    }
  }
  throw new EditStateError(
    `재적용 대상 문단을 찾지 못함(${ctx.pageIndex + 1}쪽, 글리프 ${wanted.length}개)`,
  );
}

/**
 * Cell target (D1): after widening to the table cell that the paragraph with `glyphSeqs[0]` belongs to, returns that paragraph id only if all the cell's paragraph glyphs equal the log's `glyphSeqs` and the cell
 * position (table, row, column) is the same. Order is not considered (paragraph order within a cell is decided by pdf-ops start-state rules,
 * and reapply uses the log's runs, so set equality is enough for determinism).
 */
function findCellParagraphId(
  ctx: ParagraphEditContext,
  target: ParagraphTarget,
  cell: NonNullable<ParagraphTarget['cell']>,
): number {
  const wanted = target.glyphSeqs;
  const seqOf = (ci: number): number => ctx.model.chars[ci]?.glyphSeq ?? -1;
  const owner = ctx.layout.paragraphs.find((p) => p.chars.some((ci) => seqOf(ci) === wanted[0]));
  const table =
    owner && owner.table !== null ? ctx.layout.tables.find((t) => t.id === owner.table) : null;
  const found = table?.cells.find((c) => owner && c.paragraphs.includes(owner.id));
  if (
    owner &&
    table &&
    found &&
    table.id === cell.table &&
    found.row === cell.row &&
    found.col === cell.col
  ) {
    const seqs = found.paragraphs.flatMap((id) => {
      const paragraph = ctx.layout.paragraphs.find((p) => p.id === id);
      return paragraph ? paragraph.chars.map(seqOf) : [];
    });
    if (sortedEqual(seqs, wanted)) return owner.id;
  }
  throw new EditStateError(
    `재적용 대상 셀을 찾지 못함(${ctx.pageIndex + 1}쪽, 표 ${cell.table} ${cell.row}행 ${cell.col}열, 글리프 ${wanted.length}개)`,
  );
}
