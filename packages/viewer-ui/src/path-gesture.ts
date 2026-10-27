/**
 * One path edit action (DOM-independent, M4 contract 4.5): one drag, color pick, width change or delete = one draft = one edit.
 *
 * - On start, opens `beginPathEdit` asynchronously, and `update()` keeps only the latest edit. Server updates (`updatePathDraft`) are
 *   sent only after `debounceMs` (200 ms) of idle time since the last update and on `flush()` (on release).
 * - `commit()` sends the latest edit to the open draft and commits. If there is no edit, or the edit changes nothing (such as dragging in place),
 *   it is the same as cancel (an unchanged edit is not left in the journal).
 * - On Worker recovery (`WorkerRecoveredError`), replans and restarts with the same target and resends the latest edit.
 * - If the target fingerprints (`target.fingerprints`) of the replan (revision retry or recovery restart) differ from the previous plan, the same paintSeq
 *   points at a different path, so it does not start and ends with `PathTargetChangedError` (the caller clears the selection).
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
  /** Open draft id (null before start). */
  draftId: string | null;
  /** Latest edit (basis of the preview). */
  edit: PathEdit | null;
  /** Changed region composited by the server (may not reflect the latest edit — see `pending`). */
  region: PathRegion | null;
  /** The latest edit is not yet reflected in the changed region (the client preview must be shown). */
  pending: boolean;
  /** Server update request in flight. */
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

/** An edit that changes nothing (no transform or identity, no properties, no points, not a delete). */
export function isNoopPathEdit(edit: PathEdit): boolean {
  const t = edit.transform;
  const identity =
    t === null ||
    (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0);
  return (
    identity &&
    edit.fill === null &&
    edit.stroke === null &&
    edit.lineWidth === null &&
    (edit.points === null || edit.points.length === 0) &&
    !edit.delete
  );
}

/** The replanned target differs from the originally selected path (the same paintSeq points at a different path). */
export class PathTargetChangedError extends Error {
  constructor() {
    super('그 사이 문서가 바뀌어 선택한 패스가 달라졌습니다. 패스를 다시 선택하세요.');
    this.name = 'PathTargetChangedError';
  }
}

/** Fingerprint comparison (same rule as pdf-ops `sameFingerprint`: boxes are allowed up to 2e-3). */
function sameFingerprint(a: PathFingerprint, b: PathFingerprint): boolean {
  return (
    a.paintOp === b.paintOp &&
    a.constructOpCount === b.constructOpCount &&
    a.constructHash === b.constructHash &&
    a.bbox.every((v, i) => Math.abs(v - b.bbox[i]!) <= 2e-3)
  );
}

/** Whether the targets (paintSeqs, fingerprints) of two plans are the same. */
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
  /** The edit last sent to (and processed by) the server. */
  private sent: PathEdit | null = null;
  private region: PathRegion | null = null;
  private seq = 0;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  private begun: Promise<void>;
  private closed = false;
  private committing = false;
  private error: string | null = null;
  /** This action ended because the replanned target differed (`PathTargetChangedError`). */
  private targetChanged = false;
  private plan: PathEditPlan;

  constructor(
    private readonly deps: PathGestureDeps,
    private readonly pageIndex: number,
    private readonly paintSeqs: number[],
    plan: PathEditPlan,
    /** When the revision is stale (the document changed in between), classify again. */
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

  /** Replans. `PathTargetChangedError` if the target fingerprints differ from the previous plan. */
  private async replanSameTarget(): Promise<void> {
    const next = await this.replan();
    if (!sameTarget(this.plan, next)) {
      this.targetChanged = true;
      this.deps.log('path-target-changed', { paintSeqs: this.paintSeqs });
      throw new PathTargetChangedError();
    }
    this.plan = next;
  }

  /** Waits until the start finishes (throws on failure). */
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

  /** Records the latest edit. The server update is sent after idle time (`debounceMs`). */
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

  /** Sends the latest edit now (on pointer release). Resolves when processing finishes. */
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
        this.sent = edit; // do not resend the same edit forever (retried on the next update)
        return;
      }
      this.emit();
    }
  }

  /** After Worker recovery: replans and restarts with the same target and resends the latest edit. */
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

  /** Commits. If there was no edit, it is the same as cancel. On failure, cancels the draft and leaves the document as it was. */
  async commit(): Promise<PathCommitOutcome> {
    if (this.closed) return { kind: 'cancelled', history: null };
    this.committing = true;
    this.emit();
    try {
      await this.begun;
      if (this.latest === null || isNoopPathEdit(this.latest)) {
        const history = await this.deps.rpc.cancelPathEdit(this.draftId!);
        return { kind: 'cancelled', history };
      }
      await this.flush();
      if (this.targetChanged) throw new PathTargetChangedError();
      // If the last update failed, do not commit (prevents saving a result that differs from the screen).
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

  /** Cancels (Esc). If there is an open draft, also discards it on the server. */
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
