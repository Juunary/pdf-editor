/**
 * Vector path editing coordinator (DOM-independent, M4 contract 4.5): path model loading, selection (Shift for multiple), point-edit mode, edit actions
 * (drag, properties, delete), editability overlay toggle. Owned by `EditController`; state is passed as `EditState.path`.
 *
 * One edit action = one draft = one edit (`PathGesture`). Selection alone does not open a draft (there is only one draft per document, so
 * selection must not block paragraph editing).
 */
import type {
  CommitResult,
  EditHistoryState,
  PageModel,
  PaintColor,
  PathEdit,
  PathEditPlan,
  Point,
  RGB,
} from '@pdf-editor/shared-types';
import { limitItems } from './edit-labels.js';
import type { EditContext, EditLoadable } from './edit-controller.js';
import { classifyFailure } from './failure.js';
import { buildCandidates, pickPath, STROKE_HIT_PX, type PathCandidate } from './path-geometry.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';
import {
  isNoopPathEdit,
  PathGesture,
  PathTargetChangedError,
  type PathCommitOutcome,
  type PathGestureView,
  type PathRpc,
} from './path-gesture.js';

/** Idle time before sending a server update (ms, contract 4.5). */
export const PATH_DEBOUNCE_MS = 200;

export interface PathSelection {
  pageIndex: number;
  paintSeqs: number[];
  /** Selection classification (editability, current color, width). Keeps the previous value while reclassifying. */
  plan: PathEditPlan | null;
}

export interface PathState {
  /** Path model for selection and point editing (includePathSegments). */
  model: EditLoadable<PageModel>;
  selection: PathSelection | null;
  /** Point-edit mode (only when exactly one path is selected). */
  pointMode: boolean;
  /** Edit action in progress. */
  gesture: PathGestureView | null;
  /** Limit-reason notice (when the selected path cannot be edited). */
  note: string[] | null;
  /**
   * Re-reading the model and selection classification after a commit. The selection box and plan from before it finishes are stale, so actions are blocked (review L7) and the selection box
   * is hidden. Selection clicks arriving in this period are deferred and handled afterwards (M5 review M8).
   */
  settling: boolean;
}

export function initialPathState(): PathState {
  return {
    model: { status: 'idle' },
    selection: null,
    pointMode: false,
    gesture: null,
    note: null,
    settling: false,
  };
}

export interface PathContext extends EditContext {
  pathRpc: PathRpc;
  /** Permanently disables only the path editing feature ("M4 not implemented"). */
  disablePath(reason: string): void;
  /** Reads the path model (includePathSegments). */
  extractPaths(pageIndex: number): Promise<PageModel>;
  /** Waits until the page classification (list of editable paths) arrives. Does not wait if there is none. */
  ensureEditability?(pageIndex: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  patchPath(partial: Partial<PathState>): void;
  getPath(): PathState;
}

export class PathController {
  private gesture: PathGesture | null = null;
  private ending: Promise<boolean> | null = null;
  /** Model read in progress. A repeated request for the same page waits for this read (fix for the cause of the lost first Alt+click). */
  private loadingModel: { pageIndex: number; promise: Promise<void> } | null = null;
  /** Reclassification after a commit in progress (`settling`). Selection clicks in the meantime wait for it. */
  private settled: Promise<void> | null = null;

  constructor(private readonly ctx: PathContext) {}

  private get t(): ViewerStrings {
    return this.ctx.strings ?? VIEWER_STRINGS.ko;
  }

  get active(): boolean {
    return this.gesture !== null;
  }

  // ── Model and candidates ─────────────────────────────────────────────

  /**
   * Waits until the page's path model is ready. If the same page is already being read, waits for that read: returning immediately
   * because it is being read would make the caller (`selectAt`) classify with empty candidates, and the click would end with no selection.
   */
  ensureModel(pageIndex: number): Promise<void> {
    const cur = this.ctx.getPath().model;
    if (cur.status === 'ready' && cur.pageIndex === pageIndex) return Promise.resolve();
    if (this.loadingModel?.pageIndex === pageIndex && cur.status === 'loading') {
      return this.loadingModel.promise;
    }
    this.ctx.patchPath({ model: { status: 'loading', pageIndex } });
    const entry: { pageIndex: number; promise: Promise<void> } = {
      pageIndex,
      promise: Promise.resolve(),
    };
    entry.promise = this.loadModel(pageIndex, entry).finally(() => {
      if (this.loadingModel === entry) this.loadingModel = null;
    });
    this.loadingModel = entry;
    return entry.promise;
  }

  private async loadModel(pageIndex: number, entry: object): Promise<void> {
    try {
      const value = await this.ctx.extractPaths(pageIndex);
      // If the model was discarded while reading (invalidateModel/reset) or replaced by another read, drop the result.
      if (this.loadingModel !== entry) return;
      if (this.ctx.isStalePage(pageIndex)) {
        this.ctx.patchPath({ model: { status: 'idle' } });
        return;
      }
      this.ctx.patchPath({ model: { status: 'ready', pageIndex, value } });
    } catch (e) {
      if (this.loadingModel !== entry) return;
      const failure = classifyFailure(e);
      this.ctx.logEvent('path-model-error', { pageIndex, error: failure.message });
      this.ctx.patchPath({ model: { status: 'error', pageIndex, message: failure.message } });
    }
  }

  /** Selection candidates for the current page (model + page classification). Empty list if not ready. */
  candidates(pageIndex: number): PathCandidate[] {
    const model = this.ctx.getPath().model;
    const edit = this.ctx.getState().editability;
    if (
      model.status !== 'ready' ||
      model.pageIndex !== pageIndex ||
      edit.status !== 'ready' ||
      edit.pageIndex !== pageIndex
    ) {
      return [];
    }
    return buildCandidates(model.value.paths, edit.value.paths);
  }

  // ── Selection ────────────────────────────────────────────────────────

  /**
   * Picks a path at point p (page space). With additive (Shift), adds to or removes from the selection. If no path matches
   * (and not additive), clears the selection. Returns the selected path list.
   */
  async selectAt(
    pageIndex: number,
    point: Point,
    cssScale: number,
    additive: boolean,
  ): Promise<number[]> {
    if (this.gesture || this.ctx.getState().session || this.ctx.getState().starting) {
      return this.ctx.getPath().selection?.paintSeqs ?? [];
    }
    // If reclassification right after a commit is in progress, defer until it finishes. Handling it as is would pick with the old model/classification, or the reclassification would
    // overwrite the new selection (M8: an Alt+click about 100 ms after a path commit was ignored or the previous selection reappeared).
    while (this.settled) await this.settled;
    await Promise.all([this.ensureModel(pageIndex), this.ctx.ensureEditability?.(pageIndex)]);
    const hit = pickPath(this.candidates(pageIndex), point, STROKE_HIT_PX / cssScale);
    const cur = this.ctx.getPath().selection;
    const base = cur && cur.pageIndex === pageIndex ? cur.paintSeqs : [];
    let next: number[];
    if (!hit) next = additive ? base : [];
    else if (!additive) next = [hit.paintSeq];
    else
      next = base.includes(hit.paintSeq)
        ? base.filter((s) => s !== hit.paintSeq)
        : [...base, hit.paintSeq];
    if (next.length === 0) {
      this.clear();
      return [];
    }
    this.ctx.patchPath({
      selection: {
        pageIndex,
        paintSeqs: next,
        plan: cur?.pageIndex === pageIndex ? cur.plan : null,
      },
      pointMode: next.length === 1 ? this.ctx.getPath().pointMode : false,
      note: null,
    });
    await this.replan();
    return next;
  }

  /** Reclassifies the selection (right after selection, or after re-reading the page following an edit). */
  async replan(): Promise<PathEditPlan | null> {
    const sel = this.ctx.getPath().selection;
    if (!sel) return null;
    try {
      const plan = await this.ctx.pathRpc.planPathEdit(sel.pageIndex, sel.paintSeqs);
      const now = this.ctx.getPath().selection;
      if (
        !now ||
        now.pageIndex !== sel.pageIndex ||
        now.paintSeqs.join() !== sel.paintSeqs.join()
      ) {
        return plan;
      }
      this.ctx.patchPath({
        selection: { ...now, plan },
        note: plan.editable ? null : limitItems(plan.limits, this.t.pathNotEditable, this.t),
        pointMode: plan.editable ? this.ctx.getPath().pointMode : false,
      });
      return plan;
    } catch (e) {
      this.handleFailure(e, this.t.pathPlanFailed);
      return null;
    }
  }

  clear(): void {
    const p = this.ctx.getPath();
    if (p.selection || p.pointMode || p.note) {
      this.ctx.patchPath({ selection: null, pointMode: false, note: null });
    }
  }

  dismissNote(): void {
    if (this.ctx.getPath().note) this.ctx.patchPath({ note: null });
  }

  setPointMode(on: boolean): void {
    const sel = this.ctx.getPath().selection;
    const ok = sel !== null && sel.paintSeqs.length === 1 && sel.plan?.editable === true;
    this.ctx.patchPath({ pointMode: on && ok });
  }

  // ── Edit actions ─────────────────────────────────────────────────────

  /** Starts a continuous edit such as a drag. null if the selection is not editable or another edit is open. */
  beginGesture(): PathGesture | null {
    const sel = this.ctx.getPath().selection;
    const state = this.ctx.getState();
    if (!sel || !sel.plan || !sel.plan.editable) return null;
    if (this.ctx.getPath().settling) return null;
    if (this.gesture || state.session || state.starting || state.busy) return null;
    const g = new PathGesture(
      {
        rpc: this.ctx.pathRpc,
        renderScale: () => this.ctx.currentView()?.renderScale ?? 1,
        debounceMs: PATH_DEBOUNCE_MS,
        setTimer: (fn, ms) => this.ctx.setTimer(fn, ms),
        clearTimer: (h) => this.ctx.clearTimer(h),
        log: (event, data) => this.ctx.logEvent(event, data),
        onChange: (v) => {
          if (this.gesture === g) this.ctx.patchPath({ gesture: v });
        },
      },
      sel.pageIndex,
      sel.paintSeqs,
      sel.plan,
      async () => {
        const plan = await this.ctx.pathRpc.planPathEdit(sel.pageIndex, sel.paintSeqs);
        return plan;
      },
    );
    this.gesture = g;
    this.ctx.patchPath({ gesture: g.view() });
    g.ready().catch((e) => {
      if (this.gesture !== g) return;
      this.gesture = null;
      this.ctx.patchPath({ gesture: null });
      this.handleFailure(e, this.t.pathStartFailed);
      // The same paintSeq points at a different path: clear the selection so a stale selection is not edited again.
      if (e instanceof PathTargetChangedError) this.clear();
    });
    return g;
  }

  /** On release: sends the latest edit and commits. true on success. */
  commitGesture(): Promise<boolean> {
    if (!this.gesture) return Promise.resolve(true);
    return (this.ending ??= this.doCommit().finally(() => {
      this.ending = null;
    }));
  }

  private async doCommit(): Promise<boolean> {
    const g = this.gesture;
    const sel = this.ctx.getPath().selection;
    if (!g || !sel) return true;
    const out: PathCommitOutcome = await g.commit();
    this.gesture = null;
    this.ctx.patchPath({ gesture: null });
    if (out.kind === 'failed') {
      this.ctx.repaintPage();
      this.handleFailure(new Error(out.error), this.t.pathApplyFailed);
      if (out.targetChanged) this.clear();
      return false;
    }
    if (out.kind === 'cancelled') {
      if (out.history) this.recordHistory(out.history);
      this.ctx.repaintPage();
      return true;
    }
    await this.afterCommit(out.result, sel.pageIndex);
    return true;
  }

  private recordHistory(history: EditHistoryState): void {
    this.ctx.log.recordHistory(history);
    this.ctx.patch({ history });
  }

  private async afterCommit(result: CommitResult, pageIndex: number): Promise<void> {
    this.ctx.log.recordCommit(result);
    this.ctx.patch({ history: result.history });
    const edit = result.op.kind === 'edit-path' ? result.op.edit : null;
    if (edit?.delete) this.clear();
    this.ctx.patchPath({ settling: true });
    let done = (): void => {};
    const settled = new Promise<void>((resolve) => (done = resolve));
    this.settled = settled;
    try {
      await this.ctx.invalidatePages([...new Set([pageIndex, ...result.history.affectedPages])]);
      this.ctx.logEvent('path-commit', { pageIndex, edits: result.history.edits });
      await this.ensureModel(pageIndex);
      await this.ctx.ensureEditability?.(pageIndex);
      if (!edit?.delete) await this.replan();
    } finally {
      if (this.settled === settled) this.settled = null;
      if (this.ctx.getPath().settling) this.ctx.patchPath({ settling: false });
      done();
    }
  }

  /** Esc: cancels the action in progress. false if there is none. */
  async cancelGesture(): Promise<boolean> {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    this.ctx.patchPath({ gesture: null });
    const history = await g.cancel();
    if (history) this.recordHistory(history);
    this.ctx.repaintPage();
    return true;
  }

  /**
   * Whether the selected paths fill or stroke (by path model PathInfo.op). If the model is not available yet, approximated by the plan (first target).
   * The stroke width and stroke color inputs are used only when there is a stroked path (review L6).
   */
  selectionPaints(): { fills: boolean; strokes: boolean } {
    const sel = this.ctx.getPath().selection;
    if (!sel) return { fills: false, strokes: false };
    const chosen = this.candidates(sel.pageIndex).filter((c) => sel.paintSeqs.includes(c.paintSeq));
    if (chosen.length === sel.paintSeqs.length) {
      const ops = chosen.flatMap((c) => c.infos.map((i) => i.op));
      return { fills: ops.includes('fill'), strokes: ops.includes('stroke') };
    }
    const plan = sel.plan;
    return {
      fills: (plan?.fill ?? null) !== null,
      strokes: (plan?.stroke ?? null) !== null || (plan?.lineWidth ?? null) !== null,
    };
  }

  /**
   * Keeps only the parts that actually change in a property edit. Drops paints that do not apply (fill color of a path without fill, stroke width of a path that is not stroked) and
   * values equal to the current value of a single selection. null if nothing remains (no edit is opened, review L6).
   */
  effectiveEdit(edit: PathEdit): PathEdit | null {
    const sel = this.ctx.getPath().selection;
    const plan = sel?.plan ?? null;
    const single = sel?.paintSeqs.length === 1;
    const paints = this.selectionPaints();
    const out: PathEdit = { ...edit };
    if (out.fill && (!paints.fills || (single && sameColor(out.fill, plan?.fill)))) out.fill = null;
    if (out.stroke && (!paints.strokes || (single && sameColor(out.stroke, plan?.stroke)))) {
      out.stroke = null;
    }
    if (out.lineWidth !== null) {
      const cur = plan?.lineWidth ?? null;
      const same =
        single && cur !== null && Math.abs(cur - out.lineWidth) <= 1e-6 * Math.max(1, cur);
      if (!paints.strokes || same) out.lineWidth = null;
    }
    return isNoopPathEdit(out) ? null : out;
  }

  /** An edit that finishes in one step, such as properties or delete. If nothing changes, no edit is opened and true is returned. */
  async applyOnce(edit: PathEdit): Promise<boolean> {
    const effective = this.effectiveEdit(edit);
    if (!effective) {
      this.ctx.logEvent('path-noop', { edit });
      return true;
    }
    const g = this.beginGesture();
    if (!g) return false;
    g.update(effective);
    return this.commitGesture();
  }

  async deleteSelected(): Promise<boolean> {
    return this.applyOnce(emptyPathEdit({ delete: true }));
  }

  // ── Common ───────────────────────────────────────────────────────────

  /** Before changing the page or doing document undo/redo: clears the selection and model. */
  reset(): void {
    this.gesture = null;
    this.loadingModel = null;
    this.settled = null;
    this.ctx.patchPath(initialPathState());
  }

  /** When the page cache is discarded: makes the model be re-read and keeps the selection (target of reclassification after an edit). */
  invalidateModel(): void {
    this.loadingModel = null;
    this.ctx.patchPath({ model: { status: 'idle' } });
  }

  private handleFailure(e: unknown, prefix: string): void {
    const failure = classifyFailure(e);
    if (failure.kind === 'unimplemented') {
      this.ctx.disablePath(failure.message);
      this.ctx.logOnce('path-unavailable', 'path-unavailable', {
        feature: '벡터 편집',
        reason: failure.message,
      });
      this.clear();
      return;
    }
    this.ctx.logEvent('path-error', {
      error: failure.message,
      recovered: failure.kind === 'recovered',
    });
    this.ctx.patch({
      notice:
        failure.kind === 'recovered'
          ? this.t.pathRecoveredReselect
          : this.t.failureWith(prefix, this.t.errorDetail(e)),
    });
    if (failure.kind === 'recovered') this.clear();
  }
}

export function emptyPathEdit(partial: Partial<PathEdit> = {}): PathEdit {
  return {
    transform: null,
    fill: null,
    stroke: null,
    lineWidth: null,
    points: null,
    delete: false,
    ...partial,
  };
}

/** Whether two colors are the same after 8-bit rounding (same rule as pdf-ops D3). Different if the current color is unknown. */
function sameColor(rgb: RGB, cur: PaintColor | null | undefined): boolean {
  const c = cur?.rgb;
  return !!c && rgb.every((v, i) => Math.round(v * 255) === Math.round(c[i]! * 255));
}
