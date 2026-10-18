/**
 * 선택 하이라이트 사각형(순수 함수). 캐럿 구간 [from, to) 를 줄마다 하나의 CSS 상자로 만든다.
 * 글자마다 블록인 텍스트 층은 브라우저 기본 선택 표시가 줄바꿈 표식과 겹쳐 줄무늬가 지므로,
 * 하이라이트는 이 상자들로 직접 그린다(브라우저 선택은 복사·접근성을 위해 그대로 둔다).
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
    // 줄의 첫 글자 축을 기준으로 선택된 글자 네 꼭짓점을 투영해 상자를 만든다(글자 크기가 섞여도 포함).
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
