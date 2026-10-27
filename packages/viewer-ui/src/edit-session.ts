/**
 * One edit session (DOM-independent): edit model of one draft, input sending (last input only), preview frame, end (commit/cancel), recovery restart.
 *
 * - Input is applied to the model immediately and sent to the Worker only when no request is in flight. While one is in flight, only the last input is kept (contract D7).
 * - The caret, selection, composition underline and overflow indicator are drawn from the `ReflowSummary` of the "last processed frame". A frame is saved
 *   together with the text and caret at input time so it does not diverge from the canvas compositing result.
 * - When the Worker is recovered (`WorkerRecoveredError`), the draft of the same paragraph is restarted from the editor model (text, style, format) (contract D6).
 */
import type {
  BeginEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditWarning,
  ParagraphEditPlan,
  ParagraphFormat,
  Point,
  PdfWorkerApi,
  RenderedPage,
  ReflowSummary,
} from '@pdf-editor/shared-types';
import { offsetAtPoint, lineBoundary, moveVertical } from './edit-geometry.js';
import {
  EditorModel,
  hasSelection,
  selectedText,
  selectionRange,
  toRuns,
  type Affinity,
  type EditorState,
} from './edit-model.js';
import { nextBoundary, nextWordStart, prevBoundary, prevWordStart } from './edit-text.js';
import { classifyFailure } from './failure.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';

/** Part of the edit RPC that the session uses. */
export type EditRpc = Pick<
  PdfWorkerApi,
  | 'planParagraphEdit'
  | 'beginParagraphEdit'
  | 'updateParagraphDraft'
  | 'commitParagraphEdit'
  | 'cancelParagraphEdit'
>;

/** Frame composited on screen: the edit state at input time and its reflow result. */
export interface ShownFrame {
  seq: number;
  text: string;
  caret: number;
  anchor: number;
  affinity: Affinity;
  composition: [number, number] | null;
  reflow: ReflowSummary;
}

/** Changed region (render result) to composite onto the page canvas. Recomposited when seq changes. */
export interface DraftRegion {
  seq: number;
  rendered: RenderedPage;
  /** Time of the oldest input reflected in this region (performance.now, for response time measurement). */
  t0: number;
}

export interface EditSessionView {
  draftId: string;
  pageIndex: number;
  paragraphId: number;
  plan: ParagraphEditPlan;
  /** Edit model (input is applied immediately). */
  editor: EditorState;
  shown: ShownFrame;
  format: ParagraphFormat;
  warnings: EditWarning[];
  region: DraftRegion | null;
  /** Waiting for the result of a sent input. */
  updating: boolean;
  /** Commit in progress. */
  committing: boolean;
  /** Notice that the draft was restarted after document recovery. */
  notice: string | null;
  /** Last update error (retried on the next input). */
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Whether it differs from the start state (if the same, commit = cancel). */
  dirty: boolean;
}

export interface EditSessionDeps {
  rpc: EditRpc;
  now(): number;
  /** Changed-region render scale (viewer scale × devicePixelRatio). */
  renderScale(): number;
  log(event: string, data?: unknown): void;
  /** Called whenever the session state changes. */
  onChange(view: EditSessionView): void;
  /** In-editor guidance strings (Korean by default). */
  strings?: ViewerStrings;
}

interface Frame {
  input: DraftInput;
  shown: Omit<ShownFrame, 'reflow'>;
  t0: number;
}

/** Upper bound on kept response-time samples (so it does not grow without limit in a long edit). */
const MAX_LATENCY_SAMPLES = 2000;

export function isWorkerRecovered(error: unknown): boolean {
  return classifyFailure(error).kind === 'recovered';
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class EditSession {
  readonly model: EditorModel;
  readonly pageIndex: number;
  readonly paragraphId: number;
  readonly latencies: number[] = [];
  private plan: ParagraphEditPlan;
  private draftId: string;
  private format: ParagraphFormat;
  private shown: ShownFrame;
  private warnings: EditWarning[];
  private region: DraftRegion | null = null;
  private seq = 0;
  private inflight: Promise<void> | null = null;
  private pending: Frame | null = null;
  private pendingT0: number | null = null;
  private waiters: (() => void)[] = [];
  private chain: Promise<void> | null = null;
  private committing = false;
  private closed = false;
  private notice: string | null = null;
  private error: string | null = null;
  private goalX: number | null = null;
  private dragAnchor: number | null = null;
  private restartPromise: Promise<void> | null = null;
  private readonly initialText: string;
  private readonly initialFormat: ParagraphFormat;

  private get t(): ViewerStrings {
    return this.deps.strings ?? VIEWER_STRINGS.ko;
  }

  constructor(
    private readonly deps: EditSessionDeps,
    plan: ParagraphEditPlan,
    begin: BeginEditResult,
    caret: number | null,
  ) {
    this.plan = plan;
    this.pageIndex = plan.pageIndex;
    this.paragraphId = plan.paragraphId;
    this.draftId = begin.draftId;
    this.format = plan.format;
    this.initialFormat = plan.format;
    this.model = new EditorModel(plan.runs, {
      now: () => deps.now(),
      ...(caret === null ? {} : { caret }),
    });
    this.initialText = this.model.state.text;
    this.warnings = begin.first.warnings;
    const state = this.model.state;
    this.shown = {
      seq: 0,
      text: state.text,
      caret: state.caret,
      anchor: state.anchor,
      affinity: state.affinity,
      composition: null,
      reflow: begin.first.reflow,
    };
    // R-L1 (M4): beginParagraphEdit is given the viewer render scale, so the first region is used as is (no start-update RPC).
    // seq 0 is not an input, so it is not added to the response-time samples (reportPainted).
    this.region = { seq: 0, rendered: begin.first.region, t0: deps.now() };
  }

  /** Placeholder for the session-start notification (the first region was already received as the begin result). Kept for compatibility. */
  start(): void {
    this.emit();
  }

  /** Immutable snapshot of the current state. */
  view(): EditSessionView {
    const state = this.model.state;
    return {
      draftId: this.draftId,
      pageIndex: this.pageIndex,
      paragraphId: this.paragraphId,
      plan: this.plan,
      editor: state,
      shown: this.shown,
      format: this.format,
      warnings: this.warnings,
      region: this.region,
      updating: this.inflight !== null || this.pending !== null,
      committing: this.committing,
      notice: this.notice,
      error: this.error,
      canUndo: this.model.history.canUndo,
      canRedo: this.model.history.canRedo,
      dirty: this.isDirty(),
    };
  }

  private emit(): void {
    if (!this.closed) this.deps.onChange(this.view());
  }

  isDirty(): boolean {
    return this.model.state.text !== this.initialText || !sameJson(this.format, this.initialFormat);
  }

  get isComposing(): boolean {
    return this.model.state.composition !== null;
  }

  // ── Input sending (last input only) ──────────────────────────────────

  private buildFrame(): Frame {
    const s = this.model.state;
    const t0 = this.pendingT0 ?? this.deps.now();
    return {
      input: {
        runs: toRuns(s),
        format: this.format,
        composition: s.composition,
        renderScale: this.deps.renderScale(),
      },
      shown: {
        seq: ++this.seq,
        text: s.text,
        caret: s.caret,
        anchor: s.anchor,
        affinity: s.affinity,
        composition: s.composition,
      },
      t0,
    };
  }

  /** Call when the model has changed: screen update + schedule an input send. */
  private touch(): void {
    if (this.closed) return;
    this.pendingT0 ??= this.deps.now();
    const frame = this.buildFrame();
    if (this.inflight) {
      this.pending = frame; // while processing, keep only the last input
      this.emit();
      return;
    }
    this.pendingT0 = null;
    this.inflight = this.drain(frame);
    this.emit();
  }

  /** When only the selection/caret changed: reflow is unchanged, so do not send a new frame; just update the caret of that frame. */
  private touchSelectionOnly(): void {
    const s = this.model.state;
    if (this.inflight || this.pending || s.text !== this.shown.text) {
      this.touch();
      return;
    }
    this.shown = {
      ...this.shown,
      caret: s.caret,
      anchor: s.anchor,
      affinity: s.affinity,
      composition: s.composition,
    };
    this.emit();
  }

  private async drain(first: Frame): Promise<void> {
    try {
      let frame: Frame | null = first;
      while (frame && !this.closed) {
        try {
          const update: DraftUpdate = await this.deps.rpc.updateParagraphDraft(
            this.draftId,
            frame.input,
          );
          if (this.closed) break;
          this.apply(frame, update);
        } catch (e) {
          if (this.closed) break;
          await this.recoverFrom(e);
        }
        frame = this.pending;
        this.pending = null;
        if (frame) this.pendingT0 = null;
      }
    } finally {
      this.inflight = null;
      this.emit();
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  /** Handle an update failure: on Worker recovery restart the draft; for other errors only show them and retry on the next input. */
  private async recoverFrom(e: unknown): Promise<void> {
    try {
      if (isWorkerRecovered(e)) {
        await this.restart();
        return;
      }
      const failure = classifyFailure(e);
      this.error = failure.message;
      this.deps.log('edit-update-error', { error: failure.message });
    } catch (re) {
      const failure = classifyFailure(re);
      this.error = failure.message;
      this.deps.log('edit-restart-error', { error: failure.message });
    }
  }

  private apply(frame: Frame, update: DraftUpdate): void {
    this.shown = { ...frame.shown, reflow: update.reflow };
    this.warnings = update.warnings;
    this.error = null;
    this.region = { seq: frame.shown.seq, rendered: update.region, t0: frame.t0 };
    this.emit();
  }

  /** Waits until all sent inputs have been processed. */
  settle(): Promise<void> {
    if (!this.inflight && !this.pending) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Called right after a component composites the changed region onto the canvas (records input → compositing response time, contract 8.4). */
  reportPainted(seq: number): number | null {
    const region = this.region;
    if (!region || region.seq !== seq || seq === 0) return null;
    const end = this.deps.now();
    const ms = end - region.t0;
    this.latencies.push(ms);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) this.latencies.shift();
    try {
      performance.measure('pe-edit-latency', { start: region.t0, end });
      // M5 benchmark metric event (contract D1): input → preview compositing.
      performance.mark('m5:edit:input', { startTime: region.t0 });
      performance.mark('m5:edit:preview-composited', { startTime: end });
    } catch {
      // In environments where the measurement API is unavailable, only the array record is kept.
    }
    return ms;
  }

  // ── Ordering: actions needing line geometry run after earlier input is processed ──

  private run(action: () => void, needsSettle: boolean): void {
    if (!needsSettle && this.chain === null) {
      action();
      return;
    }
    const prev = this.chain ?? Promise.resolve();
    const next: Promise<void> = prev.then(async () => {
      if (needsSettle) await this.settle();
      if (!this.closed) action();
    });
    this.chain = next;
    void next.finally(() => {
      if (this.chain === next) this.chain = null;
    });
  }

  /** Until all pending actions have finished. */
  async idle(): Promise<void> {
    while (this.chain) await this.chain;
    await this.settle();
  }

  // ── Text editing ─────────────────────────────────────────────────────

  /**
   * While a commit/cancel RPC is in flight, text/format input is not accepted (shown via view.committing). If accepted, it would go only into the model and
   * not the core draft, so it would be missing from the commit result. Caret moves and selection do not change text, so they are not blocked.
   */
  private busy(): boolean {
    return this.committing || this.closed;
  }

  private afterTextChange(changed: boolean): void {
    this.goalX = null;
    if (changed) this.touch();
    else this.touchSelectionOnly();
  }

  typeText(text: string): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.insertText(text)), false);
  }

  paste(text: string): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.paste(text)), false);
  }

  backspace(byWord = false): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.deleteBackward(byWord)), false);
  }

  deleteKey(byWord = false): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.deleteForward(byWord)), false);
  }

  /** Selected text (copy). */
  copyText(): string {
    return selectedText(this.model.state);
  }

  /** Cut: returns the selected text and deletes it. */
  cut(): string {
    if (this.busy()) return '';
    const text = selectedText(this.model.state);
    if (text === '') return '';
    this.run(() => this.afterTextChange(this.model.deleteSelection()), false);
    return text;
  }

  undo(): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.undo()), false);
  }

  redo(): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.redo()), false);
  }

  // ── IME ──────────────────────────────────────────────────────────────

  compositionStart(): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionStart();
      this.goalX = null;
      this.touch();
    }, false);
  }

  compositionUpdate(text: string): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionUpdate(text);
      this.goalX = null;
      this.touch();
    }, false);
  }

  compositionEnd(text?: string): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionEnd(text);
      this.goalX = null;
      this.touch();
    }, false);
  }

  // ── Caret movement (keys) ────────────────────────────────────────────

  /** Left/right move. With a selection and no Shift, collapses to the selection end. */
  moveHorizontal(dir: -1 | 1, shift: boolean, byWord: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      if (!shift && hasSelection(s)) {
        const [a, b] = selectionRange(s);
        this.model.moveTo(dir < 0 ? a : b);
      } else {
        const to =
          dir < 0
            ? byWord
              ? prevWordStart(s.text, s.caret)
              : prevBoundary(s.text, s.caret)
            : byWord
              ? nextWordStart(s.text, s.caret)
              : nextBoundary(s.text, s.caret);
        this.model.moveTo(to, shift);
      }
      this.touchSelectionOnly();
    }, false);
  }

  /** Up/down line move (by reflow line). */
  moveVerticalKey(dir: -1 | 1, shift: boolean): void {
    this.run(() => {
      const s = this.model.state;
      const hit = moveVertical(this.shown.reflow, s.text, s.caret, s.affinity, dir, this.goalX);
      this.model.moveTo(hit.offset, shift, hit.affinity);
      this.goalX = hit.goalX;
      this.touchSelectionOnly();
    }, true);
  }

  /** Home/End. With Ctrl, paragraph start/end. */
  moveLineBoundary(which: 'home' | 'end', shift: boolean, wholeText: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      if (wholeText) {
        this.model.moveTo(which === 'home' ? 0 : s.text.length, shift);
      } else {
        const hit = lineBoundary(this.shown.reflow, s.text, s.caret, s.affinity, which);
        this.model.moveTo(hit.offset, shift, hit.affinity);
      }
      this.touchSelectionOnly();
    }, true);
  }

  selectAll(): void {
    this.run(() => {
      this.goalX = null;
      this.model.selectAll();
      this.touchSelectionOnly();
    }, false);
  }

  // ── Pointer ──────────────────────────────────────────────────────────

  /** Mouse down inside the region. detail 1 = caret (extends the selection with Shift), 2 = word, 3 or more = everything. */
  pointerDown(point: Point, detail: number, shift: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      const hit = offsetAtPoint(this.shown.reflow, s.text, point);
      if (detail >= 3) {
        this.model.selectAll();
        this.dragAnchor = null;
      } else if (detail === 2) {
        this.model.selectWordAt(hit.offset);
        this.dragAnchor = null;
      } else {
        const anchor = shift ? s.anchor : hit.offset;
        this.model.setSelection(anchor, hit.offset, hit.affinity);
        this.dragAnchor = anchor;
      }
      this.touchSelectionOnly();
    }, true);
  }

  pointerDrag(point: Point): void {
    if (this.dragAnchor === null) return;
    const anchor = this.dragAnchor;
    this.run(() => {
      const s = this.model.state;
      const hit = offsetAtPoint(this.shown.reflow, s.text, point);
      this.model.setSelection(anchor, hit.offset, hit.affinity);
      this.touchSelectionOnly();
    }, true);
  }

  pointerUp(): void {
    this.dragAnchor = null;
  }

  // ── Format (region) ──────────────────────────────────────────────────

  setFormat(patch: Partial<ParagraphFormat>): void {
    if (this.busy()) return;
    this.format = { ...this.format, ...patch };
    this.touch();
  }

  // ── End ──────────────────────────────────────────────────────────────

  /** If composing, finalizes with the current composition string (outside click or commit before save, contract I8). */
  private finishComposition(): void {
    if (this.model.state.composition) {
      this.model.compositionEnd();
      this.touch();
    }
  }

  /**
   * Commit. With no changes it is the same as cancel. The caller reflects the result's history in the history/recovery log.
   * If recovery happened and the draft was restarted, edit mode is kept and 'restarted' is returned.
   */
  async commit(): Promise<
    | { kind: 'committed'; result: CommitResult }
    | { kind: 'cancelled'; history: EditHistoryState }
    | { kind: 'restarted' }
    | { kind: 'kept'; error: string }
  > {
    this.finishComposition();
    this.committing = true;
    this.emit();
    try {
      await this.idle();
      if (!this.isDirty()) {
        const history = await this.cancelRpc();
        return { kind: 'cancelled', history };
      }
      // If the last update failed, or the last input is not yet a processed frame, the core draft differs from the on-screen text. Resend the current
      // state and commit only if that succeeds (on failure, keep the editor open and show the error).
      if (this.error !== null || this.shown.seq !== this.seq) {
        const sent = await this.resend();
        if (sent === 'restarted') return { kind: 'restarted' };
        if (sent !== 'ok') return { kind: 'kept', error: sent.error };
      }
      try {
        const result = await this.deps.rpc.commitParagraphEdit(this.draftId);
        this.close();
        return { kind: 'committed', result };
      } catch (e) {
        if (!isWorkerRecovered(e)) throw e;
        await this.restart();
        return { kind: 'restarted' };
      }
    } finally {
      this.committing = false;
      this.emit();
    }
  }

  /** Resend the current state before commit. On Worker recovery, restarts the draft. */
  private async resend(): Promise<'ok' | 'restarted' | { error: string }> {
    const frame = this.buildFrame();
    this.pendingT0 = null;
    try {
      const update = await this.deps.rpc.updateParagraphDraft(this.draftId, frame.input);
      if (this.closed) return { error: this.t.sessionClosed };
      this.apply(frame, update);
      return 'ok';
    } catch (e) {
      if (isWorkerRecovered(e)) {
        await this.restart();
        return 'restarted';
      }
      const failure = classifyFailure(e);
      this.error = failure.message;
      this.deps.log('edit-update-error', { error: failure.message, atCommit: true });
      return { error: failure.message };
    }
  }

  /** Cancel (toolbar "Cancel edit"). */
  async cancel(): Promise<EditHistoryState> {
    this.pending = null;
    this.committing = true;
    this.emit();
    try {
      await this.settle();
      return await this.cancelRpc();
    } finally {
      this.committing = false;
    }
  }

  private async cancelRpc(): Promise<EditHistoryState> {
    try {
      const history = await this.deps.rpc.cancelParagraphEdit(this.draftId);
      this.close();
      return history;
    } catch (e) {
      if (!isWorkerRecovered(e)) throw e;
      // The recovered Worker has no draft. This is the same as cancel, so just close the session.
      this.close();
      throw e;
    }
  }

  private close(): void {
    this.closed = true;
    this.pending = null;
  }

  /** Cleans up the session (when the caller has already handled the end). */
  dispose(): void {
    this.close();
  }

  // ── Recovery ─────────────────────────────────────────────────────────

  /** Restarts the draft of the same paragraph with the editor model on the recovered Worker (contract D6). Runs only once even if called several times concurrently. */
  restart(): Promise<void> {
    return (this.restartPromise ??= this.doRestart().finally(() => {
      this.restartPromise = null;
    }));
  }

  private async doRestart(): Promise<void> {
    this.notice = this.t.sessionRecovered;
    const plan = await this.deps.rpc.planParagraphEdit(this.pageIndex, this.paragraphId);
    if (!plan.editable) throw new Error(this.t.restartNotEditable);
    const begun = await this.deps.rpc.beginParagraphEdit(
      this.pageIndex,
      this.paragraphId,
      plan.revision,
    );
    this.plan = { ...this.plan, revision: plan.revision };
    this.draftId = begun.draftId;
    const frame = this.buildFrame();
    const update = await this.deps.rpc.updateParagraphDraft(this.draftId, frame.input);
    this.apply(frame, update);
    this.deps.log('edit-restarted', { pageIndex: this.pageIndex, paragraphId: this.paragraphId });
  }
}
