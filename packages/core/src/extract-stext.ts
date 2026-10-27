/**
 * Traversal of structured text (`Page.toStructuredText`) and joining it with Device glyphs.
 * The join key is the origin (both come from the same `fz_text`, so the difference is at floating-point rounding level). When several
 * candidates share an origin, the one with the same Unicode is picked first. For vertical writing, the structured-text origin is offset from the Device origin by the vertical
 * advance vector (`stextOriginOf`), so the lookup uses that point.
 */
import type * as mupdf from 'mupdf';
import type { Point, Quad, RGB, Rect } from '@pdf-editor/shared-types';
import type { RawGlyph } from './extract-device.js';

export interface StextChar {
  /** Code unit of `String.fromCharCode(c)` (mupdf.js truncates code points outside the BMP). */
  rune: number;
  origin: Point;
  quad: Quad;
  /** sRGB of the structured text (8-bit units). */
  rgb: RGB;
  /** Index into StextData.lines. */
  line: number;
  /** Order within the line. */
  indexInLine: number;
  /** Index of the joined Device glyph. -1 if there is no match. */
  owner: number;
  /** Trailing characters consumed together when one glyph is several characters (ligature or multi-character ToUnicode) (filled only on the primary character). */
  parts: StextChar[];
}

export interface StextLine {
  bbox: Rect;
  wmode: 0 | 1;
  dir: Point;
  block: number;
  chars: StextChar[];
}

export interface StextBlock {
  bbox: Rect;
  lines: number[];
}

export interface StextData {
  chars: StextChar[];
  lines: StextLine[];
  blocks: StextBlock[];
}

/** Tolerance (pt) within which origins are considered effectively equal. */
const TIGHT_EPS = 0.05;
/** Maximum distance (pt) for finding candidates whose origin is off. A margin for when the reference point differs slightly, e.g. in vertical writing. */
const SEARCH_RADIUS = 1;

export function readStructuredText(page: mupdf.Page): StextData {
  const data: StextData = { chars: [], lines: [], blocks: [] };
  const st = page.toStructuredText('');
  try {
    let block = -1;
    let line = -1;
    st.walk({
      beginTextBlock(bbox) {
        block = data.blocks.length;
        data.blocks.push({ bbox: bbox as Rect, lines: [] });
      },
      beginLine(bbox, wmode, dir) {
        line = data.lines.length;
        data.lines.push({
          bbox: bbox as Rect,
          wmode: wmode === 1 ? 1 : 0,
          dir: dir as Point,
          block,
          chars: [],
        });
        data.blocks[block]!.lines.push(line);
      },
      onChar(c, origin, font, _size, quad, color) {
        // A Font wrapper newly created per character (reference 1). Unused, so release it right away.
        font.destroy();
        const lineData = data.lines[line]!;
        const ch: StextChar = {
          rune: c.charCodeAt(0),
          origin: origin as Point,
          quad: quad as Quad,
          rgb: color as RGB,
          line,
          indexInLine: lineData.chars.length,
          owner: -1,
          parts: [],
        };
        lineData.chars.push(ch);
        data.chars.push(ch);
      },
    });
  } finally {
    st.destroy();
  }
  return data;
}

/** Origin grid (1pt cells). Reduces the candidate search to 3x3 cells. */
class OriginGrid {
  #cells = new Map<string, StextChar[]>();

  constructor(chars: readonly StextChar[]) {
    for (const ch of chars) {
      const key = OriginGrid.key(ch.origin[0], ch.origin[1]);
      const cell = this.#cells.get(key);
      if (cell) cell.push(ch);
      else this.#cells.set(key, [ch]);
    }
  }

  static key(x: number, y: number): string {
    return `${Math.floor(x)},${Math.floor(y)}`;
  }

  *near(x: number, y: number): Generator<StextChar> {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.#cells.get(`${cx + dx},${cy + dy}`);
        if (cell) yield* cell;
      }
    }
  }
}

/** String of one Unicode character. null if there is no mapping or the value is invalid. */
function codePointText(unicode: number): string | null {
  if (!Number.isInteger(unicode) || unicode <= 0 || unicode > 0x10ffff) return null;
  if (unicode >= 0xd800 && unicode <= 0xdfff) return null;
  return String.fromCodePoint(unicode);
}

/**
 * Unicode string that a Device glyph represents. Appends the additional Unicode (ToUnicode multi-character),
 * and expands ligature code points (U+FB00–FB06) with NFKC. "�" if there is no mapping.
 */
export function glyphText(unicode: number, extra: readonly number[] = []): string {
  const base = codePointText(unicode);
  if (base === null) return '\uFFFD';
  let text =
    extra.length === 0 && unicode >= 0xfb00 && unicode <= 0xfb06 ? base.normalize('NFKC') : base;
  for (const e of extra) text += codePointText(e) ?? '';
  return text;
}

/**
 * Origin that the structured text assigns to this glyph (page space). For horizontal writing it equals the Device origin. For vertical writing (wmode 1),
 * MuPDF stext places the origin at the glyph origin plus the vertical advance vector ((0, −1), the font's vertical advance × glyph matrix),
 * (measured on 1.28.1: equal to the next glyph's Device origin. Holds under rotation, Tz and Tc as well).
 */
function stextOriginOf(g: RawGlyph): Point {
  if (g.wmode !== 1) return [g.m[4], g.m[5]];
  return [g.m[4] - g.advance * g.m[2], g.m[5] - g.advance * g.m[3]];
}

/**
 * Consumes structured-text characters one by one in glyph order. The returned array holds the match per glyph (null if none).
 * A ligature glyph consumes together the characters the structured text expanded (`f`,`i`) in line order.
 * Structured-text characters left without a match (Tr 4–6 duplicate lines, synthetic spaces, annotation text) stay with `owner` -1.
 */
export function matchGlyphs(glyphs: readonly RawGlyph[], data: StextData): Array<StextChar | null> {
  const grid = new OriginGrid(data.chars);
  const matches: Array<StextChar | null> = new Array(glyphs.length).fill(null);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    const text = glyphText(g.unicode, g.extra);
    const wanted = text.charCodeAt(0);
    // For vertical writing, first look up the point shifted by the advance vector; if not found, look up the Device origin once more.
    const points: Point[] = [stextOriginOf(g)];
    if (g.wmode === 1) points.push([g.m[4], g.m[5]]);
    let best: StextChar | null = null;
    for (const [x, y] of points) {
      let bestScore = Infinity;
      for (const ch of grid.near(x, y)) {
        if (ch.owner !== -1) continue;
        const d = Math.hypot(ch.origin[0] - x, ch.origin[1] - y);
        if (d > SEARCH_RADIUS) continue;
        // If the origins are effectively equal, the one with the same Unicode (0) comes first, otherwise (1) after it. Off-origin candidates are sorted by distance.
        const score = d <= TIGHT_EPS ? (ch.rune === wanted ? 0 : 1) : 2 + d;
        if (score < bestScore || (score === bestScore && best && isBefore(ch, best))) {
          best = ch;
          bestScore = score;
        }
      }
      if (best) break;
    }
    if (!best) continue;
    best.owner = i;
    matches[i] = best;
    if (text.length > 1) claimExtraParts(best, text, data, i);
  }
  return matches;
}

/** Whether it comes first in structured-text order (line number, order within the line). */
function isBefore(a: StextChar, b: StextChar): boolean {
  return a.line !== b.line ? a.line < b.line : a.indexInLine < b.indexInLine;
}

/**
 * If one glyph is several characters (ligature or ToUnicode multi-character), the structured text also expands them and places them consecutively
 * on the same line (the trailing characters' origins straddle the next glyph's origin). The same glyph must consume the trailing characters so that the next glyph's
 * match is not mixed up.
 */
function claimExtraParts(
  first: StextChar,
  text: string,
  data: StextData,
  glyphIndex: number,
): void {
  const line = data.lines[first.line]!;
  for (let k = 1; k < text.length; k++) {
    const next = line.chars[first.indexInLine + k];
    if (!next || next.owner !== -1 || next.rune !== text.charCodeAt(k)) return;
    next.owner = glyphIndex;
    first.parts.push(next);
  }
}

/**
 * Merges the quads of the structured-text characters corresponding to one glyph. Projects all vertices onto the first character's line direction (ul→ur)
 * to find the foremost and rearmost points, and uses the first character's height (ul→ll). With a single character, its quad is returned as is.
 */
export function unionQuads(chars: readonly StextChar[]): Quad {
  const first = chars[0]!.quad;
  if (chars.length === 1) return first;
  const ux = first[2] - first[0];
  const uy = first[3] - first[1];
  const len = Math.hypot(ux, uy) || 1;
  const dx = ux / len;
  const dy = uy / len;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const ch of chars) {
    for (let i = 0; i < 8; i += 2) {
      const t = (ch.quad[i]! - first[0]) * dx + (ch.quad[i + 1]! - first[1]) * dy;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
  }
  const hx = first[4] - first[0];
  const hy = first[5] - first[1];
  const ulx = first[0] + dx * tMin;
  const uly = first[1] + dy * tMin;
  const urx = first[0] + dx * tMax;
  const ury = first[1] + dy * tMax;
  return [ulx, uly, urx, ury, ulx + hx, uly + hy, urx + hx, ury + hy];
}
