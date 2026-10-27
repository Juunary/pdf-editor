/**
 * Selection highlight rectangles (pure function). Builds one CSS box per line for the caret range [from, to).
 * In the text layer, where every character is a block, the browser's default selection rendering overlaps the line-break markers and produces stripes,
 * so the highlight is drawn directly with these boxes (the browser selection is left as is for copying and accessibility).
 */
import type { PageModel, Point } from '@pdf-editor/shared-types';
import { quadFrame, round3, type CssBox } from './layout.js';
import type { ReadingOrder } from './reading-order.js';

export function selectionRects(
  model: PageModel,
  order: ReadingOrder,
  from: number,
  to: number,
  scale: number,
  origin: Point = [0, 0],
): CssBox[] {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(order.items.length, Math.max(from, to));
  const boxes: CssBox[] = [];
  for (const line of order.lines) {
    const start = Math.max(lo, line.start);
    const end = Math.min(hi, line.end);
    if (start >= end) continue;
    // Project the four corners of the selected characters onto the axes of the line's first character to build the box (mixed character sizes are covered too).
    const first = model.chars[order.items[start]!.charIndex]!;
    const f = quadFrame(first.quad);
    let minS = Infinity;
    let maxS = -Infinity;
    let minT = Infinity;
    let maxT = -Infinity;
    for (let k = start; k < end; k++) {
      const q = model.chars[order.items[k]!.charIndex]!.quad;
      for (let c = 0; c < 8; c += 2) {
        const dx = q[c]! - f.ox;
        const dy = q[c + 1]! - f.oy;
        const s = dx * f.ux + dy * f.uy;
        const t = dx * f.vx + dy * f.vy;
        if (s < minS) minS = s;
        if (s > maxS) maxS = s;
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }
    }
    const x = f.ox + f.ux * minS + f.vx * minT;
    const y = f.oy + f.uy * minS + f.vy * minT;
    let rotation = (Math.atan2(f.uy, f.ux) * 180) / Math.PI;
    if (Math.abs(rotation) < 1e-6) rotation = 0;
    boxes.push({
      left: round3((x - origin[0]) * scale),
      top: round3((y - origin[1]) * scale),
      width: round3((maxS - minS) * scale),
      height: round3((maxT - minT) * scale),
      rotation: round3(rotation),
    });
  }
  return boxes;
}
