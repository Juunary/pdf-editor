/**
 * 텍스트 선택 층 배치(순수 함수). 글자마다 span 하나를 quad 위치에 두고 글자는 투명하게 그린다.
 * DOM 순서 = 읽기 순서(ReadingOrder.items 순서)이며, 줄마다 래퍼를 둬 브라우저 기본 복사에서도
 * 줄바꿈이 들어가게 한다.
 */
import type { PageModel } from '@pdf-editor/shared-types';
import { quadToCssBox, round3, type PageLayout } from './layout.js';
import type { ReadingOrder } from './reading-order.js';

export interface TextLayerChar {
  /** ReadingOrder.items 인덱스. DOM `data-i` 와 같다. */
  item: number;
  charIndex: number;
  text: string;
  style: Record<string, string>;
}

export interface TextLayerLine {
  block: number;
  orphan: boolean;
  chars: TextLayerChar[];
}

/** 글자 가로 길이를 측정한다. 폰트는 텍스트 층의 CSS 폰트와 같아야 한다. */
export type MeasureText = (text: string, fontSizePx: number) => number;

/** 최소 글자 크기(px). 0 에 가까운 값은 브라우저가 배치하지 못한다. */
const MIN_FONT_PX = 1;

export function layoutTextLayer(
  model: PageModel,
  order: ReadingOrder,
  layout: PageLayout,
  measure?: MeasureText,
): TextLayerLine[] {
  const lines: TextLayerLine[] = [];
  for (const line of order.lines) {
    const chars: TextLayerChar[] = [];
    for (let k = line.start; k < line.end; k++) {
      const charIndex = order.items[k]!.charIndex;
      const char = model.chars[charIndex]!;
      const box = quadToCssBox(char.quad, layout.cssScale, layout.origin);
      const fontPx = Math.max(MIN_FONT_PX, round3(char.size * layout.cssScale));
      let scaleX = 1;
      if (measure) {
        const natural = measure(char.text, fontPx);
        if (natural > 0 && box.width > 0)
          scaleX = Math.min(100, Math.max(0.01, box.width / natural));
      }
      const transforms: string[] = [];
      if (box.rotation !== 0) transforms.push(`rotate(${box.rotation}deg)`);
      if (Math.abs(scaleX - 1) > 0.001) transforms.push(`scaleX(${round3(scaleX)})`);
      const style: Record<string, string> = {
        left: `${box.left}px`,
        top: `${box.top}px`,
        fontSize: `${fontPx}px`,
        lineHeight: `${box.height}px`,
      };
      if (transforms.length > 0) style.transform = transforms.join(' ');
      chars.push({ item: k, charIndex, text: char.text, style });
    }
    lines.push({ block: line.block, orphan: line.orphan, chars });
  }
  return lines;
}
