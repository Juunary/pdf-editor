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

/** 창 폭·dpr 을 바꿀 수 있는 가짜 환경. */
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

/** 탭 배율 API 가짜: getZoom 은 현재 값, emit 은 onZoomChange. */
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
    /** 브라우저 배율을 바꾸고 onZoomChange 를 보낸다(프레임 dpr 은 호출자가 따로 바꾼다). */
    zoomTo(f: number) {
      state.zoom = f;
      state.listener?.(f);
    },
  };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('compensatesZoom: 보정 문맥', () => {
  it('탭 최상위 뷰어만 보정하고 임베디드(MIME handler·웹 페이지 안 프레임)는 보정하지 않는다', () => {
    expect(compensatesZoom('mime-handler-top', false)).toBe(true);
    expect(compensatesZoom('mime-handler-embedded', false)).toBe(false);
    expect(compensatesZoom('mime-handler-embedded', true)).toBe(false);
    expect(compensatesZoom('url-param', true)).toBe(true);
    expect(compensatesZoom('url-param', false)).toBe(false);
    expect(compensatesZoom('viewer-page', true)).toBe(true);
  });
});

describe('isNarrow: 100% 환산 폭', () => {
  it('innerWidth × f ≤ 600 이면 좁은 배치', () => {
    expect(NARROW_MAX_WIDTH).toBe(600);
    expect(isNarrow(600, 1)).toBe(true);
    expect(isNarrow(601, 1)).toBe(false);
    // 1000px 창을 200% 로 확대(CSS 폭 500): 좁은 배치가 아니다.
    expect(isNarrow(500, 2)).toBe(false);
    // 400px 창을 50% 로 축소(CSS 폭 800): 좁은 배치다.
    expect(isNarrow(800, 0.5)).toBe(true);
  });
});

describe('HeaderZoom', () => {
  it('시작 직후에는 보정하지 않고(f=1) 좁은 배치만 판정한다', () => {
    const t = fakeEnv(500, 1);
    const hz = new HeaderZoom(t.env);
    expect(t.last()).toEqual({ factor: 1, mode: 'off', narrow: true });
    expect(hz.state.mode).toBe('off');
  });

  it('임베디드: 보정하지 않고 dpr 이 바뀌어도 f=1 이다', async () => {
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

  it('탭 배율로 보정: 시작 배율을 읽고, 좁은 배치는 innerWidth × f 로 판정한다', async () => {
    const t = fakeEnv(500, 2); // 1000px 창, 200%
    const tabs = fakeTabs(2);
    const hz = new HeaderZoom(t.env);
    expect(t.last().narrow).toBe(true); // 문맥을 알기 전(이전 미디어 쿼리와 같다)
    await hz.attach(tabs.api, true);
    expect(tabs.api.subscribe).toHaveBeenCalledTimes(1);
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: false });
    expect(t.logs.find((l) => l.event === 'header-zoom')?.data).toEqual({
      mode: 'tabs',
      factor: 2,
    });
  });

  it('onZoomChange 가 프레임보다 먼저 오면 resize(dpr 변화) 때 적용한다', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    const before = t.applied.length;
    tabs.zoomTo(2); // 프레임 dpr 은 아직 1
    expect(t.applied.length).toBe(before);
    // dpr 이 그대로인 resize(창 폭만 바뀜)에서는 아직 적용하지 않는다.
    hz.onViewportChange();
    expect(t.last().factor).toBe(1);
    t.view.dpr = 2;
    t.view.width = 500;
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: false });
    // 조회 없이 끝난다(이벤트 값이 정확하다).
    expect(tabs.api.getZoom).toHaveBeenCalledTimes(1);
  });

  it('프레임이 먼저 바뀌면(dpr 변화) 같은 비율로 바로 추정하고, 뒤에 온 onZoomChange 는 그대로 둔다', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    tabs.state.zoom = 1.5; // 브라우저 배율은 바뀌었고 이벤트는 아직
    t.view.dpr = 1.5;
    t.view.width = 1000 / 1.5;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    tabs.zoomTo(1.5);
    await flush();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    // 뒤이은 resize 도 그대로다(이중 적용 없음).
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
  });

  it('이벤트가 왔을 때 프레임이 이미 바뀌어 있으면(dpr 변화, resize 전) 바로 적용한다', async () => {
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

  it('dpr 만 바뀐 경우(다른 배율 모니터)는 추정한 뒤 탭 배율 조회로 바로잡는다', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    t.view.dpr = 1.5; // 모니터 배율 150%, 탭 배율은 그대로 1
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.5, 6);
    await flush();
    expect(t.last()).toEqual({ factor: 1, mode: 'tabs', narrow: false });
    expect(t.logs.filter((l) => l.event === 'header-zoom-change')).toHaveLength(2);
  });

  it('조회 응답보다 늦게 시작한 이벤트가 이기면 조회 응답은 버린다', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    let release!: (f: number) => void;
    tabs.api.getZoom.mockImplementationOnce(() => new Promise<number>((r) => (release = r)));
    t.view.dpr = 2;
    hz.onViewportChange(); // 추정 2, 조회 시작
    tabs.zoomTo(1.25); // 더 새로운 값(프레임은 아직 dpr 2)
    t.view.dpr = 1.25;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
    release(2); // 늦게 온 옛 응답
    await flush();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
  });

  it('배경 탭처럼 프레임이 늦게 바뀌면 그때 적용하고, 그 전에 되돌아오면 버린다', async () => {
    const t = fakeEnv(1000, 1);
    const tabs = fakeTabs(1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    tabs.zoomTo(1.1);
    expect(t.last().factor).toBe(1);
    tabs.zoomTo(1); // 프레임이 바뀌기 전에 되돌림
    t.view.dpr = 1.1; // (가정) 늦게 온 dpr 변화는 추정 + 조회로 바로잡는다
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.1, 6);
    await flush();
    expect(t.last().factor).toBe(1);
    // 늦게 바뀌는 경우: 이벤트 → (한참 뒤) dpr 변화 → 그때 이벤트 값
    tabs.zoomTo(1.25);
    t.view.dpr = 1.1 * 1.25;
    hz.onViewportChange();
    expect(t.last().factor).toBeCloseTo(1.25, 6);
  });

  it('창 폭만 바뀌면 배율은 그대로 두고 좁은 배치만 다시 판정한다(조회 없음)', async () => {
    const t = fakeEnv(1000, 2);
    const tabs = fakeTabs(2);
    const hz = new HeaderZoom(t.env);
    await hz.attach(tabs.api, true);
    t.view.width = 250; // 창 500px(100% 환산)
    hz.onViewportChange();
    expect(t.last()).toEqual({ factor: 2, mode: 'tabs', narrow: true });
    expect(tabs.api.getZoom).toHaveBeenCalledTimes(1);
  });

  it('탭 배율을 못 구하면 dpr 변화만으로 추정한다(시작 시 100% 가정)', async () => {
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
    // 탭 배율 이벤트는 쓰지 않는다.
    tabs.zoomTo(3);
    expect(t.last().factor).toBeCloseTo(2, 6);
  });

  it('tabs API 가 없어도 dpr 추정으로 둔다', async () => {
    const t = fakeEnv(1000, 1);
    const hz = new HeaderZoom(t.env);
    await hz.attach(null, true);
    expect(t.last().mode).toBe('dpr');
  });
});

describe('viewerTabId', () => {
  it('MIME handler 는 StreamInfo.tabId, 확장 페이지 탭은 getCurrent(), 모르면 null', async () => {
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
