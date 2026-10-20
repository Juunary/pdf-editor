/**
 * Worker 복구 계층(계약 D6, A3-3). 뷰어 소유 Worker 가 치명 오류(wasm 트랩·메모리 부족·스크립트 오류)로 쓸 수 없게 되면
 * 새 Worker 를 만들고, 보관한 원본(`Blob`)을 열고, 보관한 편집 로그(`EditOp` + `activeEditIds`)를 `replayEdits` 로 다시 적용한다.
 *
 * - 읽기 RPC(렌더·추출·판정 등)는 복구 뒤 한 번 자동으로 다시 시도한다.
 * - 쓰기·초안 RPC 는 상태가 바뀌었으므로 다시 시도하지 않고 `WorkerRecoveredError` 로 알린다. 호출한 쪽(뷰어 UI)이
 *   초안을 편집기 모델로 다시 시작하거나 저장을 다시 묻는다.
 * - 복구 전 세대의 초안 id 로 온 호출은 새 Worker 로 보내지 않고 같은 오류로 돌려준다.
 * - 동시에 여러 호출이 실패해도 복구는 한 번만 한다.
 */
import type {
  EditHistoryState,
  EditOp,
  ExtractRequest,
  PdfWorkerApi,
  RedactAnnotSummary,
  RenderRequest,
  SaveRequest,
  SearchRequest,
} from '@pdf-editor/shared-types';
import { WORKER_RECOVERED_ERROR_NAME } from '@pdf-editor/viewer-ui';

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
  log(event: string, data?: unknown): void;
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
    if (!this.original) throw new Error(`문서를 복구하지 못했습니다(${message})`);
    this.deps.log('worker-recover-start', { cause: message, epoch: this.epoch + 1 });
    failed.terminate();
    this.epoch++;
    this.drafts.clear();
    const handle = this.deps.spawn();
    this.current = handle;
    try {
      const bytes = await this.original.arrayBuffer();
      await handle.api.open(this.deps.transfer(bytes));
      const log = this.deps.editLog();
      if (log.ops.length > 0) await handle.api.replayEdits(log.ops);
      let history: EditHistoryState | null = null;
      try {
        history = await handle.api.getEditHistory();
      } catch {
        history = null; // 편집 RPC 가 없는(M3 미구현) 구성
      }
      this.recoveries++;
      const info: RecoveryInfo = {
        cause: message,
        replayedEdits: log.ops.length,
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
      this.broken = new Error(
        `문서를 복구하지 못했습니다. 파일을 다시 열어 주세요: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw this.broken;
    }
  }

  // ── PdfWorkerApi ───────────────────────────────────────────────────

  async open(bytes: ArrayBuffer): Promise<Awaited<ReturnType<PdfWorkerApi['open']>>> {
    // 원본은 open 전에 Blob 으로 보관한다(transfer 하면 ArrayBuffer 가 비워지므로, 복구 때 이 Blob 을 다시 연다).
    this.original = new Blob([bytes]);
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

  save(request: SaveRequest) {
    return this.invoke<Awaited<ReturnType<PdfWorkerApi['save']>>>('save', [request]);
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

  async beginParagraphEdit(pageIndex: number, paragraphId: number, revision: number) {
    const epoch = this.epoch;
    const result = await this.invoke<Awaited<ReturnType<PdfWorkerApi['beginParagraphEdit']>>>(
      'beginParagraphEdit',
      [pageIndex, paragraphId, revision],
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

  replayEdits(ops: EditOp[]) {
    return this.invoke<EditHistoryState>('replayEdits', [ops]);
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
