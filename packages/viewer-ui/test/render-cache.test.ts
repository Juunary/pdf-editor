import { describe, expect, it, vi } from 'vitest';
import type { PageInfo, RenderRequest, RenderedPage } from '@pdf-editor/shared-types';
import { ViewerController } from '../src/controller.js';
import { RenderCache } from '../src/render-cache.js';
import type { ViewerHost } from '../src/viewer-host.js';

function page(pageIndex: number, bytes: number, clip: RenderedPage['clip'] = null): RenderedPage {
  return {
    pageIndex,
    width: 1,
    height: bytes / 4,
    rgba: new Uint8ClampedArray(bytes),
    renderMs: 1,
    clip,
  };
}

describe('RenderCache', () => {
  it('storing the 9th page discards the least recently used page (8-page limit)', () => {
    const cache = new RenderCache();
    for (let i = 0; i < 8; i++) cache.put(i, 1, page(i, 16));
    expect(cache.get(0, 1)).not.toBeNull(); // bump 0 to most recently used
    cache.put(8, 1, page(8, 16));
    expect(cache.size).toBe(8);
    expect(cache.has(1, 1)).toBe(false);
    expect(cache.has(0, 1)).toBe(true);
  });

  it('if the byte limit (64 MiB) is hit first, pages are discarded even when the page count is below 8', () => {
    const cache = new RenderCache({ maxPages: 8, maxBytes: 100 });
    cache.put(0, 1, page(0, 40));
    cache.put(1, 1, page(1, 40));
    cache.put(2, 1, page(2, 40));
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);
    expect(cache.has(0, 1)).toBe(false);
  });

  it('bitmaps larger than the limit and partial-region renders are not stored', () => {
    const cache = new RenderCache({ maxPages: 8, maxBytes: 100 });
    cache.put(0, 1, page(0, 200));
    cache.put(1, 1, page(1, 16, [0, 0, 1, 1]));
    expect(cache.size).toBe(0);
  });

  it('invalidation discards all scales of that page, and a late render from a previous epoch is not stored', () => {
    const cache = new RenderCache();
    cache.put(3, 1, page(3, 16));
    cache.put(3, 2, page(3, 16));
    cache.put(4, 1, page(4, 16));
    const epoch = cache.epoch;
    cache.invalidate([3]);
    expect(cache.has(3, 1)).toBe(false);
    expect(cache.has(3, 2)).toBe(false);
    expect(cache.has(4, 1)).toBe(true);
    expect(cache.byteSize).toBe(16);
    cache.put(3, 1, page(3, 16), epoch);
    expect(cache.has(3, 1)).toBe(false);
  });
});

function fakeHost() {
  const info = (i: number): PageInfo => ({
    pageIndex: i,
    bounds: [0, 0, 600, 800],
    size: { width: 600, height: 800 },
    rotation: 0,
  });
  return {
    getPageInfo: vi.fn(async (i: number) => info(i)),
    renderPage: vi.fn(async (req: RenderRequest) => page(req.pageIndex, 16)),
    extractPage: vi.fn(async () => {
      throw new Error('M1 미구현: extractPage');
    }),
    getSourceMap: vi.fn(),
    linkPage: vi.fn(),
    searchText: vi.fn(),
    getPageLayout: vi.fn(),
    log: vi.fn(),
  } as unknown as ViewerHost & { renderPage: ReturnType<typeof vi.fn> };
}

describe('ViewerController · render cache', () => {
  const idle: Array<() => void> = [];
  const make = (host: ReturnType<typeof fakeHost>, prefetch = true) =>
    new ViewerController({
      host,
      pageCount: 5,
      getEnvironment: () => ({ devicePixelRatio: 1, availableWidth: 600 }),
      prefetch,
      scheduleIdle: (fn) => idle.push(fn),
    });
  const runIdle = async () => {
    for (const fn of idle.splice(0)) fn();
    await vi.waitFor(() => undefined);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it('a revisited page does not call render again', async () => {
    const host = fakeHost();
    const c = make(host, false);
    await c.goToPage(0);
    await c.goToPage(1);
    await c.goToPage(0);
    expect(host.renderPage).toHaveBeenCalledTimes(2);
    expect(c.getState().view?.pageIndex).toBe(0);
  });

  it('when idle, pre-renders the next page, and moving to that page does not call render', async () => {
    const host = fakeHost();
    const c = make(host);
    await c.goToPage(0);
    expect(host.renderPage).toHaveBeenCalledTimes(1);
    await runIdle();
    expect(host.renderPage).toHaveBeenCalledTimes(2);
    expect((host.renderPage.mock.calls[1] as [RenderRequest])[0].pageIndex).toBe(1);
    await c.goToPage(1);
    expect(host.renderPage).toHaveBeenCalledTimes(2);
  });

  it('when notified that a page changed, only that page is re-rendered', async () => {
    const host = fakeHost();
    const c = make(host, false);
    await c.goToPage(0);
    await c.goToPage(1);
    await c.invalidatePages([0]);
    await c.goToPage(0);
    await c.goToPage(1);
    expect(host.renderPage.mock.calls.map((a) => (a[0] as RenderRequest).pageIndex)).toEqual([
      0, 1, 0,
    ]);
  });
  it('after Worker recovery, all pages are re-rendered in the new Worker (the first full render of a new session reserves the document stats)', async () => {
    const host = fakeHost();
    const c = make(host, false);
    await c.goToPage(0);
    await c.goToPage(1);
    await c.handleWorkerRecovered();
    await c.goToPage(0);
    expect(host.renderPage.mock.calls.map((a) => (a[0] as RenderRequest).pageIndex)).toEqual([
      0, 1, 1, 0,
    ]);
  });

  it('if the page changes during pre-rendering (edit commit, undo), the stale render that arrives is not put in the cache', async () => {
    const host = fakeHost();
    let release!: () => void;
    const c = make(host);
    await c.goToPage(0);
    host.renderPage.mockImplementationOnce(
      (req: RenderRequest) =>
        new Promise((resolve) => {
          release = () => resolve(page(req.pageIndex, 16));
        }),
    );
    for (const fn of idle.splice(0)) fn();
    await vi.waitFor(() => expect(host.renderPage).toHaveBeenCalledTimes(2));
    await c.invalidatePages([1]);
    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await c.goToPage(1);
    expect(host.renderPage.mock.calls.map((a) => (a[0] as RenderRequest).pageIndex)).toEqual([
      0, 1, 1,
    ]);
  });
});
