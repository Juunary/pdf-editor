/**
 * Worker recovery layer (contract D6, A3-3). When the viewer-owned Worker becomes unusable due to a fatal error (wasm trap, out of memory, script error),
 * it creates a new Worker, opens the kept original (`Blob`), and reapplies the kept edit log (`EditOp` + `activeEditIds`) with `replayEdits`.
 *
 * - Read RPCs (render, extract, classification, etc.) are retried once automatically after recovery.
 * - Write and draft RPCs are not retried because state has changed; they are reported with `WorkerRecoveredError`. The caller (viewer UI)
 *   restarts the draft with the editor model or asks again about saving.
 * - Calls that arrive with a draft id from a pre-recovery generation are not sent to the new Worker; they get the same error back.
 * - Even if several calls fail at the same time, recovery runs only once.
 * - Recovery checkpoint (contract D4 user decision 2026-10-21): when a user save succeeds (`confirmSaved`), those saved bytes become the checkpoint,
 *   and on recovery the checkpoint is opened and only the edits after it are reapplied. If the active log does not start with the checkpoint's edits (edits before the save were undone),
 *   the original plus the whole active log is reapplied. When recovering from the checkpoint, the checkpoint becomes this session's original.
 * - Reapply sends edits one at a time (`replayEdits(…, { more })`) and reports progress (n/N) through `onProgress`.
 */
import type {
  EditHistoryState,
  EditOp,
  ExtractRequest,
  PdfWorkerApi,
  RedactAnnotSummary,
  RenderRequest,
  ReplayOptions,
  SaveRequest,
  SearchRequest,
} from '@pdf-editor/shared-types';
import { WORKER_RECOVERED_ERROR_NAME } from '@pdf-editor/viewer-ui';

/** Document recovery failure. The on-screen sentence is built from the name (viewer-ui error-text.ts, user decision 2026-10-26). */
export class RecoveryFailedError extends Error {
  override name = 'RecoveryFailedError';
}

export class WorkerRecoveredError extends Error {
  override name = WORKER_RECOVERED_ERROR_NAME;
  constructor(
    message: string,
    /** Number of edits reapplied during recovery. */
    readonly replayedEdits: number,
  ) {
    super(message);
  }
}

/** One Worker (Comlink remote + terminate + fatal error signal). */
export interface WorkerHandle {
  api: PdfWorkerApi;
  terminate(): void;
  /** Rejects when the Worker dies (`error`, `messageerror`). Used to cut off calls that would never get a response. */
  dead: Promise<never>;
}

export interface EditLogSnapshotLike {
  ops: EditOp[];
  activeEditIds: string[];
}

export interface RecoveryInfo {
  cause: string;
  replayedEdits: number;
  /** true if recovered from a save checkpoint (false if the whole log was reapplied from the original). */
  fromSavedBaseline: boolean;
  history: EditHistoryState | null;
  recoveries: number;
}

export interface RecoveryDeps {
  spawn(): WorkerHandle;
  /** Hands the bytes to the Worker without copying (the original ArrayBuffer is emptied after the call). */
  transfer(bytes: ArrayBuffer): ArrayBuffer;
  /** Edit log used for recovery. */
  editLog(): EditLogSnapshotLike;
  /** Called asynchronously after recovery finishes (avoids deadlock from waiting on RPCs during recovery). */
  onRecovered(info: RecoveryInfo): void | Promise<void>;
  /** Recovery progress: `done = 0` after open, then `done + 1` each time one edit is reapplied (`total` overall). */
  onProgress?(done: number, total: number): void;
  log(event: string, data?: unknown): void;
}

/** Recovery checkpoint: the saved bytes and the edit ids included in that save (active log order at save time). */
interface SavedBaseline {
  blob: Blob;
  editIds: string[];
}

/** If the checkpoint is a prefix of the current active log, the edits after it; otherwise null. */
export function opsAfterBaseline(
  log: EditLogSnapshotLike,
  baselineIds: readonly string[],
): EditOp[] | null {
  if (baselineIds.length > log.activeEditIds.length) return null;
  for (const [i, id] of baselineIds.entries()) if (log.activeEditIds[i] !== id) return null;
  const after = new Set(log.activeEditIds.slice(baselineIds.length));
  return log.ops.filter((op) => after.has(op.id));
}

/** Whether this is a fatal Worker error: wasm trap, out of memory, Worker script error. Not a regular document error (MuPDF exception). */
export function isFatalWorkerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'WorkerCrash' || error.name === 'RuntimeError') return true;
  return /abort\(|Aborted\(|out of memory|memory access out of bounds|unreachable|table index is out of bounds|null function|WebAssembly\.Memory|Cannot enlarge memory|Maximum memory size/i.test(
    error.message,
  );
}

/** Read RPCs that may be retried automatically after recovery. */
const RETRY_AFTER_RECOVERY = new Set<keyof PdfWorkerApi>([
  'getPageInfo',
  'renderPage',
  'extractPage',
  'getSourceMap',
  'linkPage',
  'searchText',
  'getPageLayout',
  'planSave',
  'journalAdvice',
  'getPageEditability',
  'planParagraphEdit',
  'planPathEdit',
  'getPageEdits',
  'getEditHistory',
]);

type DraftMethod =
  | 'updateParagraphDraft'
  | 'commitParagraphEdit'
  | 'cancelParagraphEdit'
  | 'updatePathDraft'
  | 'commitPathEdit'
  | 'cancelPathEdit';

export class ResilientPdf implements PdfWorkerApi {
  private current: WorkerHandle;
  private epoch = 0;
  private recovering: Promise<void> | null = null;
  /** The state where recovery failed and the document cannot be used (the next open clears it). */
  private broken: Error | null = null;
  private recoveries = 0;
  private original: Blob | null = null;
  /**
   * Edit ids already contained in `original`. When recovering from a checkpoint, they become checkpoint edits. So that those edits are not applied twice even if recovery happens again
   * before the viewer log is replaced with the new session history, they are dropped when the active log starts with these ids.
   */
  private originIds: string[] = [];
  /** Recovery checkpoint confirmed when a user save succeeded. */
  private baseline: SavedBaseline | null = null;
  /** The last `save` result (becomes the checkpoint once a user save success is confirmed). */
  private pendingSave: SavedBaseline | null = null;
  /** Draft id → the Worker generation that created that draft. */
  private readonly drafts = new Map<string, number>();

  constructor(private readonly deps: RecoveryDeps) {
    this.current = deps.spawn();
  }

  /** Number of recoveries so far (for diagnostics and tests). */
  get recoveryCount(): number {
    return this.recoveries;
  }

  private async invoke<T>(name: keyof PdfWorkerApi, args: unknown[]): Promise<T> {
    const retry = RETRY_AFTER_RECOVERY.has(name);
    for (let attempt = 0; ; attempt++) {
      if (this.recovering) await this.recovering;
      if (this.broken) throw this.broken;
      const handle = this.current;
      try {
        const fn = (handle.api as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[
          name
        ]!;
        return await Promise.race([fn.apply(handle.api, args), handle.dead]);
      } catch (e) {
        if (!isFatalWorkerError(e)) throw e;
        await this.recover(handle, e);
        if (retry && attempt === 0) continue;
        throw new WorkerRecoveredError(
          `작업 모듈이 중단되어 문서를 복구했습니다(${name} 호출은 다시 시도하지 않았습니다)`,
          this.deps.editLog().ops.length,
        );
      }
    }
  }

  /** If the call came with a draft from a pre-recovery generation, do not send it to the new Worker. */
  private checkDraft(method: DraftMethod, draftId: string): void {
    if (this.drafts.get(draftId) !== this.epoch) {
      throw new WorkerRecoveredError(
        `작업 모듈이 복구되어 초안 ${draftId} 이 사라졌습니다(${method})`,
        this.deps.editLog().ops.length,
      );
    }
  }

  private recover(failed: WorkerHandle, cause: unknown): Promise<void> {
    if (failed !== this.current) return this.recovering ?? Promise.resolve(); // already replaced
    this.recovering ??= this.doRecover(failed, cause).finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async doRecover(failed: WorkerHandle, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    if (!this.original) throw new RecoveryFailedError(`문서를 복구하지 못했습니다(${message})`);
    this.deps.log('worker-recover-start', { cause: message, epoch: this.epoch + 1 });
    failed.terminate();
    this.epoch++;
    this.drafts.clear();
    const handle = this.deps.spawn();
    this.current = handle;
    try {
      const log = this.deps.editLog();
      const baseline = this.baseline;
      const afterBaseline = baseline ? opsAfterBaseline(log, baseline.editIds) : null;
      const fromSavedBaseline = baseline !== null && afterBaseline !== null;
      const source = fromSavedBaseline ? baseline.blob : this.original;
      const ops = afterBaseline ?? opsAfterBaseline(log, this.originIds) ?? log.ops;
      this.deps.log('worker-recover-source', {
        fromSavedBaseline,
        baselineEdits: baseline?.editIds.length ?? null,
        replay: ops.length,
        activeEdits: log.ops.length,
      });
      this.deps.onProgress?.(0, ops.length);
      const bytes = await source.arrayBuffer();
      await handle.api.open(this.deps.transfer(bytes));
      // Send one at a time to report progress. Turning on the journal and recording metadata happen once, on the last call (core `replayEdits` more).
      for (const [i, op] of ops.entries()) {
        await handle.api.replayEdits([op], { more: i < ops.length - 1 });
        this.deps.onProgress?.(i + 1, ops.length);
      }
      if (fromSavedBaseline) {
        // The new session's document starts from the checkpoint. Later recovery also uses these bytes + this session's active log.
        this.original = baseline.blob;
        this.originIds = baseline.editIds;
        this.baseline = null;
        this.pendingSave = null;
      }
      let history: EditHistoryState | null = null;
      try {
        history = await handle.api.getEditHistory();
      } catch {
        history = null; // configuration without edit RPCs (M3 not implemented)
      }
      this.recoveries++;
      const info: RecoveryInfo = {
        cause: message,
        replayedEdits: ops.length,
        fromSavedBaseline,
        history,
        recoveries: this.recoveries,
      };
      this.deps.log('worker-recovered', info);
      setTimeout(() => {
        void Promise.resolve(this.deps.onRecovered(info)).catch((e: unknown) =>
          this.deps.log('worker-recovered-handler-error', String(e)),
        );
      }, 0);
    } catch (e) {
      this.deps.log('worker-recover-failed', String(e));
      this.broken = new RecoveryFailedError(
        `문서를 복구하지 못했습니다. 파일을 다시 열어 주세요: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw this.broken;
    }
  }

  // ── PdfWorkerApi ───────────────────────────────────────────────────

  async open(bytes: ArrayBuffer): Promise<Awaited<ReturnType<PdfWorkerApi['open']>>> {
    // The original is kept as a Blob before open (transfer empties the ArrayBuffer, so this Blob is reopened on recovery).
    this.original = new Blob([bytes]);
    this.originIds = [];
    this.baseline = null;
    this.pendingSave = null;
    this.drafts.clear();
    if (this.broken) {
      // A Worker that failed to recover is discarded and a new one is started.
      this.broken = null;
      this.current.terminate();
      this.current = this.deps.spawn();
      this.epoch++;
    }
    return this.invoke('open', [this.deps.transfer(bytes)]);
  }

  getPageInfo(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['getPageInfo']>>>('getPageInfo', [
      pageIndex,
    ]);
  }

  renderPage(request: RenderRequest) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['renderPage']>>>('renderPage', [request]);
  }

  extractPage(request: ExtractRequest) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['extractPage']>>>('extractPage', [request]);
  }

  getSourceMap(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['getSourceMap']>>>('getSourceMap', [
      pageIndex,
    ]);
  }

  linkPage(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['linkPage']>>>('linkPage', [pageIndex]);
  }

  searchText(request: SearchRequest) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['searchText']>>>('searchText', [request]);
  }

  getPageLayout(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['getPageLayout']>>>('getPageLayout', [
      pageIndex,
    ]);
  }

  planSave(request: SaveRequest) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['planSave']>>>('planSave', [request]);
  }

  journalAdvice() {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['journalAdvice']>>>('journalAdvice', []);
  }

  async save(request: SaveRequest) {
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['save']>>>('save', [request]);
    // Keep the saved bytes as a checkpoint candidate (copy). `confirmSaved` promotes it to the checkpoint only when the user save succeeded.
    this.pendingSave = {
      blob: new Blob([result.bytes]),
      editIds: [...this.deps.editLog().activeEditIds],
    };
    return result;
  }

  /** The user save succeeded: use the last `save` result as the recovery checkpoint (contract D4). */
  confirmSaved(): void {
    if (this.pendingSave) this.baseline = this.pendingSave;
    this.pendingSave = null;
  }

  /** Discards a non-user-save `save` result, such as a measurement, from the checkpoint candidate. */
  discardPendingSave(): void {
    this.pendingSave = null;
  }

  /** For diagnostics and tests: edit ids of the confirmed checkpoint (null if none). */
  get baselineEditIds(): string[] | null {
    return this.baseline ? [...this.baseline.editIds] : null;
  }

  close() {
    return this.invoke<void>('close', []);
  }

  getPageEditability(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['getPageEditability']>>>(
      'getPageEditability',
      [pageIndex],
    );
  }

  planParagraphEdit(pageIndex: number, paragraphId: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['planParagraphEdit']>>>(
      'planParagraphEdit',
      [pageIndex, paragraphId],
    );
  }

  getPageEdits(pageIndex: number) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['getPageEdits']>>>('getPageEdits', [
      pageIndex,
    ]);
  }

  async beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
    renderScale?: number,
  ) {
    const epoch = this.epoch;
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['beginParagraphEdit']>>>(
      'beginParagraphEdit',
      [pageIndex, paragraphId, revision, renderScale],
    );
    if (epoch === this.epoch) this.drafts.set(result.draftId, epoch);
    return result;
  }

  async updateParagraphDraft(
    draftId: string,
    input: Parameters<PdfWorkerApi['updateParagraphDraft']>[1],
  ) {
    this.checkDraft('updateParagraphDraft', draftId);
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['updateParagraphDraft']>>>(
      'updateParagraphDraft',
      [draftId, input],
    );
  }

  async commitParagraphEdit(draftId: string) {
    this.checkDraft('commitParagraphEdit', draftId);
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['commitParagraphEdit']>>>(
      'commitParagraphEdit',
      [draftId],
    );
    this.drafts.delete(draftId);
    return result;
  }

  async cancelParagraphEdit(draftId: string) {
    this.checkDraft('cancelParagraphEdit', draftId);
    const result = await this.invoke<EditHistoryState>('cancelParagraphEdit', [draftId]);
    this.drafts.delete(draftId);
    return result;
  }

  planPathEdit(pageIndex: number, paintSeqs: number[]) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['planPathEdit']>>>('planPathEdit', [
      pageIndex,
      paintSeqs,
    ]);
  }

  async beginPathEdit(pageIndex: number, paintSeqs: number[], revision: number) {
    const epoch = this.epoch;
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['beginPathEdit']>>>(
      'beginPathEdit',
      [pageIndex, paintSeqs, revision],
    );
    if (epoch === this.epoch) this.drafts.set(result.draftId, epoch);
    return result;
  }

  async updatePathDraft(
    draftId: string,
    edit: Parameters<PdfWorkerApi['updatePathDraft']>[1],
    renderScale: number,
  ) {
    this.checkDraft('updatePathDraft', draftId);
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['updatePathDraft']>>>('updatePathDraft', [
      draftId,
      edit,
      renderScale,
    ]);
  }

  async commitPathEdit(draftId: string) {
    this.checkDraft('commitPathEdit', draftId);
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['commitPathEdit']>>>(
      'commitPathEdit',
      [draftId],
    );
    this.drafts.delete(draftId);
    return result;
  }

  async cancelPathEdit(draftId: string) {
    this.checkDraft('cancelPathEdit', draftId);
    const result = await this.invoke<EditHistoryState>('cancelPathEdit', [draftId]);
    this.drafts.delete(draftId);
    return result;
  }

  undo() {
    return this.invoke<EditHistoryState>('undo', []);
  }

  redo() {
    return this.invoke<EditHistoryState>('redo', []);
  }

  getEditHistory() {
    return this.invoke<EditHistoryState>('getEditHistory', []);
  }

  replayEdits(ops: EditOp[], options?: ReplayOptions) {
    return this.invoke<EditHistoryState>('replayEdits', [ops, options]);
  }

  /** Redact annotation report (A2-2, `PdfWorkerApi.listRedactAnnots`, contract amendment 4). */
  listRedactAnnots() {
    return this.invoke<RedactAnnotSummary>('listRedactAnnots', []);
  }

  /** For the on-open report: null if it fails or the result shape differs (only the report is skipped). */
  async tryListRedactAnnots(): Promise<RedactAnnotSummary | null> {
    try {
      const report = await this.listRedactAnnots();
      return report && typeof report.total === 'number' ? report : null;
    } catch {
      return null;
    }
  }
}
