/**
 * Text selection layer layout (pure function). Puts one span per character at the quad position and draws the characters transparent.
 * DOM order = reading order (ReadingOrder.items order), and a wrapper is placed per line so that
 * line breaks are included in the browser's default copy as well.
 */
import type { PageModel } from '@pdf-editor/shared-types';
import { quadToCssBox, round3, type PageLayout } from './layout.js';
import type { ReadingOrder } from './reading-order.js';

export interface TextLayerChar {
  /** ReadingOrder.items index. Same as DOM `data-i`. */
  item: number;
  charIndex: number;
  text: string;
  style: Record<string, string>;
  /**
   * Style for putting the synthetic space after this character (`LineInfo.spaceAfter`) into the DOM. null if none.
   * An auxiliary element that keeps words from running together in the browser's default copy and drag; it is not used for selection ranges or caret decisions.
   */
  space: Record<string, string> | null;
}

export interface TextLayerLine {
  block: number;
  orphan: boolean;
  chars: TextLayerChar[];
}

/** Measures the horizontal length of a character. The font must be the same as the text layer's CSS font. */
export type MeasureText = (text: string, fontSizePx: number) => number;

/** Minimum character size (px). A value close to 0 cannot be laid out by the browser. */
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
        // Placed at the right end of the character (ur of the quad) with no width.
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
