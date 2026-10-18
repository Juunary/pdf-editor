import { cachedMeasure } from './layout.js';
import type { MeasureText } from './text-layout.js';

/** 텍스트 층 글자 폰트. CSS 와 측정이 같은 값을 쓰도록 한 곳에 둔다. */
export const TEXT_LAYER_FONT = "system-ui, 'Malgun Gothic', 'Noto Sans CJK KR', sans-serif";

let shared: MeasureText | null | undefined;

/** canvas measureText 로 글자 폭을 재는 함수(캐시 포함). 2d 컨텍스트가 없으면 null. */
export function canvasMeasure(): MeasureText | null {
  if (shared !== undefined) return shared;
  const ctx = document.createElement('canvas').getContext('2d');
  shared = ctx
    ? cachedMeasure((text, fontSizePx) => {
        ctx.font = `${fontSizePx}px ${TEXT_LAYER_FONT}`;
        return ctx.measureText(text).width;
      })
    : null;
  return shared;
}
