/**
 * 머리 영역(툴바·알림 줄·검색창·저장 메뉴) 확대 보정(사용자 요청 2026-10-22).
 *
 * 브라우저 확대·축소(Ctrl +/−, Ctrl+휠, 메뉴)로 탭 배율 f 가 바뀌어도 머리 영역의 화면상 크기·배치를 100% 때와 같게
 * 둔다. 문서 영역은 지금처럼 확대·축소된다.
 *
 * - f 는 `chrome.tabs.getZoom(tabId)` 와 `chrome.tabs.onZoomChange` 로 얻는다(권한 불필요). tabId 는 MIME handler 면
 *   `StreamInfo.tabId`, 확장 페이지 탭이면 `chrome.tabs.getCurrent()`.
 * - 머리 영역에 CSS `zoom: 1/f` 를 준다(`--pe-header-zoom`). 좁은 배치는 100% 환산 폭(innerWidth × f)으로 판정한다.
 * - 보조: devicePixelRatio 변화를 확대 변화로 보고 즉시 추정한 뒤 탭 배율 조회로 확인한다. onZoomChange 는 프레임이
 *   새 배율로 바뀌기 전에 올 수 있어(MIME handler 최상위 실측), 프레임의 dpr 이 바뀐 뒤(resize)에 적용한다. 배경 탭처럼
 *   프레임이 늦게 바뀌어도 그때 적용한다. 탭 배율을 못 구하면 dpr 변화만으로 추정한다(시작 시 100% 가정).
 * - 임베디드 문맥(embed·iframe·object)은 보정하지 않는다: 바깥 페이지 확대를 따른다(docs/m5-release.md 10.1).
 */
import type { ViewerContextKind } from './source.js';

/** 좁은 배치 경계(100% 환산 CSS px). 이전 `@media (max-width: 600px)` 와 같은 값. */
export const NARROW_MAX_WIDTH = 600;
const EPS = 1e-3;

/**
 * 보정할 문맥인지. 탭의 최상위 뷰어만 보정한다: MIME handler 최상위(PDF URL 페이지의 하위 프레임이지만 탭 전체를
 * 차지한다), 탭 최상위에 연 확장 페이지(`?file=`·파일 선택). DNR 폴백으로 웹 페이지 안 프레임에 뜬 확장 페이지는
 * 임베디드로 본다.
 */
export function compensatesZoom(kind: ViewerContextKind, isTopFrame: boolean): boolean {
  if (kind === 'mime-handler-top') return true;
  if (kind === 'mime-handler-embedded') return false;
  return isTopFrame;
}

/** 100% 환산 폭이 경계 이하이면 좁은 배치. */
export function isNarrow(cssWidth: number, factor: number): boolean {
  return cssWidth * factor <= NARROW_MAX_WIDTH;
}

const validFactor = (f: unknown): f is number => typeof f === 'number' && f > 0 && isFinite(f);

export type HeaderZoomMode = 'off' | 'tabs' | 'dpr';

export interface HeaderZoomState {
  /** 머리 영역 보정에 쓰는 탭 확대 배율(보정하지 않으면 1). 머리 영역 CSS zoom 은 1/factor. */
  factor: number;
  /** off: 보정 안 함(시작 전·임베디드), tabs: 탭 배율, dpr: dpr 변화로 추정(탭 배율을 못 구함). */
  mode: HeaderZoomMode;
  narrow: boolean;
}

/** 탭 확대 배율 API(`chrome.tabs`) 중 이 모듈이 쓰는 부분. */
export interface TabZoomApi {
  getZoom(): Promise<number>;
  /** 이 탭의 배율 변화를 구독한다. 반환 함수로 해제한다. */
  subscribe(listener: (factor: number) => void): () => void;
}

export interface HeaderZoomEnv {
  /** 창 CSS 폭(`innerWidth`). */
  cssWidth(): number;
  devicePixelRatio(): number;
  /** 상태를 DOM 에 반영한다(CSS 변수·`data-narrow`). */
  apply(state: HeaderZoomState): void;
  log(event: string, data: unknown): void;
}

export class HeaderZoom {
  private mode: HeaderZoomMode = 'off';
  private factor = 1;
  /** 마지막으로 적용할 때의 dpr. 이후 dpr 이 바뀌면 프레임이 새 배율로 바뀐 것이다. */
  private appliedDpr: number;
  /** 프레임보다 먼저 온 onZoomChange 배율(프레임 dpr 이 바뀔 때 적용). */
  private pending: number | null = null;
  /** 탭 배율 조회 순번(늦게 온 응답 버리기). */
  private seq = 0;
  private api: TabZoomApi | null = null;
  private unsubscribe: (() => void) | null = null;
  private last: HeaderZoomState | null = null;

  constructor(private readonly env: HeaderZoomEnv) {
    this.appliedDpr = env.devicePixelRatio();
    this.apply();
  }

  get state(): HeaderZoomState {
    return {
      factor: this.factor,
      mode: this.mode,
      narrow: isNarrow(this.env.cssWidth(), this.factor),
    };
  }

  /**
   * 문맥을 안 뒤 부른다. 보정 문맥이면 탭 배율을 읽어 적용하고 변화를 구독한다. 탭 배율을 못 구하면 dpr 추정으로 둔다.
   */
  async attach(api: TabZoomApi | null, compensate: boolean): Promise<void> {
    this.detach();
    if (!compensate) {
      this.mode = 'off';
      this.factor = 1;
      this.env.log('header-zoom', { mode: 'off', reason: 'embedded' });
      this.apply();
      return;
    }
    if (api) {
      const seq = ++this.seq;
      try {
        const f = await api.getZoom();
        if (seq !== this.seq) return;
        if (validFactor(f)) {
          this.api = api;
          this.mode = 'tabs';
          this.factor = f;
          this.appliedDpr = this.env.devicePixelRatio();
          this.unsubscribe = api.subscribe((next) => this.onZoomEvent(next));
          this.env.log('header-zoom', { mode: 'tabs', factor: f });
          this.apply();
          return;
        }
        this.env.log('header-zoom-error', `getZoom 값 이상: ${String(f)}`);
      } catch (e) {
        this.env.log('header-zoom-error', String(e));
      }
    }
    // 보조 경로: 시작 시 배율을 100% 로 보고 이후 dpr 변화를 확대 변화로 본다.
    this.mode = 'dpr';
    this.factor = 1;
    this.appliedDpr = this.env.devicePixelRatio();
    this.env.log('header-zoom', { mode: 'dpr' });
    this.apply();
  }

  /** 창 크기·dpr 변화(resize, `matchMedia(resolution)`)에서 동기로 부른다. */
  onViewportChange(): void {
    const dpr = this.env.devicePixelRatio();
    if (Math.abs(dpr - this.appliedDpr) > EPS) {
      if (this.pending !== null) {
        // 먼저 온 onZoomChange 값을 프레임이 바뀐 지금 적용한다.
        this.factor = this.pending;
        this.pending = null;
      } else if (this.mode !== 'off') {
        // dpr 변화는 확대 변화로 보고 같은 비율로 바로 추정한다(그 프레임에 바로 맞춘다). 다른 배율 모니터로 창을
        // 옮긴 경우 등은 탭 배율 조회가 바로잡는다.
        this.factor *= dpr / this.appliedDpr;
        if (this.mode === 'tabs') void this.confirm();
      }
      this.appliedDpr = dpr;
    }
    this.apply();
  }

  /** onZoomChange(이 탭). */
  onZoomEvent(f: number): void {
    if (this.mode !== 'tabs' || !validFactor(f)) return;
    this.seq++; // 진행 중인 조회 응답보다 이 값이 새롭다
    this.pending = null;
    if (Math.abs(f - this.factor) < EPS) return;
    const dpr = this.env.devicePixelRatio();
    if (Math.abs(dpr - this.appliedDpr) > EPS) {
      // 프레임은 이미 새 배율이다(resize 처리 전).
      this.factor = f;
      this.appliedDpr = dpr;
      this.apply();
      return;
    }
    // 프레임이 아직 새 배율로 바뀌지 않았다(이벤트가 먼저 왔거나 배경 탭): dpr 이 바뀔 때 적용한다.
    this.pending = f;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.api = null;
    this.pending = null;
    this.seq++;
  }

  private async confirm(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const seq = ++this.seq;
    try {
      const f = await api.getZoom();
      if (seq !== this.seq || this.mode !== 'tabs' || !validFactor(f)) return;
      if (Math.abs(f - this.factor) < EPS) return;
      this.factor = f;
      this.appliedDpr = this.env.devicePixelRatio();
      this.apply();
    } catch (e) {
      this.env.log('header-zoom-error', String(e));
    }
  }

  private apply(): void {
    const state = this.state;
    const prev = this.last;
    this.last = state;
    this.env.apply(state);
    if (prev && (Math.abs(prev.factor - state.factor) > EPS || prev.narrow !== state.narrow)) {
      this.env.log('header-zoom-change', state);
    }
  }
}

/** dpr 변화(확대, 다른 배율 모니터로 이동)를 알린다. resize 없이 dpr 만 바뀌는 경우를 위해 둔다. */
export function watchDevicePixelRatio(win: Window, onChange: () => void): () => void {
  let mq: MediaQueryList | null = null;
  const fire = () => {
    onChange();
    arm();
  };
  const arm = () => {
    mq = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    mq.addEventListener('change', fire, { once: true });
  };
  arm();
  return () => mq?.removeEventListener('change', fire);
}

/** `chrome.tabs` 로 만든 탭 배율 API. tabs API 가 없으면 null. */
export function chromeTabZoom(tabId: number): TabZoomApi | null {
  const tabs = typeof chrome === 'object' ? chrome.tabs : undefined;
  if (typeof tabs?.getZoom !== 'function' || !tabs.onZoomChange) return null;
  return {
    getZoom: () => tabs.getZoom(tabId),
    subscribe: (listener) => {
      const handler = (info: chrome.tabs.OnZoomChangeInfo) => {
        if (info.tabId === tabId) listener(info.newZoomFactor);
      };
      tabs.onZoomChange.addListener(handler);
      return () => tabs.onZoomChange.removeListener(handler);
    },
  };
}

/** 뷰어가 있는 탭 id: MIME handler 는 StreamInfo.tabId, 확장 페이지 탭은 getCurrent(). 모르면 null. */
export async function viewerTabId(
  streamInfo: { tabId: number } | null,
  getCurrent: (() => Promise<{ id?: number } | undefined>) | null,
): Promise<number | null> {
  if (streamInfo && streamInfo.tabId >= 0) return streamInfo.tabId;
  try {
    const id = (await getCurrent?.())?.id;
    return typeof id === 'number' && id >= 0 ? id : null;
  } catch {
    return null;
  }
}
