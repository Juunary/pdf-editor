/**
 * Worker 복구 계층(계약 D6, A3-3). 뷰어 소유 Worker 가 치명 오류(wasm 트랩·메모리 부족·스크립트 오류)로 쓸 수 없게 되면
 * 새 Worker 를 만들고, 보관한 원본(`Blob`)을 열고, 보관한 편집 로그(`EditOp` + `activeEditIds`)를 `replayEdits` 로 다시 적용한다.
 *
 * - 읽기 RPC(렌더·추출·판정 등)는 복구 뒤 한 번 자동으로 다시 시도한다.
 * - 쓰기·초안 RPC 는 상태가 바뀌었으므로 다시 시도하지 않고 `WorkerRecoveredError` 로 알린다. 호출한 쪽(뷰어 UI)이
 *   초안을 편집기 모델로 다시 시작하거나 저장을 다시 묻는다.
 * - 복구 전 세대의 초안 id 로 온 호출은 새 Worker 로 보내지 않고 같은 오류로 돌려준다.
 * - 동시에 여러 호출이 실패해도 복구는 한 번만 한다.
 * - 복구 기준점(계약 D4 사용자 결정 2026-10-21): 사용자 저장이 성공하면(`confirmSaved`) 그 저장 바이트를 기준점으로 삼고,
 *   복구 때 기준점을 열어 그 뒤 편집만 재적용한다. 활성 로그가 기준점 편집으로 시작하지 않으면(저장 전 편집까지 되돌림)
 *   원본 + 활성 로그 전체를 재적용한다. 기준점에서 복구하면 기준점이 이 세션의 원본이 된다.
 * - 재적용은 한 건씩 나눠 보내고(`replayEdits(…, { more })`) 진행(n/N)을 `onProgress` 로 알린다.
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

/** 문서 복구 실패. 화면 문장은 이름으로 만든다(viewer-ui error-text.ts, 사용자 결정 2026-10-26). */
export class RecoveryFailedError extends Error {
  override name = 'RecoveryFailedError';
}

export class WorkerRecoveredError extends Error {
  override name = WORKER_RECOVERED_ERROR_NAME;
  constructor(
    message: string,
    /** 복구하면서 다시 적용한 편집 수. */
    readonly replayedEdits: number,
  ) {
    super(message);
  }
}

/** Worker 한 개(Comlink 원격 + 종료 + 치명 오류 신호). */
export interface WorkerHandle {
  api: PdfWorkerApi;
  terminate(): void;
  /** Worker 가 죽으면(`error`·`messageerror`) reject 된다. 응답을 영영 못 받는 호출을 끊는 데 쓴다. */
  dead: Promise<never>;
}

export interface EditLogSnapshotLike {
  ops: EditOp[];
  activeEditIds: string[];
}

export interface RecoveryInfo {
  cause: string;
  replayedEdits: number;
  /** 저장 기준점에서 복구했으면 true(원본에서 전체 로그를 재적용했으면 false). */
  fromSavedBaseline: boolean;
  history: EditHistoryState | null;
  recoveries: number;
}

export interface RecoveryDeps {
  spawn(): WorkerHandle;
  /** 바이트를 복사 없이 Worker 로 넘긴다(호출 뒤 원본 ArrayBuffer 는 비워진다). */
  transfer(bytes: ArrayBuffer): ArrayBuffer;
  /** 복구에 쓸 편집 로그. */
  editLog(): EditLogSnapshotLike;
  /** 복구가 끝난 뒤 비동기로 호출한다(복구 중 RPC 를 기다리는 교착을 피한다). */
  onRecovered(info: RecoveryInfo): void | Promise<void>;
  /** 복구 진행: 열기 뒤 `done = 0`, 편집을 하나 다시 적용할 때마다 `done + 1`(전체 `total`). */
  onProgress?(done: number, total: number): void;
  log(event: string, data?: unknown): void;
}

/** 복구 기준점: 저장한 바이트와 그 저장에 들어간 편집 id(저장 시점 활성 로그 순서). */
interface SavedBaseline {
  blob: Blob;
  editIds: string[];
}

/** 기준점이 지금 활성 로그의 앞부분이면 그 뒤 편집만, 아니면 null. */
export function opsAfterBaseline(
  log: EditLogSnapshotLike,
  baselineIds: readonly string[],
): EditOp[] | null {
  if (baselineIds.length > log.activeEditIds.length) return null;
  for (const [i, id] of baselineIds.entries()) if (log.activeEditIds[i] !== id) return null;
  const after = new Set(log.activeEditIds.slice(baselineIds.length));
  return log.ops.filter((op) => after.has(op.id));
}

/** 치명적인 Worker 오류인지: wasm 트랩·메모리 부족·Worker 스크립트 오류. 일반 문서 오류(MuPDF 예외)는 아니다. */
export function isFatalWorkerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'WorkerCrash' || error.name === 'RuntimeError') return true;
  return /abort\(|Aborted\(|out of memory|memory access out of bounds|unreachable|table index is out of bounds|null function|WebAssembly\.Memory|Cannot enlarge memory|Maximum memory size/i.test(
    error.message,
  );
}

/** 복구 뒤 자동으로 다시 시도해도 되는 읽기 RPC. */
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
  /** 복구에 실패해 문서를 쓸 수 없는 상태(다음 open 이 풀어 준다). */
  private broken: Error | null = null;
  private recoveries = 0;
  private original: Blob | null = null;
  /**
   * `original` 에 이미 들어 있는 편집 id. 기준점에서 복구하면 기준점 편집이 된다. 뷰어 로그가 새 세션 이력으로 바뀌기 전에
   * 다시 복구해도 그 편집을 두 번 적용하지 않도록, 활성 로그가 이 id 로 시작하면 뺀다.
   */
  private originIds: string[] = [];
  /** 사용자 저장이 성공해 확정된 복구 기준점. */
  private baseline: SavedBaseline | null = null;
  /** 마지막 `save` 결과(사용자 저장 성공이 확인되면 기준점이 된다). */
  private pendingSave: SavedBaseline | null = null;
  /** 초안 id → 그 초안을 만든 Worker 세대. */
  private readonly drafts = new Map<string, number>();

  constructor(private readonly deps: RecoveryDeps) {
    this.current = deps.spawn();
  }

  /** 지금까지 복구한 횟수(진단·테스트용). */
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

  /** 복구 전 세대의 초안으로 온 호출이면 새 Worker 로 보내지 않는다. */
  private checkDraft(method: DraftMethod, draftId: string): void {
    if (this.drafts.get(draftId) !== this.epoch) {
      throw new WorkerRecoveredError(
        `작업 모듈이 복구되어 초안 ${draftId} 이 사라졌습니다(${method})`,
        this.deps.editLog().ops.length,
      );
    }
  }

  private recover(failed: WorkerHandle, cause: unknown): Promise<void> {
    if (failed !== this.current) return this.recovering ?? Promise.resolve(); // 이미 교체됨
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
      // 한 건씩 보내 진행을 알린다. 저널 켜기·메타 기록은 마지막 호출에서 한 번(core `replayEdits` more).
      for (const [i, op] of ops.entries()) {
        await handle.api.replayEdits([op], { more: i < ops.length - 1 });
        this.deps.onProgress?.(i + 1, ops.length);
      }
      if (fromSavedBaseline) {
        // 새 세션의 문서는 기준점에서 시작한다. 이후 복구도 이 바이트 + 이 세션의 활성 로그로 한다.
        this.original = baseline.blob;
        this.originIds = baseline.editIds;
        this.baseline = null;
        this.pendingSave = null;
      }
      let history: EditHistoryState | null = null;
      try {
        history = await handle.api.getEditHistory();
      } catch {
        history = null; // 편집 RPC 가 없는(M3 미구현) 구성
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
    // 원본은 open 전에 Blob 으로 보관한다(transfer 하면 ArrayBuffer 가 비워지므로, 복구 때 이 Blob 을 다시 연다).
    this.original = new Blob([bytes]);
    this.originIds = [];
    this.baseline = null;
    this.pendingSave = null;
    this.drafts.clear();
    if (this.broken) {
      // 복구에 실패한 Worker 는 버리고 새로 시작한다.
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
    // 저장 바이트를 기준점 후보로 둔다(복사). 사용자 저장이 성공했을 때만 `confirmSaved` 가 기준점으로 올린다.
    this.pendingSave = {
      blob: new Blob([result.bytes]),
      editIds: [...this.deps.editLog().activeEditIds],
    };
    return result;
  }

  /** 사용자 저장이 성공했다: 마지막 `save` 결과를 복구 기준점으로 삼는다(계약 D4). */
  confirmSaved(): void {
    if (this.pendingSave) this.baseline = this.pendingSave;
    this.pendingSave = null;
  }

  /** 측정 등 사용자 저장이 아닌 `save` 결과는 기준점 후보에서 버린다. */
  discardPendingSave(): void {
    this.pendingSave = null;
  }

  /** 진단·시험용: 확정된 기준점의 편집 id(없으면 null). */
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

  /** Redact 주석 보고(A2-2, `PdfWorkerApi.listRedactAnnots`, 계약 수정 4). */
  listRedactAnnots() {
    return this.invoke<RedactAnnotSummary>('listRedactAnnots', []);
  }

  /** 열기 시 보고용: 실패하거나 결과 모양이 다르면 null(보고만 건너뛴다). */
  async tryListRedactAnnots(): Promise<RedactAnnotSummary | null> {
    try {
      const report = await this.listRedactAnnots();
      return report && typeof report.total === 'number' ? report : null;
    } catch {
      return null;
    }
  }
}
