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
  ViewerController,
  featureDisabledReason,
  type ViewerControllerOptions,
} from '../src/controller.js';
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

describe('ViewerController · 페이지 이동과 렌더', () => {
  it('시작하면 첫 페이지를 렌더하고 추출 모델을 불러온다(렌더 배율 = CSS 배율 × dpr)', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    const s = c.getState();
    expect(s.view?.pageIndex).toBe(0);
    expect(s.loading).toBe(false);
    // 가용 폭 1032 → (1032 - 32)/600 > 1.5 → 최대 1.5, dpr 2 → 렌더 배율 3
    expect(host.renderPage).toHaveBeenCalledWith({ pageIndex: 0, scale: 3 });
    expect(s.view?.layout.cssScale).toBe(1.5);
    expect(s.view?.layout.cssWidth).toBe(900); // 비트맵 1800 ÷ dpr 2
    expect(s.text.status).toBe('ready');
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 0 });
  });

  it('다음·이전·입력 이동, 범위 끝에서는 다시 그리지 않는다', async () => {
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

  it('빠르게 연속 이동하면 마지막 요청만 반영한다(느린 이전 응답 무시)', async () => {
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

  it('렌더 실패는 오류로 남기고 로그를 쓰며 예외를 던지지 않는다', async () => {
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

  it('환경 변화(dpr)는 같은 페이지를 새 배율로 다시 그리되 추출은 반복하지 않는다', async () => {
    const host = fakeHost();
    let dpr = 1;
    const c = make(host, {
      getEnvironment: () => ({ devicePixelRatio: dpr, availableWidth: 1032 }),
    });
    await c.start();
    await c.refreshEnvironment();
    expect(host.renderPage).toHaveBeenCalledTimes(1); // 변화 없음
    dpr = 2;
    await c.refreshEnvironment();
    expect(host.renderPage).toHaveBeenLastCalledWith({ pageIndex: 0, scale: 3 });
    expect(c.getState().view?.layout.devicePixelRatio).toBe(2);
    expect(host.extractPage).toHaveBeenCalledTimes(1);
  });

  it('화면 폭이 바뀌면 배율을 다시 맞춘다', async () => {
    const host = fakeHost();
    let width = 532; // (532 - 32)/600 = 0.8333
    const c = make(host, {
      getEnvironment: () => ({ devicePixelRatio: 1, availableWidth: width }),
    });
    await c.start();
    expect(c.getState().view?.layout.cssScale).toBeCloseTo(500 / 600);
    width = 332; // 하한 320 → (332 - 32)/600 = 0.5 보다 320/600
    await c.refreshEnvironment();
    expect(c.getState().view?.layout.cssScale).toBeCloseTo(320 / 600);
  });

  it('reportPainted 는 onPagePainted 에 렌더 정보를 전달한다', async () => {
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

  it('구독자는 상태 변화마다 새 상태를 받고, 해제할 수 있다', async () => {
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

describe('ViewerController · M1 미구현 기능 비활성화', () => {
  it('extractPage 미구현: 텍스트 기능만 끄고 렌더·이동은 계속된다', async () => {
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
    // 이후 페이지에서는 다시 호출하지 않고 로그도 반복하지 않는다.
    await c.nextPage();
    expect(c.getState().view?.pageIndex).toBe(1);
    expect(host.extractPage).toHaveBeenCalledTimes(1);
    expect(host.log).toHaveBeenCalledTimes(1);
    // 디버그 토글은 무시된다.
    c.toggleDebug();
    expect(c.getState().debugEnabled).toBe(false);
  });

  it('그 밖의 추출 오류는 로그만 남기고 다음 페이지에서 다시 시도한다', async () => {
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

  it('검색 미구현: 검색만 끄고 Ctrl+F 가로채기를 중단한다', async () => {
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
      // 다시 입력해도 호출하지 않는다.
      c.setFindQuery('나');
      await vi.advanceTimersByTimeAsync(250);
      expect(host.searchText).toHaveBeenCalledTimes(1);
      // 텍스트 층·렌더는 영향 없음
      expect(s.view?.pageIndex).toBe(0);
      expect(s.text.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('linkPage 미구현: 디버그만 끈다', async () => {
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
    expect(s.text.status).toBe('ready'); // 텍스트 층은 유지
    expect(host.log).toHaveBeenCalledWith('link-unavailable', {
      feature: '디버그 오버레이',
      reason: 'M1 미구현: pdf-ops linkPage',
    });
    c.toggleDebug();
    expect(c.getState().debugEnabled).toBe(false);
  });
});

describe('ViewerController · 디버그 오버레이', () => {
  it('켜면 linkPage 와 getSourceMap 을 불러오고, 페이지 이동 시 새 페이지 데이터를 불러온다', async () => {
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
    c.toggleDebug(); // 끄기
    expect(c.getState().debugEnabled).toBe(false);
    await c.nextPage();
    expect(host.linkPage).toHaveBeenCalledTimes(2);
  });

  it('getSourceMap 은 linkPage 가 끝난 뒤 부른다(세션 캐시 map 의 unmatched 표시를 받기 위해)', async () => {
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

  it('꺼 둔 상태에서는 연동 호출을 하지 않는다', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.start();
    await c.nextPage();
    expect(host.linkPage).not.toHaveBeenCalled();
    expect(host.getSourceMap).not.toHaveBeenCalled();
  });

  it('다른 페이지로 이동한 뒤 늦게 온 추출 응답은 버리고, 돌아오면 다시 불러온다', async () => {
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

describe('ViewerController · 레이아웃 오버레이', () => {
  it('켜면 getPageLayout 을 불러오고 쪽 이동 때 새 쪽을 불러온다. 끄면 부르지 않는다', async () => {
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

  it('쪽을 옮긴 뒤 늦게 온 레이아웃 응답은 버리고, 로딩 중 끄면 그리지 않는다', async () => {
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

  it('미구현 예외면 레이아웃만 비활성화하고 텍스트 층은 그대로 둔다', async () => {
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

describe('ViewerController · 검색', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function started(host = fakeHost()) {
    const c = make(host);
    await c.start();
    return { c, host };
  }

  it('입력 후 디바운스가 지나면 현재 페이지부터 검색하고 첫 결과 페이지로 이동한다', async () => {
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

  it('검색 시작 페이지는 검색 시점의 현재 페이지', async () => {
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

  it('연속 입력은 마지막 질의로 한 번만 검색한다', async () => {
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

  it('질의를 바꾸면 이전 질의의 늦은 응답을 버리고 새 질의 결과만 반영한다', async () => {
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
    // 'a' 응답이 오기 전: 아직 'b' 결과가 없다
    expect(c.getState().find).toMatchObject({ query: 'b', status: 'searching', hits: [] });
    slow.resolve(searchResult('a', [4, 4, 4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find).toMatchObject({ query: 'b', status: 'done' });
    expect(c.getState().find.hits).toHaveLength(1);
    expect(c.getState().view?.pageIndex).toBe(1);
  });

  it('검색이 진행 중일 때 입력이 이어져도 요청이 쌓이지 않고 최신 질의 하나만 이어서 실행한다', async () => {
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
    // 첫 검색이 끝나기 전에는 새 요청을 보내지 않고 "검색 중"으로 표시한다.
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find.status).toBe('searching');
    first.resolve(searchResult('a', [4]));
    await vi.advanceTimersByTimeAsync(0);
    expect(host.searchText).toHaveBeenCalledTimes(2);
    expect(host.searchText.mock.calls[1]![0].query).toBe('abc');
    expect(c.getState().find).toMatchObject({ query: 'abc', status: 'done' });
    expect(c.getState().view?.pageIndex).toBe(2);
  });

  it('진행 중 검색이 있는 동안 창을 닫거나 질의를 지우면 대기 중이던 검색은 실행하지 않는다', async () => {
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

  it('Enter: 결과 없으면 즉시 검색, 있으면 다음 결과로(다른 페이지면 이동), Shift+Enter 는 이전', async () => {
    const host = fakeHost({
      searchText: vi.fn(async (req: SearchRequest) => searchResult(req.query, [0, 2, 2, 4])),
    });
    const { c } = await started(host);
    c.setFindQuery('q');
    c.submitFind(); // 디바운스를 기다리지 않고 즉시 검색
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
    c.submitFind(true); // 1 → 0 → 3 (순환)
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getState().find.current).toBe(3);
    expect(c.getState().view?.pageIndex).toBe(4);
    expect(host.searchText).toHaveBeenCalledTimes(1);
  });

  it('대소문자 옵션을 바꾸면 즉시 다시 검색한다', async () => {
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

  it('빈 질의는 결과를 지우고 검색하지 않는다', async () => {
    const { c, host } = await started();
    c.setFindQuery('q');
    await vi.advanceTimersByTimeAsync(250);
    c.setFindQuery('');
    await vi.advanceTimersByTimeAsync(250);
    expect(host.searchText).toHaveBeenCalledTimes(1);
    expect(c.getState().find).toMatchObject({ query: '', status: 'idle', hits: [], current: -1 });
  });

  it('창을 닫으면 결과·진행 중 검색을 지우고, 열 때 포커스 토큰이 증가한다', async () => {
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

  it('검색 오류는 메시지로 표시하고 로그를 남기되 기능은 유지한다', async () => {
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

  it('결과가 없으면 이동하지 않는다', async () => {
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
