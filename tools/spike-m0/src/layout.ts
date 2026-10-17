import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import type { TextLine } from '@pdf-editor/pdf-ops';

/**
 * 스파이크용 최소 문단 배치. 정식 리플로우는 packages/reflow(M3).
 * - advance 는 PDF /W 와 같도록 1/1000 em 으로 양자화한다.
 * - 공백 단위(어절) 줄바꿈, 한 단어가 줄보다 길면 글자 단위로 끊는다.
 * - 영역을 넘으면 잘라내지 않고 overflow 로 보고한다(자동 클립 금지).
 */

export interface PlacedGlyph {
  gid: number;
  unicode: number;
  /** PDF 사용자 공간 기준선 원점 */
  x: number;
  y: number;
}

export interface ParagraphLayout {
  lines: TextLine[];
  glyphs: PlacedGlyph[];
  lineCount: number;
  overflow: boolean;
  /** 사용 높이(pt) */
  usedHeight: number;
}

export interface LayoutParams {
  font: mupdf.Font;
  text: string;
  fontSize: number;
  /** 줄 간격(배수) */
  lineHeight: number;
  /** 기준선 시작 위치 = 영역 위쪽에서 ascent 만큼 아래 */
  ascent: number;
  /** PDF 사용자 공간 영역 [x0, y0, x1, y1] (y 위 방향) */
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

  // 단어(공백 포함 토큰) 단위로 나눈다.
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
      // 줄 끝 공백 제거 후 새 줄
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
