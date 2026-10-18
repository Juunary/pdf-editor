/**
 * 뷰어 상태 컨트롤러. 페이지 이동·렌더·추출 모델·검색·디버그 연동을 비동기로 조율한다.
 *
 * - DOM 에 의존하지 않는다(캔버스 그리기와 이벤트는 컴포넌트 몫). 가짜 `ViewerHost` 로 Node 에서 테스트한다.
 * - 기능별 실패 격리: extractPage·searchText·linkPage 가 "M1 미구현" 예외를 내면 그 기능만 비활성화하고
 *   진단 로그(`host.log`)에 남긴다. 렌더·페이지 이동은 계속 동작한다.
 * - 느린 응답이 최신 상태를 덮지 않도록 요청마다 토큰으로 오래된 응답을 버린다.
 */
import type {
  PageInfo,
  PageLinkage,
  PageModel,
  RenderedPage,
  SourceMap,
} from '@pdf-editor/shared-types';
import { classifyFailure } from './failure.js';
import { fitWidthScale, pageLayout, renderScale, type PageLayout } from './layout.js';
import { clampPage, parsePageInput, stepPage } from './page-nav.js';
import { buildReadingOrder, type ReadingOrder } from './reading-order.js';
import {
  applySearchResult,
  clearResults,
  currentHit,
  initialFindState,
  stepHit,
  type FindState,
} from './search-nav.js';
import type { ViewerEnvironment, ViewerHost } from './viewer-host.js';

export type FeatureName = 'text' | 'search' | 'debug';

/** 렌더가 끝난 현재 페이지. 오버레이 배치의 기준이다. */
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
  /** 이동을 요청한 페이지(렌더 완료 전일 수 있다). 렌더된 페이지는 view.pageIndex. */
  pageIndex: number;
  loading: boolean;
  renderError: string | null;
  view: PageView | null;
  text: Loadable<TextData>;
  debugEnabled: boolean;
  debug: Loadable<DebugData>;
  /** 영구 비활성화 사유(없으면 null). */
  disabled: Record<FeatureName, string | null>;
  find: FindState;
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
  /** 현재 환경 값을 읽는다(페이지를 그릴 때마다 호출). */
  getEnvironment(): ViewerEnvironment;
  /** pt 폭 → CSS 배율. 기본: 화면 폭 맞춤(`fitWidthScale`). */
  cssScaleFor?(pageWidthPt: number, env: ViewerEnvironment): number;
  /** 검색어 입력 후 검색까지 대기(ms). 기본 200. */
  findDebounceMs?: number;
  /** 컴포넌트가 비트맵을 캔버스에 그린 뒤 호출된다. */
  onPagePainted?(event: PagePaintedEvent): void;
}

export type StateListener = (state: ViewerState) => void;

const DEFAULT_FIND_DEBOUNCE_MS = 200;
/** 환경 변화로 다시 그릴 최소 배율 차이(비율). */
const RESCALE_THRESHOLD = 0.005;

/** 기능을 쓸 수 없는 사유. 쓸 수 있으면 null. 디버그는 PageModel 이 필요하다. */
export function featureDisabledReason(state: ViewerState, feature: FeatureName): string | null {
  const own = state.disabled[feature];
  if (own) return own;
  if (feature === 'debug' && state.disabled.text) return `PageModel 없음: ${state.disabled.text}`;
  return null;
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

  constructor(private readonly options: ViewerControllerOptions) {
    this.host = options.host;
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
      disabled: { text: null, search: null, debug: null },
      find: initialFindState(),
    };
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

  /** 같은 종류의 로그는 한 번만 남긴다(페이지마다 반복되는 "미구현" 로그 방지). */
  private logOnce(kind: string, event: string, data: unknown): void {
    if (this.loggedKinds.has(kind)) return;
    this.loggedKinds.add(kind);
    this.host.log(event, data);
  }

  // ── 페이지 이동 · 렌더 ────────────────────────────────────────────────

  start(): Promise<void> {
    return this.goToPage(this.state.pageIndex);
  }

  nextPage(): Promise<void> {
    return this.goToPage(stepPage(this.state.pageIndex, 1, this.state.pageCount));
  }

  prevPage(): Promise<void> {
    return this.goToPage(stepPage(this.state.pageIndex, -1, this.state.pageCount));
  }

  /** 입력창 문자열(1부터)로 이동. 유효하지 않으면 false 를 돌려주고 이동하지 않는다. */
  goToPageInput(text: string): boolean {
    const index = parsePageInput(text, this.state.pageCount);
    if (index === null) return false;
    void this.goToPage(index);
    return true;
  }

  async goToPage(index: number): Promise<void> {
    const target = clampPage(index, this.state.pageCount);
    const { pageIndex, loading, view } = this.state;
    // 이미 보고 있거나 불러오는 중인 페이지는 다시 그리지 않는다.
    if (target === pageIndex && (loading || view?.pageIndex === target)) return;
    await this.loadView(target);
  }

  /** 창 크기·확대/축소·dpr 변화 후 현재 페이지를 새 배율로 다시 그린다(추출 모델은 재사용). */
  async refreshEnvironment(): Promise<void> {
    const view = this.state.view;
    if (!view || this.state.loading) return;
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
      const rendered = await this.host.renderPage({
        pageIndex: target,
        scale: renderScale(cssScale, env.devicePixelRatio),
      });
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
  }

  /** 렌더와 별개로 추출 모델(텍스트 층·디버그)을 불러온다. 실패는 기능 단위로 격리한다. */
  private async loadPageData(pageIndex: number): Promise<void> {
    await this.ensureText(pageIndex);
    if (this.state.debugEnabled) await this.ensureDebug(pageIndex);
  }

  /** 추출 모델은 배율과 무관하므로, 사용자가 다른 페이지로 옮겼을 때만 응답을 버린다. */
  private isStalePage(pageIndex: number): boolean {
    return this.disposed || this.state.pageIndex !== pageIndex;
  }

  /** 버린 요청이 남긴 loading 표시를 지워, 나중에 같은 페이지로 돌아왔을 때 다시 불러오게 한다. */
  private resetStaleLoading(kind: 'text' | 'debug', pageIndex: number): void {
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
        // 미구현은 페이지와 무관한 기능 단위 사실이므로 이동했더라도 반영한다.
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

  // ── 디버그 오버레이 ──────────────────────────────────────────────────

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
      const [linkage, map] = await Promise.all([
        this.host.linkPage(pageIndex),
        this.host.getSourceMap(pageIndex),
      ]);
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

  // ── 검색(Ctrl+F) ─────────────────────────────────────────────────────

  /** Ctrl+F 를 가로챌지. 검색을 쓸 수 없게 되면 브라우저 기본 동작에 맡긴다. */
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

  /** Enter(다음) / Shift+Enter(이전). 결과가 아직 없으면 즉시 검색한다. */
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
   * 검색 실행. Worker 는 요청을 순서대로 처리하므로, 이전 검색이 끝나기 전에 온 요청은 최신 질의 하나만
   * 대기시키고 끝난 뒤 이어서 실행한다(입력이 이어질 때 검색이 Worker 에 쌓이지 않게).
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
          message: `검색을 사용할 수 없습니다 (${failure.message})`,
        });
      } else {
        this.host.log('search-error', { query, error: failure.message });
        this.patchFind({
          ...clearResults(this.state.find),
          status: 'error',
          message: `검색 실패: ${failure.message}`,
        });
      }
    }
  }

  /** 현재 결과가 다른 페이지에 있으면 그 페이지로 이동한다. */
  private showCurrentHit(): void {
    const hit = currentHit(this.state.find);
    if (hit && hit.pageIndex !== this.state.pageIndex) void this.goToPage(hit.pageIndex);
  }

  // ── 컴포넌트 보고 ────────────────────────────────────────────────────

  /** 컴포넌트가 진단 로그에 남길 때 쓴다. */
  log(event: string, data?: unknown): void {
    this.host.log(event, data);
  }

  /** 컴포넌트가 비트맵을 캔버스에 그린 직후 호출한다. */
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
