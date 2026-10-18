/**
 * 페이지 공간(pt) → CSS 배치 변환. DOM 에 의존하지 않는 순수 함수만 둔다.
 *
 * 좌표계(docs/m1-contract.md 2절): 페이지 공간은 원점 좌상단, y 아래, 단위 pt 이고 `/Rotate` 가 이미
 * 반영돼 있다. 캔버스 비트맵은 `cssScale × devicePixelRatio` 배율로 그려지고 CSS 로는 비트맵 크기 ÷ dpr 로
 * 표시되므로, 오버레이는 항상 CSS 배율(`cssScale`)만 쓴다.
 */
import type { Point, Quad, Rect } from '@pdf-editor/shared-types';

/** 회전 가능한 CSS 상자. `left/top` 은 좌상단(quad 의 ul) 기준점이다. */
export interface CssBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 도, CSS 기준(시계 방향 +). `transform-origin: 0 0` 에서 적용한다. */
  rotation: number;
}

/** 소수 셋째 자리까지 반올림(스타일 문자열이 길어지는 것을 막는다). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * quad(MuPDF 순서 ul, ur, ll, lr)를 CSS 상자로 바꾼다.
 * ul → ur 가 가로 방향, ul → ll 이 세로 방향이다. 회전된 글자는 `rotation` 으로 표현하고 가로·세로 길이는
 * 회전 전 크기를 돌려준다. 기울임(전단)은 무시한다.
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

/** `quadToCssBox` 결과를 인라인 스타일 값으로 바꾼다. 회전이 없으면 transform 을 넣지 않는다. */
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

/** 페이지 비트맵과 오버레이가 공유하는 배치 정보. 모든 길이는 CSS px. */
export interface PageLayout {
  /** pt → CSS px. */
  cssScale: number;
  devicePixelRatio: number;
  /** 페이지 경계 좌상단(페이지 공간). 보통 [0, 0]. */
  origin: Point;
  /** 오버레이 컨테이너 크기 = 캔버스 표시 크기(비트맵 ÷ dpr). */
  cssWidth: number;
  cssHeight: number;
  /** 비트맵 크기(device px). */
  bitmapWidth: number;
  bitmapHeight: number;
}

export interface PageLayoutInput {
  /** `PageInfo.bounds`(페이지 공간). */
  bounds: Rect;
  cssScale: number;
  devicePixelRatio: number;
  /** 렌더된 비트맵 크기(`RenderedPage.width/height`). */
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

/** 렌더 요청 배율: CSS 배율에 devicePixelRatio 를 곱한다(`RenderRequest.scale`). */
export function renderScale(cssScale: number, devicePixelRatio: number): number {
  return cssScale * (devicePixelRatio > 0 ? devicePixelRatio : 1);
}

export interface FitWidthOptions {
  /** 뷰어가 쓸 수 있는 CSS 폭(예: `documentElement.clientWidth`). */
  availableWidth: number;
  pageWidthPt: number;
  /** 좌우 여백 합(기본 32). */
  margin?: number;
  /** 사용 가능 폭의 하한(기본 320). */
  minWidth?: number;
  /** 최대 배율(기본 1.5). */
  maxScale?: number;
}

/** 화면 폭에 맞춘 CSS 배율. M0 의 `cssScaleFor` 와 같은 규칙이다. */
export function fitWidthScale(o: FitWidthOptions): number {
  const { availableWidth, pageWidthPt, margin = 32, minWidth = 320, maxScale = 1.5 } = o;
  if (!(pageWidthPt > 0)) return 1;
  return Math.min(maxScale, Math.max(minWidth, availableWidth - margin) / pageWidthPt);
}

/** 컨테이너 기준 CSS 좌표(px) → 페이지 공간(pt). */
export function cssToPage(x: number, y: number, layout: PageLayout): Point {
  return [x / layout.cssScale + layout.origin[0], y / layout.cssScale + layout.origin[1]];
}

/** 페이지 공간(pt) → 컨테이너 기준 CSS 좌표(px). */
export function pageToCss(p: Point, layout: PageLayout): Point {
  return [(p[0] - layout.origin[0]) * layout.cssScale, (p[1] - layout.origin[1]) * layout.cssScale];
}

/** quad 의 축 정렬 경계 사각형(페이지 공간). */
export function quadBounds(quad: Quad): Rect {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 같은 문자열 폭을 반복 측정하지 않도록 캐시하는 측정 함수 래퍼. */
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
