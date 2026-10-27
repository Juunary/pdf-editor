import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExtractRequest,
  PageInfo,
  PageLinkage,
  PageModel,
  RenderRequest,
  RenderedPage,
  SearchRequest,
  SearchResult,
  PageLayout as DocumentPageLayout,
} from '@pdf-editor/shared-types';
import {
  NO_EDIT_HOST_REASON,
  ViewerController,
  featureDisabledReason,
  overlayToggleState,
  overlayToggleTitle,
  type ViewerControllerOptions,
} from '../src/controller.js';
import { VIEWER_STRINGS } from '../src/strings.js';
import type { ViewerHost } from '../src/viewer-host.js';
import { makeLinkage, makePageModel, makeSourceMap, makeTextOp, rectQuad } from './fixtures.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function pageInfo(pageIndex: number): PageInfo {
  return { pageIndex, bounds: [0, 0, 600, 800], size: { width: 600, height: 800 }, rotation: 0 };
}

function rendered(req: RenderRequest): RenderedPage {
  const width = Math.ceil(600 * req.scale);
  const height = Math.ceil(800 * req.scale);
  return {
    pageIndex: req.pageIndex,
    width,
    height,
    rgba: new Uint8ClampedArray(4),
    renderMs: 3,
    clip: null,
  };
}

function searchResult(query: string, pages: number[]): SearchResult {
  return {
    query,
    hits: pages.map((pageIndex) => ({ pageIndex, quads: [rectQuad(10, 10, 20, 10)] })),
    truncated: false,
    pagesSearched: 5,
    searchMs: 2,
  };
}

type FakeHost = ViewerHost & {
  getPageInfo: ReturnType<typeof vi.fn>;
  renderPage: ReturnType<typeof vi.fn>;
  extractPage: ReturnType<typeof vi.fn>;
  getSourceMap: ReturnType<typeof vi.fn>;
  linkPage: ReturnType<typeof vi.fn>;
  searchText: ReturnType<typeof vi.fn>;
  getPageLayout: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
};

function emptyLayout(pageIndex: number): DocumentPageLayout {
  return {
    pageIndex,
    bounds: [0, 0, 600, 800],
    columns: [],
    paragraphs: [],
    tables: [],
    figures: [],
    readingOrder: [],
    unassignedLines: [],
    warnings: [],
    reconMs: 0,
  };
}

function fakeHost(overrides: Partial<ViewerHost> = {}): FakeHost {
  const model = (pageIndex: number): PageModel => ({
    ...makePageModel(['AB']),
    pageIndex,
  });
  return {
    getPageInfo: vi.fn(async (i: number) => pageInfo(i)),
    renderPage: vi.fn(async (req: RenderRequest) => rendered(req)),
    extractPage: vi.fn(async (req: ExtractRequest) => model(req.pageIndex)),
    getSourceMap: vi.fn(async (i: number) => makeSourceMap(model(i), [makeTextOp(0)])),
    linkPage: vi.fn(async (i: number) => makeLinkage(model(i), [0, 0])),
    searchText: vi.fn(async (req: SearchRequest) => searchResult(req.query, [req.startPage ?? 0])),
    getPageLayout: vi.fn(async (i: number) => emptyLayout(i)),
    log: vi.fn(),
    ...overrides,
  } as FakeHost;
}

function make(host: FakeHost, extra: Partial<ViewerControllerOptions> = {}): ViewerController {
  return new ViewerController({
    host,
    pageCount: 5,
    getEnvironment: () => ({ devicePixelRatio: 2, availableWidth: 1032 }),
    ...extra,
  });
}

describe('ViewerController · page navigation and rendering', () => {
  it('on start, renders the first page and loads the extraction model (render scale = CSS scale × dpr)', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    const s = c.getState();
    expect(s.view?.pageIndex).toBe(0);
    expect(s.loading).toBe(false);
    // Available width 1032 → (1032 - 32)/600 > 1.5 → max 1.5, dpr 2 → render scale 3
    expect(host.renderPage).toHaveBeenCalledWith({ pageIndex: 0, scale: 3 });
    expect(s.view?.layout.cssScale).toBe(1.5);
    expect(s.view?.layout.cssWidth).toBe(900); // bitmap 1800 ÷ dpr 2
    expect(s.text.status).toBe('ready');
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 0 });
  });

  it('next, previous and typed navigation; no redraw at the range ends', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    await c.prevPage();
    expect(host.renderPage).toHaveBeenCalledTimes(1);
    await c.nextPage();
    expect(c.getState().view?.pageIndex).toBe(1);
    expect(c.goToPageInput('5')).toBe(true);
    await flush();
    expect(c.getState().view?.pageIndex).toBe(4);
    await c.nextPage();
    expect(host.renderPage).toHaveBeenCalledTimes(3);
    expect(c.goToPageInput('6')).toBe(false);
    expect(c.goToPageInput('abc')).toBe(false);
    expect(c.getState().pageIndex).toBe(4);
  });

  it('with rapid consecutive navigation, only the last request is applied (slow earlier responses are ignored)', async () => {
    const slow = deferred<RenderedPage>();
    const host = fakeHost({
      renderPage: vi.fn(async (req: RenderRequest) =>
        req.pageIndex === 1 ? slow.promise : rendered(req),
      ),
    });
    const c = make(host);
    await c.start();
    const toOne = c.goToPage(1);
    await flush();
    const toTwo = c.goToPage(2);
    await toTwo;
    slow.resolve(rendered({ pageIndex: 1, scale: 3 }));
    await toOne;
    expect(c.getState().view?.pageIndex).toBe(2);
    expect(c.getState().text).toMatchObject({ status: 'ready', pageIndex: 2 });
  });

  it('a render failure is kept as an error and logged, and no exception is thrown', async () => {
    const host = fakeHost({
      renderPage: vi.fn(async () => {
        throw new Error('렌더 불가');
      }),
    });
    const c = make(host);
    await expect(c.start()).resolves.toBeUndefined();
    expect(c.getState().renderError).toBe('렌더 불가');
    expect(c.getState().loading).toBe(false);
    expect(host.log).toHaveBeenCalledWith('render-error', { pageIndex: 0, error: '렌더 불가' });
  });

  it('an environment change (dpr) redraws the same page at the new scale without repeating extraction', async () => {
    const host = fakeHost();
    let dpr = 1;
    const c = make(host, {
      getEnvironment: () => ({ devicePixelRatio: dpr, availableWidth: 1032 }),
    });
    await c.start();
    await c.refreshEnvironment();
    expect(host.renderPage).toHaveBeenCalledTimes(1); // no change
    dpr = 2;
    await c.refreshEnvironment();
    expect(host.renderPage).toHaveBeenLastCalledWith({ pageIndex: 0, scale: 3 });
    expect(c.getState().view?.layout.devicePixelRatio).toBe(2);
    expect(host.extractPage).toHaveBeenCalledTimes(1);
  });

  it('when the screen width changes, the scale is refitted', async () => {
    const host = fakeHost();
    let width = 532; // (532 - 32)/600 = 0.8333
    const c = make(host, {
      getEnvironment: () => ({ devicePixelRatio: 1, availableWidth: width }),
    });
    await c.start();
    expect(c.getState().view?.layout.cssScale).toBeCloseTo(500 / 600);
    width = 332; // lower limit 320 → 320/600 rather than (332 - 32)/600 = 0.5
    await c.refreshEnvironment();
    expect(c.getState().view?.layout.cssScale).toBeCloseTo(320 / 600);
  });

  it('reportPainted passes the render info to onPagePainted', async () => {
    const onPagePainted = vi.fn();
    const c = make(fakeHost(), { onPagePainted });
    await c.start();
    c.reportPainted(c.getState().view!);
    expect(onPagePainted).toHaveBeenCalledWith({
      pageIndex: 0,
      pageCount: 5,
      width: 1800,
      height: 2400,
      cssScale: 1.5,
      devicePixelRatio: 2,
      renderScale: 3,
      renderMs: 3,
    });
  });

  it('subscribers receive the new state on every state change, and can unsubscribe', async () => {
    const c = make(fakeHost());
    const seen: number[] = [];
    const off = c.subscribe((s) => seen.push(s.pageIndex));
    await c.start();
    off();
    const n = seen.length;
    await c.nextPage();
    expect(seen.length).toBe(n);
    expect(n).toBeGreaterThan(0);
  });
});

describe('ViewerController · disabling unimplemented M1 features', () => {
  it('extractPage unimplemented: turns off only text features, and rendering and navigation continue', async () => {
    const host = fakeHost({
      extractPage: vi.fn(async () => {
        throw new Error('M1 미구현: core extractPage');
      }),
    });
    const c = make(host);
    await c.start();
    expect(c.getState().view?.pageIndex).toBe(0);
    expect(c.getState().disabled.text).toBe('M1 미구현: core extractPage');
    expect(featureDisabledReason(c.getState(), 'debug')).toContain('PageModel 없음');
    expect(host.log).toHaveBeenCalledTimes(1);
    expect(host.log).toHaveBeenCalledWith('extract-unavailable', {
      feature: '텍스트 선택 층·디버그 오버레이',
      reason: 'M1 미구현: core extractPage',
    });
    // It is not called again on later pages, and the log is not repeated either.
    await c.nextPage();
    expect(c.getState().view?.pageIndex).toBe(1);
    expect(host.extractPage).toHaveBeenCalledTimes(1);
    expect(host.log).toHaveBeenCalledTimes(1);
    // The debug toggle is ignored.
    c.toggleDebug();
    expect(c.getState().debugEnabled).toBe(false);
  });

  it('any other extraction error only logs and is retried on the next page', async () => {
    let calls = 0;
    const host = fakeHost({
      extractPage: vi.fn(async (req: ExtractRequest) => {
        calls++;
        if (calls === 1) throw new Error('메모리 부족');
        return { ...makePageModel(['AB']), pageIndex: req.pageIndex };
      }),
    });
    const c = make(host);
    await c.start();
    expect(c.getState().text).toMatchObject({ status: 'error', message: '메모리 부족' });
    expect(c.getState().disabled.text).toBeNull();
    expect(host.log).toHaveBeenCalledWith('extract-error', { pageIndex: 0, error: '메모리 부족' });
    await c.nextPage();
    expect(c.getState().text.status).toBe('ready');
  });

  it('search unimplemented: turns off only search and stops intercepting Ctrl+F', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost({
        searchText: vi.fn(async () => {
          throw new Error('M1 미구현: core searchText');
        }),
      });
      const c = make(host);
      await c.start();
      expect(c.shouldInterceptFind()).toBe(true);
      c.openFind();
      c.setFindQuery('가');
      await vi.advanceTimersByTimeAsync(250);
      const s = c.getState();
      expect(s.find.status).toBe('unavailable');
      expect(s.find.message).toContain('M1 미구현: core searchText');
      expect(s.disabled.search).toBe('M1 미구현: core searchText');
      expect(c.shouldInterceptFind()).toBe(false);
      expect(host.log).toHaveBeenCalledWith('search-unavailable', {
        feature: 'Ctrl+F 검색',
        reason: 'M1 미구현: core searchText',
      });
      // Typing again does not call it.
      c.setFindQuery('나');
      await vi.advanceTimersByTimeAsync(250);
      expect(host.searchText).toHaveBeenCalledTimes(1);
      // The text layer and rendering are unaffected
      expect(s.view?.pageIndex).toBe(0);
      expect(s.text.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('English string table: the search-unimplemented text is in English (user request 2026-10-23)', async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost({
        searchText: vi.fn(async () => {
          throw new Error('M1 미구현: core searchText');
        }),
      });
      const c = make(host, { strings: VIEWER_STRINGS.en });
      expect(c.strings).toBe(VIEWER_STRINGS.en);
      expect(make(fakeHost()).strings).toBe(VIEWER_STRINGS.ko);
      await c.start();
      c.openFind();
      c.setFindQuery('a');
      await vi.advanceTimersByTimeAsync(250);
      expect(c.getState().find.message).toBe(
        'Search is not available (not implemented in this build)',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('linkPage unimplemented: turns off only debug', async () => {
    const host = fakeHost({
      linkPage: vi.fn(async () => {
        throw new Error('M1 미구현: pdf-ops linkPage');
      }),
    });
    const c = make(host);
    await c.start();
    c.toggleDebug();
    expect(c.getState().debugEnabled).toBe(true);
    await flush();
    const s = c.getState();
    expect(s.debugEnabled).toBe(false);
    expect(s.disabled.debug).toBe('M1 미구현: pdf-ops linkPage');
    expect(s.text.status).toBe('ready'); // the text layer is kept
    expect(host.log).toHaveBeenCalledWith('link-unavailable', {
      feature: '디버그 오버레이',
      reason: 'M1 미구현: pdf-ops linkPage',
    });
    c.toggleDebug();
    expect(c.getState().debugEnabled).toBe(false);
  });
});

describe('ViewerController · debug overlay', () => {
  it('when turned on, loads linkPage and getSourceMap, and loads the new page data on page navigation', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    c.toggleDebug();
    await flush();
    expect(c.getState().debug).toMatchObject({ status: 'ready', pageIndex: 0 });
    expect(host.linkPage).toHaveBeenCalledWith(0);
    expect(host.getSourceMap).toHaveBeenCalledWith(0);
    await c.nextPage();
    expect(c.getState().debug).toMatchObject({ status: 'ready', pageIndex: 1 });
    c.toggleDebug(); // turn off
    expect(c.getState().debugEnabled).toBe(false);
    await c.nextPage();
    expect(host.linkPage).toHaveBeenCalledTimes(2);
  });

  it('getSourceMap is called after linkPage finishes (to receive the unmatched marks of the session-cached map)', async () => {
    const link = deferred<PageLinkage>();
    const host = fakeHost({ linkPage: vi.fn(() => link.promise) });
    const c = make(host);
    await c.start();
    c.toggleDebug();
    await flush();
    expect(host.linkPage).toHaveBeenCalledWith(0);
    expect(host.getSourceMap).not.toHaveBeenCalled();
    link.resolve(makeLinkage(makePageModel(['AB']), [0, 0]));
    await flush();
    expect(host.getSourceMap).toHaveBeenCalledTimes(1);
    expect(c.getState().debug).toMatchObject({ status: 'ready', pageIndex: 0 });
  });

  it('while turned off, no linkage calls are made', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    await c.nextPage();
    expect(host.linkPage).not.toHaveBeenCalled();
    expect(host.getSourceMap).not.toHaveBeenCalled();
  });

  it('an extraction response that arrives late after moving to another page is discarded, and loaded again when coming back', async () => {
    const slow = deferred<PageModel>();
    let first = true;
    const host = fakeHost({
      extractPage: vi.fn(async (req: ExtractRequest) => {
        if (req.pageIndex === 0 && first) {
          first = false;
          return slow.promise;
        }
        return { ...makePageModel(['AB']), pageIndex: req.pageIndex };
      }),
    });
    const c = make(host);
    const starting = c.start();
    await flush();
    await c.goToPage(1);
    expect(c.getState().text).toMatchObject({ status: 'ready', pageIndex: 1 });
    slow.resolve({ ...makePageModel(['AB']), pageIndex: 0 });
    await starting;
    expect(c.getState().text).toMatchObject({ status: 'ready', pageIndex: 1 });
    await c.goToPage(0);
    expect(c.getState().text).toMatchObject({ status: 'ready', pageIndex: 0 });
  });
});

describe('ViewerController · layout overlay', () => {
  it('when turned on, loads getPageLayout and loads the new page on page navigation. When turned off, it does not call it', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    expect(host.getPageLayout).not.toHaveBeenCalled();
    c.toggleLayout();
    await flush();
    expect(c.getState().layout).toMatchObject({ status: 'ready', pageIndex: 0 });
    await c.nextPage();
    expect(c.getState().layout).toMatchObject({ status: 'ready', pageIndex: 1 });
    c.toggleLayout();
    await c.nextPage();
    expect(host.getPageLayout).toHaveBeenCalledTimes(2);
  });

  it('a layout response that arrives late after changing pages is discarded, and nothing is drawn if turned off while loading', async () => {
    const slow = deferred<DocumentPageLayout>();
    let first = true;
    const host = fakeHost({
      getPageLayout: vi.fn((i: number) => {
        if (first) {
          first = false;
          return slow.promise;
        }
        return Promise.resolve(emptyLayout(i));
      }),
    });
    const c = make(host);
    await c.start();
    c.toggleLayout();
    await flush();
    await c.nextPage();
    expect(c.getState().layout).toMatchObject({ status: 'ready', pageIndex: 1 });
    slow.resolve(emptyLayout(0));
    await flush();
    expect(c.getState().layout).toMatchObject({ status: 'ready', pageIndex: 1 });
    c.toggleLayout();
    expect(c.getState().layoutEnabled).toBe(false);
  });

  it('an unimplemented exception disables only the layout and leaves the text layer as is', async () => {
    const host = fakeHost({
      getPageLayout: vi.fn(async () => {
        throw new Error('M2 미구현: core getPageLayout');
      }),
    });
    const c = make(host);
    await c.start();
    c.toggleLayout();
    await flush();
    const s = c.getState();
    expect(s.layoutEnabled).toBe(false);
    expect(s.disabled.layout).not.toBeNull();
    expect(s.text.status).toBe('ready');
    c.toggleLayout();
    expect(c.getState().layoutEnabled).toBe(false);
  });
});

describe('ViewerController · layout and edit overlay buttons (user request 2026-10-22)', () => {
  it('a host without edit RPCs turns the layout on and off only, and writes the editability overlay reason in the title', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    expect(c.edit).toBeNull();
    c.toggleOverlays();
    expect(c.getState().layoutEnabled).toBe(true);
    await flush();
    expect(host.getPageLayout).toHaveBeenCalledWith(0);
    const s = overlayToggleState(c.getState(), false);
    expect(s).toEqual({ on: true, layoutReason: null, marksReason: NO_EDIT_HOST_REASON });
    expect(overlayToggleTitle(s, false)).toContain(
      `편집 가능 표시를 쓸 수 없어 레이아웃만 켭니다: ${NO_EDIT_HOST_REASON}`,
    );
    c.toggleOverlays();
    expect(c.getState().layoutEnabled).toBe(false);
    expect(overlayToggleState(c.getState(), false).on).toBe(false);
    // English string table (user request 2026-10-23)
    const en = VIEWER_STRINGS.en;
    const sEn = overlayToggleState(c.getState(), false, en);
    expect(sEn.marksReason).toBe(en.noEditHost);
    expect(overlayToggleTitle(sEn, false, en)).toBe(
      `${en.overlayIntro}\n${en.overlayLayoutOnly(en.noEditHost)}`,
    );
  });

  it('if neither can be used, they are not turned on and the title lists both reasons', async () => {
    const host = fakeHost({
      getPageLayout: vi.fn(async () => {
        throw new Error('M2 미구현: core getPageLayout');
      }),
    });
    const c = make(host);
    await c.start();
    c.toggleOverlays();
    await flush();
    const s = overlayToggleState(c.getState(), false);
    expect(s.on).toBe(false);
    expect(s.layoutReason).toContain('미구현');
    const title = overlayToggleTitle(s, false);
    expect(title).toContain('레이아웃: M2 미구현');
    expect(title).toContain(`편집 가능 표시: ${NO_EDIT_HOST_REASON}`);
    c.toggleOverlays();
    expect(c.getState().layoutEnabled).toBe(false);
  });
});

describe('ViewerController · search', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function started(host = fakeHost()) {
    const c = make(host);
    await c.start();
    return { c, host };
  }

  it('after the debounce following input, searches from the current page and moves to the first result page', async () => {
    const host = fakeHost({
      searchText: vi.fn(async (req: SearchRequest) => searchResult(req.query, [3, 3, 0])),
    });
    const { c } = await started(host);
    c.openFind();
    c.setFindQuery('가나');
    expect(host.searchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(199);
    expect(host.searchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(host.searchText).toHaveBeenCalledWith({
      query: '가나',
      caseSensitive: false,
      startPage: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    const s = c.getState();
    expect(s.find).toMatchObject({ status: 'done', current: 0 });
    expect(s.view?.pageIndex).toBe(3);
  });

  it('the search start page is the current page at search time', async () => {
    const { c, host } = await started();
    await c.goToPage(2);
    c.setFindQuery('x');
    await vi.advanceTimersByTimeAsync(250);
    expect(host.searchText).toHaveBeenCalledWith({
      query: 'x',
      caseSensitive: false,
      startPage: 2,
    });
  });

  it('consecutive input searches only once with the last query', async () => {
    const { c, host } = await started();
    c.setFindQuery('a');
    await vi.advanceTimersByTimeAsync(100);
    c.setFindQuery('ab');
    await vi.advanceTimersByTimeAsync(100);
    c.setFindQuery('abc');
    await vi.advanceTimersByTimeAsync(250);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(host.searchText.mock.calls[0]![0].query).toBe('abc');
  });

  it('changing the query discards the late response of the previous query and applies only the new query result', async () => {
    const slow = deferred<SearchResult>();
    const host = fakeHost({
      searchText: vi.fn((req: SearchRequest) =>
        req.query === 'a' ? slow.promise : Promise.resolve(searchResult(req.query, [1])),
      ),
    });
    const { c } = await started(host);
    c.setFindQuery('a');
    await vi.advanceTimersByTimeAsync(250);
    expect(c.getState().find.status).toBe('searching');
    c.setFindQuery('b');
    await vi.advanceTimersByTimeAsync(250);
    // Before the response for 'a' arrives: there is no result for 'b' yet
    expect(c.getState().find).toMatchObject({ query: 'b', status: 'searching', hits: [] });
    slow.resolve(searchResult('a', [4, 4, 4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find).toMatchObject({ query: 'b', status: 'done' });
    expect(c.getState().find.hits).toHaveLength(1);
    expect(c.getState().view?.pageIndex).toBe(1);
  });

  it('even if input continues while a search is in progress, requests do not pile up and only the latest query runs next', async () => {
    const first = deferred<SearchResult>();
    const host = fakeHost({
      searchText: vi.fn((req: SearchRequest) =>
        req.query === 'a' ? first.promise : Promise.resolve(searchResult(req.query, [2])),
      ),
    });
    const { c } = await started(host);
    c.setFindQuery('a');
    await vi.advanceTimersByTimeAsync(250);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    c.setFindQuery('ab');
    await vi.advanceTimersByTimeAsync(250);
    c.setFindQuery('abc');
    await vi.advanceTimersByTimeAsync(250);
    // Before the first search finishes, no new request is sent and "검색 중" is shown.
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find.status).toBe('searching');
    first.resolve(searchResult('a', [4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.searchText).toHaveBeenCalledTimes(2);
    expect(host.searchText.mock.calls[1]![0].query).toBe('abc');
    expect(c.getState().find).toMatchObject({ query: 'abc', status: 'done' });
    expect(c.getState().view?.pageIndex).toBe(2);
  });

  it('while a search is in progress, closing the window or clearing the query does not run the pending search', async () => {
    const first = deferred<SearchResult>();
    const host = fakeHost({
      searchText: vi.fn((req: SearchRequest) =>
        req.query === 'a' ? first.promise : Promise.resolve(searchResult(req.query, [1])),
      ),
    });
    const { c } = await started(host);
    c.setFindQuery('a');
    await vi.advanceTimersByTimeAsync(250);
    c.setFindQuery('ab');
    await vi.advanceTimersByTimeAsync(250);
    c.closeFind();
    first.resolve(searchResult('a', [4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find).toMatchObject({ open: false, status: 'idle', hits: [] });
  });

  it('Enter: searches immediately if there are no results, otherwise goes to the next result (moves if on another page), Shift+Enter goes to the previous', async () => {
    const host = fakeHost({
      searchText: vi.fn(async (req: SearchRequest) => searchResult(req.query, [0, 2, 2, 4])),
    });
    const { c } = await started(host);
    c.setFindQuery('q');
    c.submitFind(); // searches immediately without waiting for the debounce
    await vi.advanceTimersByTimeAsync(0);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find.current).toBe(0);
    c.submitFind();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find.current).toBe(1);
    expect(c.getState().view?.pageIndex).toBe(2);
    c.submitFind();
    expect(c.getState().find.current).toBe(2);
    expect(c.getState().view?.pageIndex).toBe(2);
    c.submitFind(true);
    c.submitFind(true);
    c.submitFind(true); // 1 → 0 → 3 (wraps around)
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find.current).toBe(3);
    expect(c.getState().view?.pageIndex).toBe(4);
    expect(host.searchText).toHaveBeenCalledTimes(1);
  });

  it('changing the case option searches again immediately', async () => {
    const { c, host } = await started();
    c.setFindQuery('Abc');
    await vi.advanceTimersByTimeAsync(250);
    c.setCaseSensitive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.searchText).toHaveBeenLastCalledWith({
      query: 'Abc',
      caseSensitive: true,
      startPage: 0,
    });
  });

  it('an empty query clears the results and does not search', async () => {
    const { c, host } = await started();
    c.setFindQuery('q');
    await vi.advanceTimersByTimeAsync(250);
    c.setFindQuery('');
    await vi.advanceTimersByTimeAsync(250);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find).toMatchObject({ query: '', status: 'idle', hits: [], current: -1 });
  });

  it('closing the window clears the results and any search in progress, and the focus token increments when opening', async () => {
    const slow = deferred<SearchResult>();
    const host = fakeHost({ searchText: vi.fn(() => slow.promise) });
    const { c } = await started(host);
    c.openFind();
    const t1 = c.getState().find.focusToken;
    c.openFind();
    expect(c.getState().find.focusToken).toBe(t1 + 1);
    c.setFindQuery('q');
    await vi.advanceTimersByTimeAsync(250);
    c.closeFind();
    slow.resolve(searchResult('q', [3]));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find).toMatchObject({ open: false, hits: [], status: 'idle', query: 'q' });
    expect(c.getState().view?.pageIndex).toBe(0);
  });

  it('a search error is shown as a message and logged, but the feature stays on', async () => {
    const host = fakeHost({
      searchText: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    const { c } = await started(host);
    c.setFindQuery('q');
    await vi.advanceTimersByTimeAsync(250);
    expect(c.getState().find).toMatchObject({ status: 'error', message: '검색 실패: timeout' });
    expect(c.shouldInterceptFind()).toBe(true);
    expect(host.log).toHaveBeenCalledWith('search-error', { query: 'q', error: 'timeout' });
  });

  it('does not navigate if there are no results', async () => {
    const host = fakeHost({
      searchText: vi.fn(async (req: SearchRequest) => searchResult(req.query, [])),
    });
    const { c } = await started(host);
    c.setFindQuery('없음');
    await vi.advanceTimersByTimeAsync(250);
    expect(c.getState().find).toMatchObject({ status: 'done', current: -1 });
    c.submitFind();
    expect(c.getState().view?.pageIndex).toBe(0);
  });
});
