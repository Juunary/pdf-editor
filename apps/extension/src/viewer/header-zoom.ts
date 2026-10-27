/**
 * Header area (toolbar, notice row, search box, save menu) zoom compensation (user request 2026-10-22).
 *
 * Even when the tab zoom factor f changes through browser zoom in/out (Ctrl +/−, Ctrl+wheel, menu), the header's on-screen size and layout stay the same as at 100%.
 * The document area zooms in/out as before.
 *
 * - f is obtained via `chrome.tabs.getZoom(tabId)` and `chrome.tabs.onZoomChange` (no permission needed). tabId is
 *   `StreamInfo.tabId` for the MIME handler, and `chrome.tabs.getCurrent()` for an extension-page tab.
 * - The header gets CSS `zoom: 1/f` (`--pe-header-zoom`). The narrow layout is decided by the width converted to 100% (innerWidth × f).
 * - Auxiliary: a devicePixelRatio change is treated as a zoom change and estimated immediately, then confirmed by querying the tab zoom. onZoomChange can arrive before the frame
 *   switches to the new zoom (measured for the top-level MIME handler), so it is applied after the frame's dpr has changed (resize). Even when the frame
 *   changes late, as in a background tab, it is applied then. If the tab zoom cannot be obtained, estimate from dpr changes alone (assume 100% at start).
 * - Embedded contexts (embed, iframe, object) are not compensated: they follow the outer page's zoom (docs/m5-release.md 10.1).
 */
import type { ViewerContextKind } from './source.js';

/** Narrow layout boundary (100%-converted CSS px). Same value as the former `@media (max-width: 600px)`. */
export const NARROW_MAX_WIDTH = 600;
const EPS = 1e-3;

/**
 * Whether this is a context to compensate. Only the top-level viewer of a tab is compensated: the top-level MIME handler (a child frame of the PDF URL page, but it
 * occupies the whole tab) and an extension page opened at the tab top level (`?file=`, file selection). An extension page shown in a frame inside a web page via the DNR fallback
 * is treated as embedded.
 */
export function compensatesZoom(kind: ViewerContextKind, isTopFrame: boolean): boolean {
  if (kind === 'mime-handler-top') return true;
  if (kind === 'mime-handler-embedded') return false;
  return isTopFrame;
}

/** Narrow layout if the 100%-converted width is at or below the boundary. */
export function isNarrow(cssWidth: number, factor: number): boolean {
  return cssWidth * factor <= NARROW_MAX_WIDTH;
}

const validFactor = (f: unknown): f is number => typeof f === 'number' && f > 0 && isFinite(f);

export type HeaderZoomMode = 'off' | 'tabs' | 'dpr';

export interface HeaderZoomState {
  /** Tab zoom factor used for header compensation (1 if not compensating). The header CSS zoom is 1/factor. */
  factor: number;
  /** off: no compensation (before start, embedded); tabs: tab zoom; dpr: estimated from dpr changes (tab zoom unavailable). */
  mode: HeaderZoomMode;
  narrow: boolean;
}

/** The part of the tab zoom API (`chrome.tabs`) used by this module. */
export interface TabZoomApi {
  getZoom(): Promise<number>;
  /** Subscribes to zoom changes of this tab. Unsubscribe with the returned function. */
  subscribe(listener: (factor: number) => void): () => void;
}

export interface HeaderZoomEnv {
  /** Window CSS width (`innerWidth`). */
  cssWidth(): number;
  devicePixelRatio(): number;
  /** Reflects the state in the DOM (CSS variable, `data-narrow`). */
  apply(state: HeaderZoomState): void;
  log(event: string, data: unknown): void;
}

export class HeaderZoom {
  private mode: HeaderZoomMode = 'off';
  private factor = 1;
  /** dpr at the last apply. If dpr changes afterwards, the frame has switched to the new zoom. */
  private appliedDpr: number;
  /** onZoomChange zoom that arrived before the frame (applied when the frame's dpr changes). */
  private pending: number | null = null;
  /** Tab zoom query sequence number (to discard late responses). */
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
   * Called once the context is known. In a compensated context, reads and applies the tab zoom and subscribes to changes. If the tab zoom cannot be obtained, falls back to the dpr estimate.
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
    // Auxiliary path: assume 100% zoom at start and treat later dpr changes as zoom changes.
    this.mode = 'dpr';
    this.factor = 1;
    this.appliedDpr = this.env.devicePixelRatio();
    this.env.log('header-zoom', { mode: 'dpr' });
    this.apply();
  }

  /** Called synchronously on window size / dpr changes (resize, `matchMedia(resolution)`). */
  onViewportChange(): void {
    const dpr = this.env.devicePixelRatio();
    if (Math.abs(dpr - this.appliedDpr) > EPS) {
      if (this.pending !== null) {
        // Apply the onZoomChange value that arrived earlier, now that the frame has changed.
        this.factor = this.pending;
        this.pending = null;
      } else if (this.mode !== 'off') {
        // Treat a dpr change as a zoom change and estimate right away at the same ratio (fits that frame immediately). Cases such as moving the window
        // to a monitor with a different scale are corrected by the tab zoom query.
        this.factor *= dpr / this.appliedDpr;
        if (this.mode === 'tabs') void this.confirm();
      }
      this.appliedDpr = dpr;
    }
    this.apply();
  }

  /** onZoomChange (this tab). */
  onZoomEvent(f: number): void {
    if (this.mode !== 'tabs' || !validFactor(f)) return;
    this.seq++; // this value is newer than any in-flight query response
    this.pending = null;
    if (Math.abs(f - this.factor) < EPS) return;
    const dpr = this.env.devicePixelRatio();
    if (Math.abs(dpr - this.appliedDpr) > EPS) {
      // The frame already has the new zoom (before resize handling).
      this.factor = f;
      this.appliedDpr = dpr;
      this.apply();
      return;
    }
    // The frame has not yet switched to the new zoom (the event came first, or a background tab): apply when dpr changes.
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

/** Reports a dpr change (zoom, or moving to a monitor with a different scale). Exists for cases where only dpr changes without a resize. */
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

/** Tab zoom API built from `chrome.tabs`. null if the tabs API is missing. */
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

/** Tab id where the viewer lives: StreamInfo.tabId for the MIME handler, getCurrent() for an extension-page tab. null if unknown. */
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
