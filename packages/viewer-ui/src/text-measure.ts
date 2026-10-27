import { cachedMeasure } from './layout.js';
import type { MeasureText } from './text-layout.js';

/** Text-layer character font. Kept in one place so CSS and measurement use the same value. */
export const TEXT_LAYER_FONT = "system-ui, 'Malgun Gothic', 'Noto Sans CJK KR', sans-serif";

let shared: MeasureText | null | undefined;

/** Function that measures character width with canvas measureText (with cache). null if there is no 2d context. */
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
