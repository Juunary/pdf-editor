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
  it('9번째 쪽을 담으면 가장 오래 쓰지 않은 쪽을 버린다(8쪽 상한)', () => {
    const cache = new RenderCache();
    for (let i = 0; i < 8; i++) cache.put(i, 1, page(i, 16));
    expect(cache.get(0, 1)).not.toBeNull(); // 0 을 최근 사용으로 올린다
    cache.put(8, 1, page(8, 16));
    expect(cache.size).toBe(8);
    expect(cache.has(1, 1)).toBe(false);
    expect(cache.has(0, 1)).toBe(true);
  });

  it('바이트 상한(64 MiB)에 먼저 걸리면 쪽 수가 8 미만이어도 버린다', () => {
    const cache = new RenderCache({ maxPages: 8, maxBytes: 100 });
    cache.put(0, 1, page(0, 40));
    cache.put(1, 1, page(1, 40));
    cache.put(2, 1, page(2, 40));
    expect(cache.size).toBe(2);
    expect(cache.byteSize).toBe(80);
    expect(cache.has(0, 1)).toBe(false);
  });

  it('상한보다 큰 비트맵과 부분 영역 렌더는 담지 않는다', () => {
    const cache = new RenderCache({ maxPages: 8, maxBytes: 100 });
    cache.put(0, 1, page(0, 200));
    cache.put(1, 1, page(1, 16, [0, 0, 1, 1]));
    expect(cache.size).toBe(0);
  });

  it('무효화는 그 쪽의 모든 배율을 버리고, 이전 epoch 의 늦은 렌더는 담지 않는다', () => {
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

describe('ViewerController · 렌더 캐시', () => {
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

  it('다시 방문한 쪽은 렌더를 다시 부르지 않는다', async () => {
    const host = fakeHost();
    const c = make(host, false);
    await c.goToPage(0);
    await c.goToPage(1);
    await c.goToPage(0);
    expect(host.renderPage).toHaveBeenCalledTimes(2);
    expect(c.getState().view?.pageIndex).toBe(0);
  });

  it('유휴 시 다음 쪽을 미리 렌더하고, 그 쪽으로 이동하면 렌더를 부르지 않는다', async () => {
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

  it('쪽이 바뀌었다고 알리면 그 쪽만 다시 렌더한다', async () => {
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
});
