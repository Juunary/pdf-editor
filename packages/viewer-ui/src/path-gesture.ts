/**
 * 패스 편집 동작 하나(DOM 비의존, M4 계약 4.5): 끌기·색 선택·두께·삭제 한 번 = 초안 1개 = 편집 1개.
 *
 * - 시작하면 `beginPathEdit` 를 비동기로 열고, `update()` 는 최신 편집만 보관한다. 서버 갱신(`updatePathDraft`)은
 *   마지막 갱신 뒤 `debounceMs`(200 ms) 정지 때와 `flush()`(놓을 때)만 보낸다.
 * - `commit()` 은 열린 초안에 최신 편집을 보내고 커밋한다. 편집이 한 번도 없으면 취소와 같다.
 * - Worker 복구(`WorkerRecoveredError`)가 나면 같은 대상으로 다시 계획·시작하고 최신 편집을 다시 보낸다.
 * - 다시 계획(revision 재시도·복구 재시작)한 결과의 대상 지문(`target.fingerprints`)이 직전 계획과 다르면 같은 paintSeq 가
 *   다른 패스를 가리키는 것이므로 시작하지 않고 `PathTargetChangedError` 로 끝낸다(선택은 호출자가 푼다).
 */
import type {
  CommitResult,
  EditHistoryState,
  PathEdit,
  PathEditPlan,
  PathFingerprint,
  RenderedPage,
} from '@pdf-editor/shared-types';
import { classifyFailure } from './failure.js';
import type { PathHostApi } from './viewer-host.js';

export type PathRpc = PathHostApi;

export interface PathRegion {
  seq: number;
  rendered: RenderedPage;
}

export interface PathGestureView {
  /** 열린 초안 id(시작 전이면 null). */
  draftId: string | null;
  /** 최신 편집(미리보기 기준). */
  edit: PathEdit | null;
  /** 서버가 합성한 변경 영역(최신 편집이 반영된 것이 아닐 수 있다 — `pending` 참고). */
  region: PathRegion | null;
  /** 최신 편집이 아직 변경 영역에 반영되지 않았다(클라이언트 미리보기를 보여야 한다). */
  pending: boolean;
  /** 서버 갱신 요청 중. */
  updating: boolean;
  committing: boolean;
  error: string | null;
}

export interface PathGestureDeps {
  rpc: PathRpc;
  renderScale(): number;
  debounceMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log(event: string, data?: unknown): void;
  onChange(view: PathGestureView): void;
}

export type PathCommitOutcome =
  | { kind: 'committed'; result: CommitResult }
  | { kind: 'cancelled'; history: EditHistoryState | null }
  | { kind: 'failed'; error: string; targetChanged?: boolean };

/** 다시 계획한 대상이 처음 선택한 패스와 다르다(같은 paintSeq 가 다른 패스를 가리킴). */
export class PathTargetChangedError extends Error {
  constructor() {
    super('그 사이 문서가 바뀌어 선택한 패스가 달라졌습니다. 패스를 다시 선택하세요.');
    this.name = 'PathTargetChangedError';
  }
}

/** 지문 비교(pdf-ops `sameFingerprint` 와 같은 규칙: 상자는 2e-3 까지 허용). */
function sameFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return (
    a.paintOp === b.paintOp &&
    a.constructOpCount === b.constructOpCount &&
    a.constructHash === b.constructHash &&
    a.bbox.every((v, i) => Math.abs(v - b.bbox[i]!) <= 2e-3)
  );
}

/** 두 계획의 대상(paintSeqs·지문)이 같은지. */
export function sameTarget(a: PathEditPlan, b: PathEditPlan): boolean {
  const x = a.target;
  const y = b.target;
  return (
    x.paintSeqs.length === y.paintSeqs.length &&
    x.paintSeqs.every((s, i) => s === y.paintSeqs[i]) &&
    x.fingerprints.length === y.fingerprints.length &&
    x.fingerprints.every((f, i) => sameFingerprint(f, y.fingerprints[i]!))
  );
}

const isRevisionError = (e: unknown): boolean => /revision/i.test(classifyFailure(e).message);

export class PathGesture {
  private draftId: string | null = null;
  private latest: PathEdit | null = null;
  /** 서버에 마지막으로 보낸(처리된) 편집. */
  private sent: PathEdit | null = null;
  private region: PathRegion | null = null;
  private seq = 0;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private begun: Promise<void>;
  private closed = false;
  private committing = false;
  private error: string | null = null;
  /** 다시 계획한 대상이 달라 이 동작을 끝냈다(`PathTargetChangedError`). */
  private targetChanged = false;
  private plan: PathEditPlan;

  constructor(
    private readonly deps: PathGestureDeps,
    private readonly pageIndex: number,
    private readonly paintSeqs: number[],
    plan: PathEditPlan,
    /** revision 이 낡았을 때(그 사이 문서가 바뀜) 다시 판정한다. */
    private readonly replan: () => Promise<PathEditPlan>,
  ) {
    this.plan = plan;
    this.begun = this.open();
  }

  private async open(): Promise<void> {
    try {
      let begun;
      try {
        begun = await this.deps.rpc.beginPathEdit(
          this.pageIndex,
          this.paintSeqs,
          this.plan.revision,
        );
      } catch (e) {
        if (!isRevisionError(e)) throw e;
        await this.replanSameTarget();
        begun = await this.deps.rpc.beginPathEdit(
          this.pageIndex,
          this.paintSeqs,
          this.plan.revision,
        );
      }
      this.draftId = begun.draftId;
      this.plan = begun.plan;
    } catch (e) {
      this.error = classifyFailure(e).message;
      this.deps.log('path-begin-error', { error: this.error });
      throw e;
    } finally {
      this.emit();
    }
  }

  /** 다시 계획한다. 대상 지문이 직전 계획과 다르면 `PathTargetChangedError`. */
  private async replanSameTarget(): Promise<void> {
    const next = await this.replan();
    if (!sameTarget(this.plan, next)) {
      this.targetChanged = true;
      this.deps.log('path-target-changed', { paintSeqs: this.paintSeqs });
      throw new PathTargetChangedError();
    }
    this.plan = next;
  }

  /** 시작이 끝날 때까지 기다린다(실패하면 던진다). */
  ready(): Promise<void> {
    return this.begun;
  }

  view(): PathGestureView {
    return {
      draftId: this.draftId,
      edit: this.latest,
      region: this.region,
      pending: this.latest !== null && this.latest !== this.sent,
      updating: this.inflight !== null,
      committing: this.committing,
      error: this.error,
    };
  }

  private emit(): void {
    if (!this.closed) this.deps.onChange(this.view());
  }

  /** 최신 편집을 기록한다. 서버 갱신은 정지 뒤(`debounceMs`)에 보낸다. */
  update(edit: PathEdit): void {
    if (this.closed) return;
    this.latest = edit;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.deps.debounceMs);
    this.emit();
  }

  /** 최신 편집을 지금 보낸다(포인터를 놓을 때). 처리가 끝나면 풀린다. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    await this.begun;
    if (this.inflight) {
      await this.inflight;
      if (this.latest === this.sent) return;
    }
    this.inflight = this.drain();
    this.emit();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
      this.emit();
    }
  }

  private async drain(): Promise<void> {
    while (
      !this.closed &&
      !this.targetChanged &&
      this.latest !== null &&
      this.latest !== this.sent
    ) {
      const edit = this.latest;
      try {
        const update = await this.deps.rpc.updatePathDraft(
          this.draftId!,
          edit,
          this.deps.renderScale(),
        );
        if (this.closed) return;
        this.sent = edit;
        this.error = null;
        this.region = { seq: ++this.seq, rendered: update.region };
      } catch (e) {
        if (this.closed) return;
        if (classifyFailure(e).kind === 'recovered') {
          try {
            await this.restart();
          } catch (re) {
            if (!(re instanceof PathTargetChangedError)) throw re;
            this.error = re.message;
            this.sent = edit;
            return;
          }
          continue;
        }
        this.error = classifyFailure(e).message;
        this.deps.log('path-update-error', { error: this.error });
        this.sent = edit; // 같은 편집을 무한히 다시 보내지 않는다(다음 update 에서 재시도)
        return;
      }
      this.emit();
    }
  }

  /** Worker 복구 뒤: 같은 대상을 다시 계획·시작하고 최신 편집을 다시 보낸다. */
  private async restart(): Promise<void> {
    this.draftId = null;
    this.sent = null;
    await this.replanSameTarget();
    const begun = await this.deps.rpc.beginPathEdit(
      this.pageIndex,
      this.paintSeqs,
      this.plan.revision,
    );
    this.draftId = begun.draftId;
    this.plan = begun.plan;
  }

  /** 커밋한다. 편집이 없었으면 취소와 같다. 실패하면 초안을 취소해 문서를 원래대로 둔다. */
  async commit(): Promise<PathCommitOutcome> {
    if (this.closed) return { kind: 'cancelled', history: null };
    this.committing = true;
    this.emit();
    try {
      await this.begun;
      if (this.latest === null) {
        const history = await this.deps.rpc.cancelPathEdit(this.draftId!);
        return { kind: 'cancelled', history };
      }
      await this.flush();
      if (this.targetChanged) throw new PathTargetChangedError();
      // 마지막 갱신이 실패했으면 커밋하지 않는다(화면과 다른 결과가 저장되는 것을 막는다).
      if (this.error !== null) throw new Error(this.error);
      const result = await this.deps.rpc.commitPathEdit(this.draftId!);
      return { kind: 'committed', result };
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind !== 'recovered' && this.draftId !== null) {
        await this.deps.rpc.cancelPathEdit(this.draftId).catch(() => {});
      }
      return this.targetChanged
        ? { kind: 'failed', error: failure.message, targetChanged: true }
        : { kind: 'failed', error: failure.message };
    } finally {
      this.close();
    }
  }

  /** 취소한다(Esc). 열린 초안이 있으면 서버에서도 버린다. */
  async cancel(): Promise<EditHistoryState | null> {
    if (this.closed) return null;
    this.close();
    try {
      await this.begun;
    } catch {
      return null;
    }
    try {
      return this.draftId === null ? null : await this.deps.rpc.cancelPathEdit(this.draftId);
    } catch (e) {
      this.deps.log('path-cancel-error', { error: classifyFailure(e).message });
      return null;
    }
  }

  private close(): void {
    this.closed = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}
