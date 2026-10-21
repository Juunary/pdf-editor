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
import { RenderCache } from './render-cache.js';
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
  /** 레이아웃 오버레이(M2 getPageLayout: 문단·표·도형·읽기 순서). */
  layoutEnabled: boolean;
  layout: Loadable<DocumentPageLayout>;
  /** 영구 비활성화 사유(없으면 null). */
  disabled: Record<FeatureName, string | null>;
  find: FindState;
  /** 문단 편집(M3) 상태. */
  edit: EditState;
  /** 올릴 때마다 쪽 캔버스를 현재 `view` 의 렌더로 다시 그린다(편집 취소 뒤 복원). */
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
  /** 현재 환경 값을 읽는다(페이지를 그릴 때마다 호출). */
  getEnvironment(): ViewerEnvironment;
  /** pt 폭 → CSS 배율. 기본: 화면 폭 맞춤(`fitWidthScale`). */
  cssScaleFor?(pageWidthPt: number, env: ViewerEnvironment): number;
  /** 검색어 입력 후 검색까지 대기(ms). 기본 200. */
  findDebounceMs?: number;
  /** 컴포넌트가 비트맵을 캔버스에 그린 뒤 호출된다. */
  onPagePainted?(event: PagePaintedEvent): void;
  /** 복구용 편집 로그(D6). 호출자(확장)가 같은 인스턴스를 복구 계층에도 준다. 없으면 내부에서 만든다. */
  editLog?: EditLog;
  /** 시각(ms, performance.now). 테스트에서 주입한다. */
  now?(): number;
  /** 유휴 시 다음 쪽을 미리 렌더한다(기본 true, M5 계약 4.1). */
  prefetch?: boolean;
  /** 유휴 시점에 `fn` 을 실행한다. 기본: `requestIdleCallback`(없으면 `setTimeout`). 테스트에서 주입한다. */
  scheduleIdle?(fn: () => void): void;
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
  /** 편집(M3) 코디네이터. 호스트가 편집 RPC 를 주지 않으면 null. */
  readonly edit: EditController | null;
  readonly editLog: EditLog;
  /** 편집 중에 들어온 창 크기 변화(편집이 끝난 뒤 반영). */
  private envRefreshPending = false;
  /** 쪽 렌더 LRU(8쪽·64 MiB 중 작은 쪽). 문서가 바뀐 쪽은 `invalidatePages` 가 버린다. */
  readonly renderCache = new RenderCache();
  private prefetchRunning = false;

  constructor(private readonly options: ViewerControllerOptions) {
    this.host = options.host;
    this.editLog = options.editLog ?? new EditLog();
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
      // 호스트가 편집 RPC 를 주지 않는 구성(예: 읽기 전용 하니스): 편집 UI 를 만들지 않는다.
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
    // 초안이 있으면 먼저 커밋한다(쪽 이동 중 초안을 잃지 않게). 커밋에 실패해 편집이 계속되면 이동하지 않는다.
    if (this.edit?.active && target !== this.state.pageIndex && !(await this.edit.commitActive())) {
      return;
    }
    if (target !== this.state.pageIndex) this.edit?.paths?.reset();
    const { pageIndex, loading, view } = this.state;
    // 이미 보고 있거나 불러오는 중인 페이지는 다시 그리지 않는다.
    if (target === pageIndex && (loading || view?.pageIndex === target)) return;
    await this.loadView(target);
  }

  /** 창 크기·확대/축소·dpr 변화 후 현재 페이지를 새 배율로 다시 그린다(추출 모델은 재사용). */
  async refreshEnvironment(): Promise<void> {
    const view = this.state.view;
    if (!view || this.state.loading) return;
    if (this.edit?.active) {
      // 편집 중에는 쪽 캔버스를 다시 그리지 않는다(변경 영역 합성 기준 배율 유지). 끝난 뒤 반영한다.
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

  /** 현재 쪽 처리가 끝난 유휴 시점에 다음 쪽을 같은 배율로 미리 렌더한다(1쪽). */
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
      // 미리 렌더는 최선 노력이다. 실패는 실제 이동 때 다시 드러난다.
    } finally {
      this.prefetchRunning = false;
    }
  }

  /** 렌더와 별개로 추출 모델(텍스트 층·디버그)을 불러온다. 실패는 기능 단위로 격리한다. */
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
   * 편집·undo·복구로 쪽 내용이 바뀐 뒤: 현재 쪽이 포함되면 쪽 캐시(추출 모델·레이아웃·편집 판정)를 버리고 다시 그린다.
   * 검색 결과는 옛 위치이므로 지우고, 검색창이 열려 있으면 다시 검색한다.
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

  /** 편집이 끝났을 때 보류했던 환경 변화를 반영한다. */
  private async flushPendingEnvironment(): Promise<void> {
    if (!this.envRefreshPending || this.edit?.active) return;
    this.envRefreshPending = false;
    await this.refreshEnvironment();
  }

  /** 확장이 Worker 를 복구한 뒤 호출한다(편집 코디네이터가 초안 재시작·캐시 정리를 한다). */
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

  /** 편집 코디네이터 호출 뒤 보류한 환경 변화를 반영한다(컴포넌트·확장이 편집 종료 뒤 부른다). */
  async afterEditEnded(): Promise<void> {
    await this.flushPendingEnvironment();
  }

  /** 추출 모델은 배율과 무관하므로, 사용자가 다른 페이지로 옮겼을 때만 응답을 버린다. */
  private isStalePage(pageIndex: number): boolean {
    return this.disposed || this.state.pageIndex !== pageIndex;
  }

  /** 버린 요청이 남긴 loading 표시를 지워, 나중에 같은 페이지로 돌아왔을 때 다시 불러오게 한다. */
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
      // 순서대로 부른다: core 세션은 쪽 SourceMap 을 캐시하고 linkPage 가 그 객체에 unmatched 를 표시하므로,
      // linkPage 뒤에 받은 map 이 그 표시를 담는다(SourceMap 생성 1회).
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

  // ── 레이아웃 오버레이 ────────────────────────────────────────────────

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
