import { describe, expect, it, vi } from 'vitest';
import {
  HeaderZoom,
  NARROW_MAX_WIDTH,
  compensatesZoom,
  isNarrow,
  viewerTabId,
  type HeaderZoomEnv,
  type HeaderZoomState,
  type TabZoomApi,
} from '../src/viewer/header-zoom.js';

/** Fake environment whose window width and dpr can be changed. */
function fakeEnv(width: number, dpr: number) {
  const view = { width, dpr };
  const applied: HeaderZoomState[] = [];
  const logs: { event: string; data: unknown }[] = [];
  const env: HeaderZoomEnv = {
    cssWidth: () => view.width,
    devicePixelRatio: () => view.dpr,
    apply: (s) => applied.push(s),
    log: (event, data) => logs.push({ event, data }),
  };
  return { env, view, applied, logs, last: () => applied.at(-1)! };
}

/** Fake tab zoom API: getZoom returns the current value, emit fires onZoomChange. */
function fakeTabs(initial: number) {
  const state = { zoom: initial, listener: null as ((f: number) => void) | null };
  const api: TabZoomApi & {
    getZoom: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  } = {
    getZoom: vi.fn(async () => state.zoom),
    subscribe: vi.fn((listener: (f: number) => void) => {
      state.listener = listener;
      return () => {
        state.listener = null;
      };
    }),
  };
  return {
    api,
    state,
    /** Changes the browser zoom and sends onZoomChange (the caller changes the frame dpr separately). */
    zoomTo(f: number) {
      state.zoom = f;
      state.listener?.(f);
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('compensatesZoom: compensation context', () => {
  it('compensates only the top-level tab viewer; embedded ones (MIME handler, frame inside a web page) are not compensated', () => {
    expect(compensatesZoom('mime-handler-top', false)).toBe(true);
    expect(compensatesZoom('mime-handler-embedded', false)).toBe(false);
    expect(compensatesZoom('mime-handler-embedded', true)).toBe(false);
    expect(compensatesZoom('url-param', true)).toBe(true);
    expect(compensatesZoom('url-param', false)).toBe(false);
    expect(compensatesZoom('viewer-page', true)).toBe(true);
  });
});

describe('isNarrow: 100%-converted width', () => {
  it('narrow layout when innerWidth × f ≤ 600', () => {
    expect(NARROW_MAX_WIDTH).toBe(600);
    expect(isNarrow(600, 1)).toBe(true);
    expect(isNarrow(601, 1)).toBe(false);
    // Zoom a 1000px window to 200% (CSS width 500): not a narrow layout.
    expect(isNarrow(500, 2)).toBe(false);
    // Shrink a 400px window to 50% (CSS width 800): it is a narrow layout.
    expect(isNarrow(800, 0.5)).toBe(true);
  });
});

describe('HeaderZoom', () => {
  it('right after start it does not compensate (f=1) and only decides the narrow layout', () => {
    const t = fakeEnv(500, 1);
    const hz = new HeaderZoom(t.env);
    expect(t.last()).toEqual({ factor: 1, mode: 'off', narrow: true });
    expect(hz.state.mode).toBe('off');
  });

  it('embedded: no compensation, and f=1 even if dpr changes', async () => {
    const t = fakeEnv(968, 1);
    const tabs = fakeTabs(2);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, false);
    expect(tabs.api.getZoom).not.toHaveBeenCalled();
    t.view.dpr = 2;
    t.view.width = 468;
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 1, mode: 'off', narrow: true });
  });

  it('compensates by tab zoom: reads the starting zoom, and decides the narrow layout by innerWidth × f', async () => {
    const t = fakeEnv(500, 2); // 1000px window, 200%
    const tabs = fakeTabs(2);
    const hz = new HeaderZoom(t.env);
    expect(t.last().narrow).toBe(true); // before the context is known (same as the former media query)
    await hz.attach(tabs.api, true);
    expect(tabs.api.subscribe).toHaveBeenCalledTimes(1);
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: false });
    expect(t.logs.find((l) => l.event === 'header-zoom')?.data).toEqual({
      mode: 'tabs',
      factor: 2,
    });
  });

  it('when onZoomChange arrives before the frame, it is applied on resize (dpr change)', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    const before = t.applied.length;
    tabs.zoomTo(2); // frame dpr is still 1
    expect(t.applied.length).toBe(before);
    // On a resize with unchanged dpr (only the window width changed), it is not applied yet.
    hz.onViewportChange();
    expect(t.last().factor).toBe(1);
    t.view.dpr = 2;
    t.view.width = 500;
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: false });
    // Finishes without a query (the event value is accurate).
    expect(tabs.api.getZoom).toHaveBeenCalledTimes(1);
  });

  it('when the frame changes first (dpr change), estimates right away at the same ratio, and a later onZoomChange is left as is', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    tabs.state.zoom = 1.5; // browser zoom has changed and the event has not arrived yet
    t.view.dpr = 1.5;
    t.view.width = 1000 / 1.5;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    tabs.zoomTo(1.5);
    await flush();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    // A following resize is also unchanged (no double application).
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
  });

  it('when the frame has already changed by the time the event arrives (dpr change, before resize), applies right away', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    t.view.dpr = 0.5;
    t.view.width = 2000;
    tabs.zoomTo(0.5);
    expect(t.last()).toEqual({ factor: 0.5, mode: 'tabs', narrow: false });
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 0.5, mode: 'tabs', narrow: false });
  });

  it('when only dpr changed (monitor with a different scale), estimates and then corrects with the tab zoom query', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    t.view.dpr = 1.5; // monitor scale 150%, tab zoom stays 1
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    await flush();
    expect(t.last()).toEqual({ factor: 1, mode: 'tabs', narrow: false });
    expect(t.logs.filter((l) => l.event === 'header-zoom-change')).toHaveLength(2);
  });

  it('when an event that started later wins over a query response, the query response is discarded', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    let release!: (f: number) => void;
    tabs.api.getZoom.mockImplementationOnce(() => new Promise<number>((r) => (release = r)));
    t.view.dpr = 2;
    hz.onViewportChange(); // estimate 2, query starts
    tabs.zoomTo(1.25); // a newer value (the frame is still at dpr 2)
    t.view.dpr = 1.25;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
    release(2); // the old response arriving late
    await flush();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
  });

  it('when the frame changes late, as in a background tab, applies then, and discards it if it reverts before that', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    tabs.zoomTo(1.1);
    expect(t.last().factor).toBe(1);
    tabs.zoomTo(1); // reverted before the frame changed
    t.view.dpr = 1.1; // (assumption) a late dpr change is estimated and corrected by a query
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.1, 6);
    await flush();
    expect(t.last().factor).toBe(1);
    // When it changes late: event → (long after) dpr change → the event value at that time
    tabs.zoomTo(1.25);
    t.view.dpr = 1.1 * 1.25;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
  });

  it('when only the window width changes, keeps the zoom and re-decides only the narrow layout (no query)', async () => {
    const t = fakeEnv(1000, 2);
    const tabs = fakeTabs(2);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    t.view.width = 250; // window 500px (100%-converted)
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: true });
    expect(tabs.api.getZoom).toHaveBeenCalledTimes(1);
  });

  it('when the tab zoom cannot be obtained, estimates from dpr changes alone (assume 100% at start)', async () => {
    const t = fakeEnv(1000, 1.25);
    const tabs = fakeTabs(1);
    tabs.api.getZoom.mockRejectedValueOnce(new Error('No tab with id'));
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    expect(t.last()).toEqual({ factor: 1, mode: 'dpr', narrow: false });
    expect(t.logs.some((l) => l.event === 'header-zoom-error')).toBe(true);
    t.view.dpr = 2.5;
    t.view.width = 500;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(2, 6);
    expect(t.last().narrow).toBe(false);
    // Tab zoom events are not used.
    tabs.zoomTo(3);
    expect(t.last().factor).toBeCloseTo(2, 6);
  });

  it('falls back to the dpr estimate even without the tabs API', async () => {
    const t = fakeEnv(1000, 1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(null, true);
    expect(t.last().mode).toBe('dpr');
  });
});

describe('viewerTabId', () => {
  it('StreamInfo.tabId for the MIME handler, getCurrent() for an extension-page tab, null if unknown', async () => {
    const getCurrent = vi.fn(async () => ({ id: 42 }));
    expect(await viewerTabId({ tabId: 7 }, getCurrent)).toBe(7);
    expect(getCurrent).not.toHaveBeenCalled();
    expect(await viewerTabId(null, getCurrent)).toBe(42);
    expect(await viewerTabId({ tabId: -1 }, getCurrent)).toBe(42);
    expect(await viewerTabId(null, async () => undefined)).toBeNull();
    expect(
      await viewerTabId(null, async () => {
        throw new Error('x');
      }),
    ).toBeNull();
    expect(await viewerTabId(null, null)).toBeNull();
  });
});
