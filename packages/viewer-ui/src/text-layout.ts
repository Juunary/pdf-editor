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
  /**
   * 이 글자 뒤 합성 공백(`LineInfo.spaceAfter`)을 DOM 에 넣을 때의 스타일. 없으면 null.
   * 브라우저 기본 복사·드래그에서도 단어가 붙지 않게 하는 보조 요소이며, 선택 구간·캐럿 판정에는 쓰지 않는다.
   */
  space: Record<string, string> | null;
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
      let space: Record<string, string> | null = null;
      if (order.items[k]!.spaceAfter) {
        // 글자 오른쪽 끝(quad 의 ur)에 폭 없이 둔다.
        const rad = (box.rotation * Math.PI) / 180;
        const spaceStyle: Record<string, string> = {
          left: `${round3(box.left + box.width * Math.cos(rad))}px`,
          top: `${round3(box.top + box.width * Math.sin(rad))}px`,
          fontSize: style.fontSize!,
          lineHeight: style.lineHeight!,
        };
        if (box.rotation !== 0) spaceStyle.transform = `rotate(${box.rotation}deg)`;
        space = spaceStyle;
      }
      chars.push({ item: k, charIndex, text: char.text, style, space });
    }
    lines.push({ block: line.block, orphan: line.orphan, chars });
  }
  return lines;
}
