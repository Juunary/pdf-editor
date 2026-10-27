/**
 * Page space (pt) → CSS layout conversion. Contains only pure functions that do not depend on the DOM.
 *
 * Coordinate system (docs/m1-contract.md section 2): page space has its origin at the top-left, y down, unit pt, and `/Rotate` is already
 * applied. The canvas bitmap is drawn at `cssScale × devicePixelRatio` and shown in CSS at bitmap size ÷ dpr,
 * so overlays always use only the CSS scale (`cssScale`).
 */
import type { Point, Quad, Rect } from '@pdf-editor/shared-types';

/** Rotatable CSS box. `left/top` is the reference point of the top-left (ul of the quad). */
export interface CssBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Degrees, CSS convention (clockwise +). Applied with `transform-origin: 0 0`. */
  rotation: number;
}

/** Round to three decimal places (keeps style strings from getting long). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Converts a quad (MuPDF order ul, ur, ll, lr) to a CSS box.
 * ul → ur is the horizontal direction and ul → ll is the vertical direction. A rotated character is expressed with `rotation`, and width/height
 * are returned at the size before rotation. Skew (shear) is ignored.
 */
export function quadToCssBox(quad: Quad, scale: number, origin: Point = [0, 0]): CssBox {
  const [ulx, uly, urx, ury, llx, lly] = quad;
  const wx = (urx - ulx) * scale;
  const wy = (ury - uly) * scale;
  const hx = (llx - ulx) * scale;
  const hy = (lly - uly) * scale;
  let rotation = (Math.atan2(wy, wx) * 180) / Math.PI;
  if (Math.abs(rotation) < 1e-6) rotation = 0;
  return {
    left: round3((ulx - origin[0]) * scale),
    top: round3((uly - origin[1]) * scale),
    width: round3(Math.hypot(wx, wy)),
    height: round3(Math.hypot(hx, hy)),
    rotation: round3(rotation),
  };
}

/** Converts a `quadToCssBox` result into inline style values. No transform is added if there is no rotation. */
export function cssBoxStyle(box: CssBox, extraTransform = ''): Record<string, string> {
  const transforms = [box.rotation !== 0 ? `rotate(${box.rotation}deg)` : '', extraTransform]
    .filter((t) => t !== '')
    .join(' ');
  const style: Record<string, string> = {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
  };
  if (transforms !== '') style.transform = transforms;
  return style;
}

/** Layout information shared by the page bitmap and the overlays. All lengths are CSS px. */
export interface PageLayout {
  /** pt → CSS px. */
  cssScale: number;
  devicePixelRatio: number;
  /** Top-left of the page bounds (page space). Usually [0, 0]. */
  origin: Point;
  /** Overlay container size = canvas display size (bitmap ÷ dpr). */
  cssWidth: number;
  cssHeight: number;
  /** Bitmap size (device px). */
  bitmapWidth: number;
  bitmapHeight: number;
}

export interface PageLayoutInput {
  /** `PageInfo.bounds` (page space). */
  bounds: Rect;
  cssScale: number;
  devicePixelRatio: number;
  /** Rendered bitmap size (`RenderedPage.width/height`). */
  bitmap: { width: number; height: number };
}

export function pageLayout(input: PageLayoutInput): PageLayout {
  const dpr = input.devicePixelRatio > 0 ? input.devicePixelRatio : 1;
  return {
    cssScale: input.cssScale,
    devicePixelRatio: dpr,
    origin: [input.bounds[0], input.bounds[1]],
    cssWidth: round3(input.bitmap.width / dpr),
    cssHeight: round3(input.bitmap.height / dpr),
    bitmapWidth: input.bitmap.width,
    bitmapHeight: input.bitmap.height,
  };
}

/** Render request scale: the CSS scale multiplied by devicePixelRatio (`RenderRequest.scale`). */
export function renderScale(cssScale: number, devicePixelRatio: number): number {
  return cssScale * (devicePixelRatio > 0 ? devicePixelRatio : 1);
}

export interface FitWidthOptions {
  /** CSS width available to the viewer (e.g. `documentElement.clientWidth`). */
  availableWidth: number;
  pageWidthPt: number;
  /** Sum of the left and right margins (default 32). */
  margin?: number;
  /** Lower bound of the usable width (default 320). */
  minWidth?: number;
  /** Maximum scale (default 1.5). */
  maxScale?: number;
}

/** CSS scale fitted to the screen width. Same rule as M0's `cssScaleFor`. */
export function fitWidthScale(o: FitWidthOptions): number {
  const { availableWidth, pageWidthPt, margin = 32, minWidth = 320, maxScale = 1.5 } = o;
  if (!(pageWidthPt > 0)) return 1;
  return Math.min(maxScale, Math.max(minWidth, availableWidth - margin) / pageWidthPt);
}

/** Container-relative CSS coordinates (px) → page space (pt). */
export function cssToPage(x: number, y: number, layout: PageLayout): Point {
  return [x / layout.cssScale + layout.origin[0], y / layout.cssScale + layout.origin[1]];
}

/** Page space (pt) → container-relative CSS coordinates (px). */
export function pageToCss(p: Point, layout: PageLayout): Point {
  return [(p[0] - layout.origin[0]) * layout.cssScale, (p[1] - layout.origin[1]) * layout.cssScale];
}

/** Coordinate axes of a quad: origin (ul), u (unit vector along ul→ur), v (unit vector along ul→ll), and each length. */
export interface QuadFrame {
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  lu: number;
  lv: number;
}

/** A quad with zero width or height takes the axis perpendicular to the other axis (if both are 0, default horizontal/vertical). */
export function quadFrame(q: Quad): QuadFrame {
  const ux = q[2] - q[0];
  const uy = q[3] - q[1];
  const vx = q[4] - q[0];
  const vy = q[5] - q[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  let unx = 1;
  let uny = 0;
  let vnx = 0;
  let vny = 1;
  if (lu > 0) {
    unx = ux / lu;
    uny = uy / lu;
  } else if (lv > 0) {
    unx = vy / lv;
    uny = 0 - vx / lv; // avoid -0
  }
  if (lv > 0) {
    vnx = vx / lv;
    vny = vy / lv;
  } else if (lu > 0) {
    vnx = 0 - uy / lu;
    vny = ux / lu;
  }
  return { ox: q[0], oy: q[1], ux: unx, uy: uny, vx: vnx, vy: vny, lu, lv };
}

/** Axis-aligned bounding rectangle of a quad (page space). */
export function quadBounds(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Measurement function wrapper that caches results so the same string width is not measured repeatedly. */
export function cachedMeasure(
  measure: (text: string, fontSizePx: number) => number,
): (text: string, fontSizePx: number) => number {
  const cache = new Map<string, number>();
  return (text, fontSizePx) => {
    const key = `${fontSizePx}|${text}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = measure(text, fontSizePx);
      cache.set(key, v);
    }
    return v;
  };
}
