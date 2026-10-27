/**
 * Viewer state controller. Asynchronously coordinates page navigation, rendering, the extraction model, search, and debug integration.
 *
 * - Does not depend on the DOM (canvas drawing and events are the components' job). Tested in Node with a fake `ViewerHost`.
 * - Per-feature failure isolation: if extractPage, searchText or linkPage throws an "M1 not implemented" exception, only that feature is disabled and
 *   it is recorded in the diagnostic log (`host.log`). Rendering and page navigation keep working.
 * - So that a slow response does not overwrite the latest state, stale responses are dropped using a per-request token.
 */
import type {
  PageInfo,
  PageLayout as DocumentPageLayout,
  PageLinkage,
  PageModel,
  RenderedPage,
  SourceMap,
} from '@pdf-editor/shared-types';
import { EditController, initialEditState, type EditState } from './edit-controller.js';
import { EditLog } from './edit-log.js';
import { classifyFailure } from './failure.js';
import { fitWidthScale, pageLayout, renderScale, type PageLayout } from './layout.js';
import { clampPage, parsePageInput, stepPage } from './page-nav.js';
import { buildReadingOrder, type ReadingOrder } from './reading-order.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';
import { RenderCache, type RenderCacheLimits } from './render-cache.js';
import {
  applySearchResult,
  clearResults,
  currentHit,
  initialFindState,
  stepHit,
  type FindState,
} from './search-nav.js';
import {
  hasEditHost,
  hasPathHost,
  type ViewerEnvironment,
  type ViewerHost,
} from './viewer-host.js';

export type FeatureName = 'text' | 'search' | 'debug' | 'layout' | 'edit' | 'path';

/** The current page whose render has finished. The reference for overlay layout. */
export interface PageView {
  pageIndex: number;
  info: PageInfo;
  rendered: RenderedPage;
  layout: PageLayout;
}

export type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; pageIndex: number }
  | { status: 'ready'; pageIndex: number; value: T }
  | { status: 'error'; pageIndex: number; message: string };

export interface TextData {
  model: PageModel;
  order: ReadingOrder;
}

export interface DebugData {
  linkage: PageLinkage;
  map: SourceMap;
}

export interface ViewerState {
  pageCount: number;
  /** Page whose navigation was requested (may be before the render completes). The rendered page is view.pageIndex. */
  pageIndex: number;
  loading: boolean;
  renderError: string | null;
  view: PageView | null;
  text: Loadable<TextData>;
  debugEnabled: boolean;
  debug: Loadable<DebugData>;
  /** Layout overlay (M2 getPageLayout: paragraphs, tables, shapes, reading order). */
  layoutEnabled: boolean;
  layout: Loadable<DocumentPageLayout>;
  /** Reason for permanent disablement (null if none). */
  disabled: Record<FeatureName, string | null>;
  find: FindState;
  /** Paragraph editing (M3) state. */
  edit: EditState;
  /** Each time it is incremented, redraws the page canvas with the current `view` render (restore after edit cancel). */
  repaintToken: number;
}

export interface PagePaintedEvent {
  pageIndex: number;
  pageCount: number;
  width: number;
  height: number;
  cssScale: number;
  devicePixelRatio: number;
  renderScale: number;
  renderMs: number;
}

export interface ViewerControllerOptions {
  host: ViewerHost;
  pageCount: number;
  initialPage?: number;
  /** Reads the current environment values (called each time a page is drawn). */
  getEnvironment(): ViewerEnvironment;
  /** pt width → CSS scale. Default: fit to screen width (`fitWidthScale`). */
  cssScaleFor?(pageWidthPt: number, env: ViewerEnvironment): number;
  /** Wait from search-term input to search (ms). Default 200. */
  findDebounceMs?: number;
  /** Called after a component draws the bitmap onto the canvas. */
  onPagePainted?(event: PagePaintedEvent): void;
  /** Edit log for recovery (D6). The caller (extension) also gives the same instance to the recovery layer. If absent, one is created internally. */
  editLog?: EditLog;
  /** Time (ms, performance.now). Injected in tests. */
  now?(): number;
  /** Render cache limit (default 8 pages, 64 MiB). For benchmark comparison experiments. */
  renderCacheLimits?: RenderCacheLimits;
  /** Pre-render the next page when idle (default true, M5 contract 4.1). */
  prefetch?: boolean;
  /** Runs `fn` at an idle moment. Default: `requestIdleCallback` (`setTimeout` if absent). Injected in tests. */
  scheduleIdle?(fn: () => void): void;
  /** UI string table (`strings.ts`). Korean by default. The extension picks it by the browser UI language. */
  strings?: ViewerStrings;
}

export type StateListener = (state: ViewerState) => void;

const DEFAULT_FIND_DEBOUNCE_MS = 200;
/** Minimum scale difference (ratio) that triggers a redraw on environment change. */
const RESCALE_THRESHOLD = 0.005;

/** Reason a feature cannot be used. null if it can. Debug requires a PageModel. */
export function featureDisabledReason(state: ViewerState, feature: FeatureName): string | null {
  const own = state.disabled[feature];
  if (own) return own;
  if (feature === 'debug' && state.disabled.text) return `PageModel 없음: ${state.disabled.text}`;
  return null;
}

/**
 * The "Layout/edit overlay" button (user request 2026-10-22): turns the layout overlay and the editability overlay (when on, clicking selects a path)
 * on and off together with one button. If only one of them is available, only that one is toggled.
 */
export interface OverlayToggleState {
  /** true if any of the available ones is on (button pressed). */
  on: boolean;
  /** Reason the layout overlay cannot be used (null if it can). */
  layoutReason: string | null;
  /** Reason the editability overlay cannot be used (null if it can). */
  marksReason: string | null;
}

/** Editability overlay reason (Korean) for hosts without edit RPCs (read-only harness, benchmarks). */
export const NO_EDIT_HOST_REASON = VIEWER_STRINGS.ko.noEditHost;

export function overlayToggleState(
  state: ViewerState,
  hasEdit: boolean,
  t: ViewerStrings = VIEWER_STRINGS.ko,
): OverlayToggleState {
  const layoutReason = featureDisabledReason(state, 'layout');
  const marksReason = hasEdit ? state.disabled.edit : t.noEditHost;
  return {
    on:
      (layoutReason === null && state.layoutEnabled) ||
      (marksReason === null && state.edit.showEditable),
    layoutReason,
    marksReason,
  };
}

/** Title (tooltip) of the combined button. For the unavailable one, the reason is given. */
export function overlayToggleTitle(
  s: OverlayToggleState,
  pathSelect: boolean,
  t: ViewerStrings = VIEWER_STRINGS.ko,
): string {
  const lines = [t.overlayIntro];
  if (s.marksReason === null && pathSelect) lines.push(t.overlayPathSelect);
  if (s.layoutReason !== null && s.marksReason !== null) {
    lines.push(
      t.overlayLayoutReason(t.errorDetail(s.layoutReason)),
      t.overlayMarksReason(t.errorDetail(s.marksReason)),
    );
  } else if (s.layoutReason !== null) {
    lines.push(t.overlayMarksOnly(t.errorDetail(s.layoutReason)));
  } else if (s.marksReason !== null) {
    lines.push(t.overlayLayoutOnly(t.errorDetail(s.marksReason)));
  }
  return lines.join('\n');
}

export class ViewerController {
  private state: ViewerState;
  private readonly listeners = new Set<StateListener>();
  private readonly host: ViewerHost;
  private loadToken = 0;
  private searchToken = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchRunning = false;
  private searchPending = false;
  private disposed = false;
  private readonly loggedKinds = new Set<string>();
  /** Edit (M3) coordinator. null if the host provides no edit RPC. */
  readonly edit: EditController | null;
  readonly editLog: EditLog;
  /** Window size change that arrived during editing (applied after editing ends). */
  private envRefreshPending = false;
  /** Page render LRU (the smaller of 8 pages and 64 MiB). Pages whose document changed are dropped by `invalidatePages`. */
  readonly renderCache: RenderCache;
  private prefetchRunning = false;
  /** UI string table (option `strings`, Korean by default). */
  readonly strings: ViewerStrings;

  constructor(private readonly options: ViewerControllerOptions) {
    this.host = options.host;
    this.renderCache = new RenderCache(options.renderCacheLimits);
    this.editLog = options.editLog ?? new EditLog();
    this.strings = options.strings ?? VIEWER_STRINGS.ko;
    const pageIndex = clampPage(options.initialPage ?? 0, options.pageCount);
    this.state = {
      pageCount: options.pageCount,
      pageIndex,
      loading: false,
      renderError: null,
      view: null,
      text: { status: 'idle' },
      debugEnabled: false,
      debug: { status: 'idle' },
      layoutEnabled: false,
      layout: { status: 'idle' },
      disabled: { text: null, search: null, debug: null, layout: null, edit: null, path: null },
      find: initialFindState(),
      edit: initialEditState(),
      repaintToken: 0,
    };
    const host = options.host;
    if (hasEditHost(host)) {
      this.edit = new EditController({
        rpc: host,
        log: this.editLog,
        strings: this.strings,
        now: options.now ?? (() => performance.now()),
        getState: () => this.state.edit,
        patch: (partial) => this.patch({ edit: { ...this.state.edit, ...partial } }),
        currentView: () => {
          const view = this.state.view;
          if (!view) return null;
          const text = this.state.text;
          return {
            pageIndex: view.pageIndex,
            renderScale: renderScale(view.layout.cssScale, view.layout.devicePixelRatio),
            text:
              text.status === 'ready' && text.pageIndex === view.pageIndex
                ? text.value.model
                : null,
          };
        },
        isStalePage: (pageIndex) => this.isStalePage(pageIndex),
        disable: (reason) => this.disable('edit', reason),
        logEvent: (event, data) => this.host.log(event, data),
        logOnce: (kind, event, data) => this.logOnce(kind, event, data),
        invalidatePages: (pages) => this.invalidatePages(pages),
        repaintPage: () => this.patch({ repaintToken: this.state.repaintToken + 1 }),
        paths: hasPathHost(host)
          ? {
              rpc: host,
              extract: (pageIndex) => host.extractPage({ pageIndex, includePathSegments: true }),
              setTimer: (fn, ms) => setTimeout(fn, ms),
              clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
              disable: (reason) => this.disable('path', reason),
            }
          : null,
      });
    } else {
      // A configuration where the host provides no edit RPC (e.g. read-only harness): the edit UI is not created.
      this.edit = null;
    }
  }

  getState(): ViewerState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.loadToken++;
    this.searchToken++;
    this.clearDebounce();
    this.listeners.clear();
  }

  private patch(partial: Partial<ViewerState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...partial };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  private patchFind(find: FindState): void {
    this.patch({ find });
  }

  private disable(feature: FeatureName, reason: string): void {
    this.patch({ disabled: { ...this.state.disabled, [feature]: reason } });
  }

  /** Logs of the same kind are recorded only once (prevents the "not implemented" log repeated on every page). */
  private logOnce(kind: string, event: string, data: unknown): void {
    if (this.loggedKinds.has(kind)) return;
    this.loggedKinds.add(kind);
    this.host.log(event, data);
  }

  // ── Page navigation · rendering ──────────────────────────────────────

  start(): Promise<void> {
    return this.goToPage(this.state.pageIndex);
  }

  nextPage(): Promise<void> {
    return this.goToPage(stepPage(this.state.pageIndex, 1, this.state.pageCount));
  }

  prevPage(): Promise<void> {
    return this.goToPage(stepPage(this.state.pageIndex, -1, this.state.pageCount));
  }

  /** Navigate by the input box string (1-based). If invalid, returns false and does not navigate. */
  goToPageInput(text: string): boolean {
    const index = parsePageInput(text, this.state.pageCount);
    if (index === null) return false;
    void this.goToPage(index);
    return true;
  }

  async goToPage(index: number): Promise<void> {
    const target = clampPage(index, this.state.pageCount);
    // If there is a draft, commit it first (so the draft is not lost during page navigation). If the commit fails and editing continues, do not navigate.
    if (this.edit?.active && target !== this.state.pageIndex && !(await this.edit.commitActive())) {
      return;
    }
    if (target !== this.state.pageIndex) this.edit?.paths?.reset();
    const { pageIndex, loading, view } = this.state;
    // Do not redraw a page that is already being viewed or loaded.
    if (target === pageIndex && (loading || view?.pageIndex === target)) return;
    await this.loadView(target);
  }

  /** After a window size, zoom or dpr change, redraws the current page at the new scale (the extraction model is reused). */
  async refreshEnvironment(): Promise<void> {
    const view = this.state.view;
    if (!view || this.state.loading) return;
    if (this.edit?.active) {
      // Do not redraw the page canvas during editing (keeps the base scale for changed-region compositing). Apply it after editing ends.
      this.envRefreshPending = true;
      return;
    }
    const env = this.options.getEnvironment();
    const cssScale = this.cssScaleFor(view.info.size.width, env);
    const sameDpr = env.devicePixelRatio === view.layout.devicePixelRatio;
    const sameScale =
      Math.abs(cssScale - view.layout.cssScale) <= view.layout.cssScale * RESCALE_THRESHOLD;
    if (sameDpr && sameScale) return;
    await this.loadView(view.pageIndex);
  }

  private cssScaleFor(pageWidthPt: number, env: ViewerEnvironment): number {
    return (
      this.options.cssScaleFor?.(pageWidthPt, env) ??
      fitWidthScale({ availableWidth: env.availableWidth, pageWidthPt })
    );
  }

  private async loadView(target: number): Promise<void> {
    const token = ++this.loadToken;
    this.patch({ pageIndex: target, loading: true, renderError: null });
    const env = this.options.getEnvironment();
    try {
      const info = await this.host.getPageInfo(target);
      const cssScale = this.cssScaleFor(info.size.width, env);
      const scale = renderScale(cssScale, env.devicePixelRatio);
      const epoch = this.renderCache.epoch;
      let rendered = this.renderCache.get(target, scale);
      if (!rendered) {
        rendered = await this.host.renderPage({ pageIndex: target, scale });
        this.renderCache.put(target, scale, rendered, epoch);
      }
      if (token !== this.loadToken) return;
      const layout = pageLayout({
        bounds: info.bounds,
        cssScale,
        devicePixelRatio: env.devicePixelRatio,
        bitmap: rendered,
      });
      this.patch({ view: { pageIndex: target, info, rendered, layout }, loading: false });
    } catch (e) {
      if (token !== this.loadToken) return;
      const failure = classifyFailure(e);
      this.host.log('render-error', { pageIndex: target, error: failure.message });
      this.patch({ loading: false, renderError: failure.message });
      return;
    }
    await this.loadPageData(target);
    this.schedulePrefetch(target);
  }

  /** When the current page has finished processing and the app is idle, pre-renders the next page at the same scale (1 page). */
  private schedulePrefetch(from: number): void {
    if (this.options.prefetch === false || this.prefetchRunning) return;
    const idle =
      this.options.scheduleIdle ??
      ((fn: () => void) =>
        typeof requestIdleCallback === 'function'
          ? requestIdleCallback(() => fn())
          : setTimeout(fn, 0));
    idle(() => void this.prefetchNext(from));
  }

  private async prefetchNext(from: number): Promise<void> {
    const next = from + 1;
    const state = this.state;
    if (
      this.disposed ||
      this.prefetchRunning ||
      next >= state.pageCount ||
      state.pageIndex !== from ||
      state.loading ||
      this.edit?.active ||
      !state.view
    ) {
      return;
    }
    this.prefetchRunning = true;
    try {
      const env = this.options.getEnvironment();
      const info = await this.host.getPageInfo(next);
      const scale = renderScale(this.cssScaleFor(info.size.width, env), env.devicePixelRatio);
      if (this.renderCache.has(next, scale)) return;
      const epoch = this.renderCache.epoch;
      const rendered = await this.host.renderPage({ pageIndex: next, scale });
      this.renderCache.put(next, scale, rendered, epoch);
    } catch {
      // Pre-rendering is best effort. A failure resurfaces on the actual navigation.
    } finally {
      this.prefetchRunning = false;
    }
  }

  /** Loads the extraction model (text layer, debug) separately from rendering. Failures are isolated per feature. */
  private async loadPageData(pageIndex: number): Promise<void> {
    await this.ensureText(pageIndex);
    if (this.state.debugEnabled) await this.ensureDebug(pageIndex);
    if (this.state.layoutEnabled) await this.ensureLayout(pageIndex);
    if (this.edit && !this.state.disabled.edit) await this.edit.ensureEditability(pageIndex);
    if (this.edit?.paths && !this.state.disabled.path && this.state.edit.showEditable) {
      await this.edit.paths.ensureModel(pageIndex);
    }
  }

  /**
   * After page content changes through edit, undo or recovery: if the current page is included, discards the page cache (extraction model, layout, edit classification) and redraws.
   * Search results are at old positions, so they are cleared and, if the search bar is open, the search is run again.
   */
  async invalidatePages(pages: number[]): Promise<void> {
    this.renderCache.invalidate(pages);
    const current = this.state.view?.pageIndex ?? this.state.pageIndex;
    if (!pages.includes(current)) return;
    this.patch({
      text: { status: 'idle' },
      debug: { status: 'idle' },
      layout: { status: 'idle' },
      edit: {
        ...this.state.edit,
        editability: { status: 'idle' },
        path: { ...this.state.edit.path, model: { status: 'idle' } },
      },
    });
    const find = this.state.find;
    if (find.query !== '') {
      this.patchFind({ ...clearResults(find) });
      if (!this.state.disabled.search) void this.runSearch();
    }
    await this.loadView(current);
  }

  /** Applies the environment change deferred when editing ended. */
  private async flushPendingEnvironment(): Promise<void> {
    if (!this.envRefreshPending || this.edit?.active) return;
    this.envRefreshPending = false;
    await this.refreshEnvironment();
  }

  /** Called after the extension recovers the Worker (the edit coordinator restarts the draft and cleans up the cache). */
  async handleWorkerRecovered(): Promise<void> {
    this.renderCache.clear();
    if (!this.edit) {
      const view = this.state.view;
      if (view) await this.invalidatePages([view.pageIndex]);
      return;
    }
    const history = await this.host.getEditHistory?.().catch(() => null);
    await this.edit.handleWorkerRecovered(history ?? null);
  }

  /** Applies the environment change deferred after an edit coordinator call (components and the extension call it after editing ends). */
  async afterEditEnded(): Promise<void> {
    await this.flushPendingEnvironment();
  }

  /** The extraction model is independent of scale, so a response is dropped only when the user has moved to another page. */
  private isStalePage(pageIndex: number): boolean {
    return this.disposed || this.state.pageIndex !== pageIndex;
  }

  /** Clears the loading marker left by a dropped request so the page is reloaded if the user returns to it later. */
  private resetStaleLoading(kind: 'text' | 'debug' | 'layout', pageIndex: number): void {
    const current = this.state[kind];
    if (!this.disposed && current.status === 'loading' && current.pageIndex === pageIndex) {
      this.patch({ [kind]: { status: 'idle' } } as Partial<ViewerState>);
    }
  }

  private async ensureText(pageIndex: number): Promise<void> {
    if (this.state.disabled.text) return;
    const current = this.state.text;
    if (
      (current.status === 'ready' || current.status === 'loading') &&
      current.pageIndex === pageIndex
    ) {
      return;
    }
    this.patch({ text: { status: 'loading', pageIndex } });
    try {
      const model = await this.host.extractPage({ pageIndex });
      if (this.isStalePage(pageIndex)) return this.resetStaleLoading('text', pageIndex);
      this.patch({
        text: { status: 'ready', pageIndex, value: { model, order: buildReadingOrder(model) } },
      });
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        // "Not implemented" is a per-feature fact unrelated to the page, so it is applied even if the user navigated away.
        this.disable('text', failure.message);
        this.logOnce('extract-unavailable', 'extract-unavailable', {
          feature: '텍스트 선택 층·디버그 오버레이',
          reason: failure.message,
        });
        this.patch({ text: { status: 'error', pageIndex, message: failure.message } });
      } else {
        if (this.isStalePage(pageIndex)) return this.resetStaleLoading('text', pageIndex);
        this.host.log('extract-error', { pageIndex, error: failure.message });
        this.patch({ text: { status: 'error', pageIndex, message: failure.message } });
      }
    }
  }

  // ── Debug overlay ────────────────────────────────────────────────────

  toggleDebug(): void {
    if (featureDisabledReason(this.state, 'debug')) return;
    const enabled = !this.state.debugEnabled;
    this.patch({ debugEnabled: enabled });
    if (enabled) {
      const pageIndex = this.state.view?.pageIndex ?? this.state.pageIndex;
      void this.ensureDebug(pageIndex);
    }
  }

  private async ensureDebug(pageIndex: number): Promise<void> {
    if (featureDisabledReason(this.state, 'debug')) return;
    const text = this.state.text;
    if (text.status !== 'ready' || text.pageIndex !== pageIndex) return;
    const current = this.state.debug;
    if (
      (current.status === 'ready' || current.status === 'loading') &&
      current.pageIndex === pageIndex
    ) {
      return;
    }
    this.patch({ debug: { status: 'loading', pageIndex } });
    try {
      // Called in order: the core session caches the page SourceMap and linkPage marks unmatched on that object,
      // so the map received after linkPage carries those marks (SourceMap is created once).
      const linkage = await this.host.linkPage(pageIndex);
      const map = await this.host.getSourceMap(pageIndex);
      if (this.isStalePage(pageIndex)) return this.resetStaleLoading('debug', pageIndex);
      this.patch({ debug: { status: 'ready', pageIndex, value: { linkage, map } } });
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.disable('debug', failure.message);
        this.logOnce('link-unavailable', 'link-unavailable', {
          feature: '디버그 오버레이',
          reason: failure.message,
        });
        this.patch({
          debugEnabled: false,
          debug: { status: 'error', pageIndex, message: failure.message },
        });
      } else {
        if (this.isStalePage(pageIndex)) return this.resetStaleLoading('debug', pageIndex);
        this.host.log('link-error', { pageIndex, error: failure.message });
        this.patch({ debug: { status: 'error', pageIndex, message: failure.message } });
      }
    }
  }

  // ── Layout overlay ───────────────────────────────────────────────────

  /**
   * Turns the layout overlay and the editability overlay on or off together (toolbar "레이아웃·편집 표시"). The unavailable one is left alone.
   * When the editability overlay is on, clicking selects a path (`PathLayer`).
   */
  setOverlays(on: boolean): void {
    const s = overlayToggleState(this.state, this.edit !== null);
    if (s.layoutReason === null && this.state.layoutEnabled !== on) this.toggleLayout();
    if (s.marksReason === null && this.state.edit.showEditable !== on) {
      this.edit?.setShowEditable(on);
    }
  }

  /** Combined button press: if on, turns both off; if off, turns on all available ones. */
  toggleOverlays(): void {
    this.setOverlays(!overlayToggleState(this.state, this.edit !== null).on);
  }

  toggleLayout(): void {
    if (featureDisabledReason(this.state, 'layout')) return;
    const enabled = !this.state.layoutEnabled;
    this.patch({ layoutEnabled: enabled });
    if (enabled) {
      const pageIndex = this.state.view?.pageIndex ?? this.state.pageIndex;
      void this.ensureLayout(pageIndex);
    }
  }

  private async ensureLayout(pageIndex: number): Promise<void> {
    if (featureDisabledReason(this.state, 'layout')) return;
    const current = this.state.layout;
    if (
      (current.status === 'ready' || current.status === 'loading') &&
      current.pageIndex === pageIndex
    ) {
      return;
    }
    this.patch({ layout: { status: 'loading', pageIndex } });
    try {
      const value = await this.host.getPageLayout(pageIndex);
      if (this.isStalePage(pageIndex)) return this.resetStaleLoading('layout', pageIndex);
      this.patch({ layout: { status: 'ready', pageIndex, value } });
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.disable('layout', failure.message);
        this.logOnce('layout-unavailable', 'layout-unavailable', {
          feature: '레이아웃 오버레이',
          reason: failure.message,
        });
        this.patch({
          layoutEnabled: false,
          layout: { status: 'error', pageIndex, message: failure.message },
        });
      } else {
        if (this.isStalePage(pageIndex)) return this.resetStaleLoading('layout', pageIndex);
        this.host.log('layout-error', { pageIndex, error: failure.message });
        this.patch({ layout: { status: 'error', pageIndex, message: failure.message } });
      }
    }
  }

  // ── Search (Ctrl+F) ──────────────────────────────────────────────────

  /** Whether to intercept Ctrl+F. If search becomes unavailable, leaves it to the browser default. */
  shouldInterceptFind(): boolean {
    return this.state.disabled.search === null;
  }

  openFind(): void {
    const find = this.state.find;
    this.patchFind({ ...find, open: true, focusToken: find.focusToken + 1 });
  }

  closeFind(): void {
    this.clearDebounce();
    this.searchPending = false;
    this.searchToken++;
    this.patchFind({ ...clearResults(this.state.find), open: false });
  }

  setFindQuery(query: string): void {
    const find = this.state.find;
    if (query === find.query) return;
    this.clearDebounce();
    this.searchToken++;
    this.patchFind({ ...clearResults(find), query });
    if (query === '') this.searchPending = false;
    if (query === '' || this.state.disabled.search) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, this.options.findDebounceMs ?? DEFAULT_FIND_DEBOUNCE_MS);
  }

  setCaseSensitive(caseSensitive: boolean): void {
    const find = this.state.find;
    if (caseSensitive === find.caseSensitive) return;
    this.clearDebounce();
    this.searchToken++;
    this.patchFind({ ...clearResults(find), caseSensitive });
    if (find.query !== '' && !this.state.disabled.search) void this.runSearch();
  }

  /** Enter (next) / Shift+Enter (previous). If there are no results yet, searches immediately. */
  submitFind(backwards = false): void {
    const find = this.state.find;
    if (find.query === '') return;
    if (this.debounceTimer !== null || find.status !== 'done') {
      this.clearDebounce();
      if (find.status !== 'searching') void this.runSearch();
      return;
    }
    this.stepFind(backwards ? -1 : 1);
  }

  stepFind(delta: number): void {
    const next = stepHit(this.state.find, delta);
    if (next === this.state.find) return;
    this.patchFind(next);
    this.showCurrentHit();
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Runs the search. The Worker handles requests in order, so for requests that arrive before the previous search finishes, only the latest query
   * is held and run after it finishes (so searches do not pile up on the Worker while typing continues).
   */
  private async runSearch(): Promise<void> {
    if (this.state.find.query === '' || this.state.disabled.search) return;
    if (this.searchRunning) {
      this.searchPending = true;
      this.patchFind({ ...this.state.find, status: 'searching', message: null });
      return;
    }
    this.searchRunning = true;
    try {
      await this.searchOnce();
    } finally {
      this.searchRunning = false;
    }
    if (this.searchPending && !this.disposed) {
      this.searchPending = false;
      void this.runSearch();
    }
  }

  private async searchOnce(): Promise<void> {
    const { query, caseSensitive } = this.state.find;
    const token = ++this.searchToken;
    const startPage = this.state.pageIndex;
    this.patchFind({ ...this.state.find, status: 'searching', message: null });
    try {
      const result = await this.host.searchText({ query, caseSensitive, startPage });
      if (this.disposed || token !== this.searchToken) return;
      this.patchFind(applySearchResult(this.state.find, result, startPage));
      this.showCurrentHit();
    } catch (e) {
      if (this.disposed || token !== this.searchToken) return;
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.disable('search', failure.message);
        this.logOnce('search-unavailable', 'search-unavailable', {
          feature: 'Ctrl+F 검색',
          reason: failure.message,
        });
        this.patchFind({
          ...clearResults(this.state.find),
          status: 'unavailable',
          message: this.strings.findUnavailableWith(this.strings.errorDetail(e)),
        });
      } else {
        this.host.log('search-error', { query, error: failure.message });
        this.patchFind({
          ...clearResults(this.state.find),
          status: 'error',
          message: this.strings.findFailedWith(this.strings.errorDetail(e)),
        });
      }
    }
  }

  /** If the current result is on another page, navigates to that page. */
  private showCurrentHit(): void {
    const hit = currentHit(this.state.find);
    if (hit && hit.pageIndex !== this.state.pageIndex) void this.goToPage(hit.pageIndex);
  }

  // ── Component reports ────────────────────────────────────────────────

  /** Used by components to write to the diagnostic log. */
  log(event: string, data?: unknown): void {
    this.host.log(event, data);
  }

  /** Called right after a component draws the bitmap onto the canvas. */
  reportPainted(view: PageView): void {
    const { layout, rendered } = view;
    this.options.onPagePainted?.({
      pageIndex: view.pageIndex,
      pageCount: this.state.pageCount,
      width: rendered.width,
      height: rendered.height,
      cssScale: layout.cssScale,
      devicePixelRatio: layout.devicePixelRatio,
      renderScale: renderScale(layout.cssScale, layout.devicePixelRatio),
      renderMs: rendered.renderMs,
    });
  }
}
