import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import type { TextLine } from '@pdf-editor/pdf-ops';

/**
 * Minimal paragraph layout for the spike. The real reflow is packages/reflow (M3).
 * - advance is quantized to 1/1000 em to match the PDF /W.
 * - Line breaks at whitespace (words); a word longer than a line is broken per character.
 * - If the area is exceeded, it is reported as overflow instead of being clipped (no automatic clipping).
 */

export interface PlacedGlyph {
  gid: number;
  unicode: number;
  /** Baseline origin in PDF user space */
  x: number;
  y: number;
}

export interface ParagraphLayout {
  lines: TextLine[];
  glyphs: PlacedGlyph[];
  lineCount: number;
  overflow: boolean;
  /** Used height (pt) */
  usedHeight: number;
}

export interface LayoutParams {
  font: mupdf.Font;
  text: string;
  fontSize: number;
  /** Line spacing (multiplier) */
  lineHeight: number;
  /** Baseline start position = ascent below the top of the area */
  ascent: number;
  /** Area in PDF user space [x0, y0, x1, y1] (y up) */
  box: Rect;
}

const quantize = (adv: number) => Math.round(adv * 1000) / 1000;

export function layoutParagraph(p: LayoutParams): ParagraphLayout {
  const [bx0, by0, bx1, by1] = p.box;
  const maxWidth = bx1 - bx0;
  const lead = p.fontSize * p.lineHeight;
  const glyphOf = (ch: string) => {
    const unicode = ch.codePointAt(0)!;
    const gid = p.font.encodeCharacter(unicode);
    return { gid, unicode, adv: quantize(p.font.advanceGlyph(gid, 0)) * p.fontSize };
  };

  // Split into words (tokens including whitespace).
  const tokens = p.text.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: { glyphs: ReturnType<typeof glyphOf>[]; width: number }[] = [
    { glyphs: [], width: 0 },
  ];
  const current = () => lines[lines.length - 1]!;
  for (const token of tokens) {
    const glyphs = [...token].map(glyphOf);
    const isSpace = /^\s+$/.test(token);
    const width = glyphs.reduce((w, g) => w + g.adv, 0);
    if (isSpace) {
      if (current().glyphs.length > 0) {
        current().glyphs.push(...glyphs);
        current().width += width;
      }
      continue;
    }
    if (current().width + width > maxWidth && current().glyphs.length > 0) {
      // Remove trailing whitespace, then start a new line
      const cur = current();
      while (cur.glyphs.length > 0 && /\s/.test(String.fromCodePoint(cur.glyphs.at(-1)!.unicode))) {
        cur.width -= cur.glyphs.pop()!.adv;
      }
      lines.push({ glyphs: [], width: 0 });
    }
    for (const g of glyphs) {
      if (current().width + g.adv > maxWidth && current().glyphs.length > 0) {
        lines.push({ glyphs: [], width: 0 });
      }
      current().glyphs.push(g);
      current().width += g.adv;
    }
  }

  const out: TextLine[] = [];
  const placed: PlacedGlyph[] = [];
  lines.forEach((line, i) => {
    const y = by1 - p.ascent * p.fontSize - i * lead;
    let x = bx0;
    for (const g of line.glyphs) {
      placed.push({ gid: g.gid, unicode: g.unicode, x, y });
      x += g.adv;
    }
    out.push({ x: bx0, y, gids: line.glyphs.map((g) => g.gid) });
  });
  const usedHeight = p.ascent * p.fontSize + (lines.length - 1) * lead + 0.25 * p.fontSize;
  return {
    lines: out,
    glyphs: placed,
    lineCount: lines.length,
    overflow: usedHeight > by1 - by0,
    usedHeight,
  };
}
