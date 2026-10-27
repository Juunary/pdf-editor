/**
 * Edit coordinator (DOM-independent): page editability classification, entry (plan → begin), session end (commit/cancel), document undo/redo, recovery log.
 * Owned by `ViewerController`; state is passed to components through `ViewerState.edit`.
 *
 * Feature isolation: if an edit RPC throws an "M3 not implemented" exception, only the edit feature is turned off (`failure.ts`, contract section 4 wiring).
 */
import type {
  EditHistoryState,
  PageEditability,
  PageModel,
  ParagraphEditPlan,
  Point,
  Rect,
} from '@pdf-editor/shared-types';
import { offsetAtPagePoint } from './edit-geometry.js';
import { limitItems, limitLabel } from './edit-labels.js';
import type { EditLog } from './edit-log.js';
import type { InputBufferPort } from './input-buffer.js';
import { EditSession, isWorkerRecovered, type EditSessionView } from './edit-session.js';
import { classifyFailure } from './failure.js';
import {
  initialPathState,
  PathController,
  type PathContext,
  type PathState,
} from './path-controller.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';
import type { EditHostApi, PathHostApi } from './viewer-host.js';

export type EditLoadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; pageIndex: number }
  | { status: 'ready'; pageIndex: number; value: T }
  | { status: 'error'; pageIndex: number; message: string };

/** Reason popover shown when double-clicking a paragraph that cannot be edited. */
export interface EditPopover {
  /** 'cell' (title text) for a table cell. Otherwise a paragraph. */
  kind?: 'paragraph' | 'cell';
  pageIndex: number;
  paragraphId: number;
  bbox: Rect;
  /** Reason text (display language). */
  items: string[];
}

export interface EditState {
  /** Per-paragraph editability classification of the current page (hover border). */
  editability: EditLoadable<PageEditability>;
  /** plan/begin in progress. */
  starting: boolean;
  popover: EditPopover | null;
  session: EditSessionView | null;
  /** Document undo/redo state (filled in after the edit RPC responds). */
  history: EditHistoryState | null;
  /** Document undo/redo in progress. */
  busy: boolean;
  /** User notice (recovery/error). */
  notice: string | null;
  /** Block editing of tagged PDFs (setting, off by default, contract D1). */
  blockTagged: boolean;
  /** Show a dotted underline for fallback characters (toggle). */
  fallbackUnderline: boolean;
  /** Editability overlay (D6): draw all paragraph, cell and path borders over the page. */
  showEditable: boolean;
  /** Vector path editing (M4) state. */
  path: PathState;
}

export function initialEditState(): EditState {
  return {
    editability: { status: 'idle' },
    starting: false,
    popover: null,
    session: null,
    history: null,
    busy: false,
    notice: null,
    blockTagged: false,
    fallbackUnderline: true,
    showEditable: false,
    path: initialPathState(),
  };
}

/** Whether the plan points at a tagged page (has an MCID or a tag warning). */
export function isTaggedPlan(plan: ParagraphEditPlan): boolean {
  return (
    plan.warnings.some(
      (w) => w.kind === 'tagged-structure-kept' || w.kind === 'tagged-structure-unlinked',
    ) ||
    (plan.insertion !== null && plan.insertion.mcidKept !== null)
  );
}

export interface CurrentView {
  pageIndex: number;
  /** Changed-region render scale (viewer scale × devicePixelRatio). */
  renderScale: number;
  /** Extraction model (if absent, the start caret goes to the paragraph end). */
  text: PageModel | null;
}

export interface EditContext {
  rpc: EditHostApi;
  log: EditLog;
  /** Toolbar edit notice strings (Korean by default). */
  strings?: ViewerStrings;
  now(): number;
  getState(): EditState;
  patch(partial: Partial<EditState>): void;
  currentView(): CurrentView | null;
  isStalePage(pageIndex: number): boolean;
  /** Permanently disables the edit feature. */
  disable(reason: string): void;
  logEvent(event: string, data?: unknown): void;
  logOnce(kind: string, event: string, data: unknown): void;
  /** Discards the page cache and redraws (when the current page is included). */
  invalidatePages(pages: number[]): Promise<void>;
  /** After cancel, restores the page canvas to the pre-edit render. */
  repaintPage(): void;
  /** Vector path editing (M4) wiring. null if the host provides no path RPC. */
  paths: {
    rpc: PathHostApi;
    extract(pageIndex: number): Promise<PageModel>;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    disable(reason: string): void;
  } | null;
}

export class EditController {
  private session: EditSession | null = null;
  private ending: Promise<boolean> | null = null;
  /** Vector path editing (M4). null if the host provides no path RPC. */
  readonly paths: PathController | null;
  /** Buffer that collects input before the editor opens (the DOM implementation is injected by mount). */
  private buffer: InputBufferPort | null = null;

  constructor(private readonly ctx: EditContext) {
    const p = ctx.paths;
    this.paths = p
      ? new PathController({
          ...ctx,
          pathRpc: p.rpc,
          extractPaths: (i) => p.extract(i),
          setTimer: (fn, ms) => p.setTimer(fn, ms),
          clearTimer: (h) => p.clearTimer(h),
          disablePath: (reason) => p.disable(reason),
          ensureEditability: (i) => this.ensureEditability(i),
          getPath: () => ctx.getState().path,
          patchPath: (partial) => ctx.patch({ path: { ...ctx.getState().path, ...partial } }),
        } satisfies PathContext)
      : null;
  }

  private get t(): ViewerStrings {
    return this.ctx.strings ?? VIEWER_STRINGS.ko;
  }

  setInputBuffer(buffer: InputBufferPort | null): void {
    this.buffer?.close();
    this.buffer = buffer;
  }

  get active(): boolean {
    return this.session !== null || (this.paths?.active ?? false);
  }

  /** For tests/e2e: the current session (response time records, etc.). */
  currentSession(): EditSession | null {
    return this.session;
  }

  // ── Page classification and history ──────────────────────────────────

  /**
   * Loads the page classification. If the same page is already loading, waits for that request to finish (so a path Alt+click selection
   * does not end with no candidates before the classification arrives).
   */
  async ensureEditability(pageIndex: number): Promise<void> {
    const current = this.ctx.getState().editability;
    if (current.status === 'ready' && current.pageIndex === pageIndex) return;
    if (current.status === 'loading' && current.pageIndex === pageIndex) {
      await this.editabilityPending;
      return;
    }
    const pending = this.loadEditability(pageIndex);
    this.editabilityPending = pending;
    try {
      await pending;
    } finally {
      if (this.editabilityPending === pending) this.editabilityPending = null;
    }
  }

  private editabilityPending: Promise<void> | null = null;

  private async loadEditability(pageIndex: number): Promise<void> {
    this.ctx.patch({ editability: { status: 'loading', pageIndex } });
    try {
      const value = await this.ctx.rpc.getPageEditability(pageIndex);
      if (this.ctx.isStalePage(pageIndex)) return this.resetLoading(pageIndex);
      this.ctx.patch({ editability: { status: 'ready', pageIndex, value } });
      // Page where only the path classification failed: keep using paragraph editing and just log a diagnostic.
      if (value.pathError) {
        this.ctx.logEvent('path-editability-error', { pageIndex, error: value.pathError });
      }
      if (this.ctx.getState().history === null) void this.refreshHistory();
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.ctx.disable(failure.message);
        this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
          feature: '문단 편집',
          reason: failure.message,
        });
        this.ctx.patch({ editability: { status: 'error', pageIndex, message: failure.message } });
      } else {
        if (this.ctx.isStalePage(pageIndex)) return this.resetLoading(pageIndex);
        this.ctx.logEvent('edit-editability-error', { pageIndex, error: failure.message });
        this.ctx.patch({ editability: { status: 'error', pageIndex, message: failure.message } });
      }
    }
  }

  private resetLoading(pageIndex: number): void {
    const cur = this.ctx.getState().editability;
    if (cur.status === 'loading' && cur.pageIndex === pageIndex) {
      this.ctx.patch({ editability: { status: 'idle' } });
    }
  }

  invalidateEditability(): void {
    this.ctx.patch({ editability: { status: 'idle' } });
  }

  async refreshHistory(): Promise<void> {
    try {
      const history = await this.ctx.rpc.getEditHistory();
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.ctx.disable(failure.message);
        this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
          feature: '문단 편집',
          reason: failure.message,
        });
      } else if (failure.kind !== 'recovered') {
        this.ctx.logEvent('edit-history-error', { error: failure.message });
      }
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────

  setBlockTagged(blockTagged: boolean): void {
    this.ctx.patch({ blockTagged });
  }

  setFallbackUnderline(fallbackUnderline: boolean): void {
    this.ctx.patch({ fallbackUnderline });
  }

  /** Editability overlay (D6) toggle. Turning it on preloads the model used for path selection. */
  setShowEditable(showEditable: boolean): void {
    this.ctx.patch({ showEditable });
    const view = this.ctx.currentView();
    if (showEditable && view && this.paths) void this.paths.ensureModel(view.pageIndex);
  }

  dismissPopover(): void {
    if (this.ctx.getState().popover) this.ctx.patch({ popover: null });
  }

  dismissNotice(): void {
    if (this.ctx.getState().notice) this.ctx.patch({ notice: null });
  }

  // ── Entry ────────────────────────────────────────────────────────────

  /**
   * Starts paragraph editing (double-click). If it cannot be edited, shows the reason popover.
   * point (page space) is the start caret position (original document character → text position, contract 5.3).
   */
  async begin(pageIndex: number, paragraphId: number, point: Point | null): Promise<void> {
    const state = this.ctx.getState();
    if (this.session || state.starting || state.busy || this.paths?.active) return;
    this.paths?.clear();
    const hadRedo = state.history?.canRedo === true;
    this.ctx.patch({ starting: true, popover: null, notice: null });
    // Collect characters typed while the editor opens (plan → begin). Insert them once it opens; drop them if it fails to open.
    this.buffer?.open();
    let started = false;
    try {
      let plan = await this.ctx.rpc.planParagraphEdit(pageIndex, paragraphId);
      if (!plan.editable) {
        this.showLimits(plan);
        return;
      }
      if (state.blockTagged && isTaggedPlan(plan)) {
        this.ctx.patch({
          popover: {
            pageIndex,
            paragraphId,
            bbox: plan.target.bbox,
            items: [this.t.taggedBlocked],
          },
        });
        return;
      }
      let begun;
      try {
        begun = await this.ctx.rpc.beginParagraphEdit(
          pageIndex,
          paragraphId,
          plan.revision,
          this.ctx.currentView()?.renderScale,
        );
      } catch (e) {
        // Stale revision (the document changed in between): classify again and retry once.
        if (!/revision/i.test(classifyFailure(e).message)) throw e;
        plan = await this.ctx.rpc.planParagraphEdit(pageIndex, paragraphId);
        if (!plan.editable) {
          this.showLimits(plan);
          return;
        }
        begun = await this.ctx.rpc.beginParagraphEdit(
          pageIndex,
          paragraphId,
          plan.revision,
          this.ctx.currentView()?.renderScale,
        );
      }
      const view = this.ctx.currentView();
      const text = view?.text ?? null;
      const caret = point && text ? offsetAtPagePoint(text, plan.charIndexOfOffset, point) : null;
      this.session = new EditSession(
        {
          rpc: this.ctx.rpc,
          now: () => this.ctx.now(),
          renderScale: () => this.ctx.currentView()?.renderScale ?? 1,
          log: (event, data) => this.ctx.logEvent(event, data),
          onChange: (v) => this.ctx.patch({ session: v }),
          strings: this.t,
        },
        plan,
        begun,
        caret,
      );
      this.ctx.patch({ session: this.session.view() });
      this.session.start();
      started = true;
      // Starting a new edit makes core discard the redo stage (contract D9; not restored even if cancelled).
      if (hadRedo) this.ctx.patch({ notice: this.t.redoDiscarded });
      const buffered = this.buffer?.take() ?? '';
      if (buffered !== '') {
        this.session.typeText(buffered);
        this.ctx.logEvent('edit-input-buffered', { length: buffered.length });
      }
      this.ctx.logEvent('edit-begin', {
        pageIndex,
        paragraphId,
        warnings: plan.warnings.map((w) => w.kind),
        planMs: plan.planMs,
      });
    } catch (e) {
      this.handleFailure(e, this.t.editStartFailed);
    } finally {
      if (!started) this.buffer?.close();
      this.ctx.patch({ starting: false });
    }
  }

  private isCellParagraph(paragraphId: number): boolean {
    const e = this.ctx.getState().editability;
    return (
      e.status === 'ready' &&
      e.value.paragraphs.some((p) => p.paragraphId === paragraphId && p.cell !== null)
    );
  }

  private showLimits(plan: ParagraphEditPlan): void {
    // Korean uses only the core detail text if there is any (previous behavior); English uses the reason-code text.
    const withDetail = plan.limits.filter((l) => l.detail !== '');
    const items = limitItems(
      this.t.lang === 'ko' && withDetail.length > 0 ? withDetail : plan.limits,
      this.t.paragraphNotEditable,
      this.t,
    );
    this.ctx.patch({
      popover: {
        kind: plan.target.cell || this.isCellParagraph(plan.paragraphId) ? 'cell' : 'paragraph',
        pageIndex: plan.pageIndex,
        paragraphId: plan.paragraphId,
        bbox: plan.target.bbox,
        items,
      },
    });
  }

  /** Shows the popover from getPageEditability reason codes alone (without a plan call). */
  showReasons(pageIndex: number, paragraphId: number, bbox: Rect, reasons: string[]): void {
    this.ctx.patch({
      popover: {
        pageIndex,
        paragraphId,
        bbox,
        items:
          reasons.length > 0
            ? [...new Set(reasons.map((r) => limitLabel(r, this.t)))]
            : [this.t.paragraphNotEditable],
      },
    });
  }

  private handleFailure(e: unknown, prefix: string): void {
    const failure = classifyFailure(e);
    if (failure.kind === 'unimplemented') {
      this.ctx.disable(failure.message);
      this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
        feature: '문단 편집',
        reason: failure.message,
      });
      return;
    }
    this.ctx.logEvent('edit-error', {
      error: failure.message,
      recovered: failure.kind === 'recovered',
    });
    this.ctx.patch({
      notice:
        failure.kind === 'recovered'
          ? this.t.editRecoveredRestart
          : this.t.failureWith(prefix, this.t.errorDetail(e)),
    });
  }

  // ── End ──────────────────────────────────────────────────────────────

  private endSession(): void {
    this.session?.dispose();
    this.session = null;
    this.ctx.patch({ session: null });
  }

  /**
   * Commits the draft if there is one (outside click, Ctrl+S, page change). With no changes it is the same as cancel.
   * Returns true if edit mode was left (or never entered), false if still editing.
   */
  commitActive(): Promise<boolean> {
    if (this.paths?.active) return this.paths.commitGesture();
    if (!this.session) return Promise.resolve(true);
    return (this.ending ??= this.doCommit().finally(() => {
      this.ending = null;
    }));
  }

  private async doCommit(): Promise<boolean> {
    const session = this.session;
    if (!session) return true;
    try {
      const out = await session.commit();
      if (out.kind === 'restarted') {
        this.ctx.patch({ notice: this.t.editRecoveredContinue });
        return false;
      }
      if (out.kind === 'kept') {
        // The last input could not be applied to the draft, so no commit. Keep the editor open (the error also shows on the editor info line).
        this.ctx.patch({ notice: this.t.editNotApplied(this.t.errorDetail(out.error)) });
        return false;
      }
      this.endSession();
      if (out.kind === 'committed') {
        this.ctx.log.recordCommit(out.result);
        this.ctx.patch({ history: out.result.history });
        await this.ctx.invalidatePages([
          ...new Set([session.pageIndex, ...out.result.history.affectedPages]),
        ]);
        this.ctx.logEvent('edit-commit', {
          pageIndex: session.pageIndex,
          edits: out.result.history.edits,
        });
      } else {
        this.ctx.log.recordHistory(out.history);
        this.ctx.patch({ history: out.history });
        this.ctx.repaintPage();
      }
      return true;
    } catch (e) {
      this.handleFailure(e, this.t.editSaveFailed);
      return false;
    }
  }

  /** Toolbar "Cancel edit" button. */
  async cancelActive(): Promise<void> {
    if (await this.paths?.cancelGesture()) return;
    if (this.ending) await this.ending;
    const session = this.session;
    if (!session) return;
    try {
      const history = await session.cancel();
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } catch (e) {
      if (!isWorkerRecovered(e)) {
        this.handleFailure(e, this.t.editCancelFailed);
        return;
      }
    }
    this.endSession();
    this.ctx.repaintPage();
  }

  // ── Document undo/redo ───────────────────────────────────────────────

  async undo(): Promise<void> {
    await this.step('undo');
  }

  async redo(): Promise<void> {
    await this.step('redo');
  }

  private async step(kind: 'undo' | 'redo'): Promise<void> {
    const state = this.ctx.getState();
    if (this.session || state.starting || state.busy || this.paths?.active) return;
    this.paths?.reset();
    const history = state.history;
    if (history && !(kind === 'undo' ? history.canUndo : history.canRedo)) return;
    this.ctx.patch({ busy: true });
    try {
      const next = await this.ctx.rpc[kind]();
      this.ctx.log.recordHistory(next);
      this.ctx.patch({ history: next });
      await this.ctx.invalidatePages(next.affectedPages);
      this.ctx.logEvent(`edit-${kind}`, { affectedPages: next.affectedPages, edits: next.edits });
    } catch (e) {
      this.handleFailure(e, kind === 'undo' ? this.t.undoFailed : this.t.redoFailed);
    } finally {
      this.ctx.patch({ busy: false });
    }
  }

  // ── Recovery ─────────────────────────────────────────────────────────

  /**
   * Called after the extension recreates the Worker and recovers the document (contract D6). If a draft was in progress, restarts the draft of the same paragraph
   * with the editor model; otherwise discards the page cache. The undo history from before recovery is gone, so the user is notified.
   */
  async handleWorkerRecovered(history: EditHistoryState | null): Promise<void> {
    if (history) {
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } else {
      this.ctx.patch({ history: null });
    }
    this.ctx.patch({ editability: { status: 'idle' } });
    if (this.paths) {
      const hadGesture = this.paths.active;
      await this.paths.cancelGesture();
      this.paths.reset();
      if (hadGesture) {
        this.ctx.patch({ notice: this.t.recoveredPathCancelled });
      }
    }
    const session = this.session;
    if (session) {
      try {
        await session.restart();
        this.ctx.patch({ notice: this.t.recoveredParagraphReopened });
      } catch (e) {
        this.handleFailure(e, this.t.restartAfterRecoveryFailed);
      }
      return;
    }
    this.ctx.patch({ notice: this.t.recoveredHistoryLost });
    const view = this.ctx.currentView();
    if (view) await this.ctx.invalidatePages([view.pageIndex]);
  }
}
