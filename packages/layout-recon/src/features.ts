/**
 * Line features (internal input of layout-recon). One LineFeature per PageModel.lines entry.
 * Word and span boxes are built from the x range of the character quads (horizontal writing). Vertical or rotated lines have horizontal=false.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import { MATH_FONT } from './text-rules.js';

export interface Box {
  x0: number;
  x1: number;
  /** PageModel.chars indices (within this box, in line order). */
  chars: number[];
  text: string;
}

export interface LineFeature {
  /** PageModel.lines index. */
  index: number;
  bbox: Rect;
  /** Reading text (spaceAfter applied, trailing whitespace removed). */
  text: string;
  /** Median font size (pt). */
  size: number;
  /** Majority font by character count. */
  fontId: number;
  bold: boolean;
  italic: boolean;
  /** Median baseline y (page space). */
  baseline: number;
  /** Whether the line direction is nearly (1, 0). */
  horizontal: boolean;
  /** PageModel.chars indices, in line order. */
  chars: number[];
  /** Word boxes split by whitespace (characters or spaceAfter). */
  words: Box[];
  /** Span boxes split at large gaps (more than 1.5x the font size). Used to separate table cells and multi-column lines. */
  segments: Box[];
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function quadX(q: number[]): [number, number] {
  return [Math.min(q[0]!, q[2]!, q[4]!, q[6]!), Math.max(q[0]!, q[2]!, q[4]!, q[6]!)];
}

function splitBoxes(
  model: PageModel,
  chars: number[],
  spaceAfter: Set<number>,
  gapLimit: number,
  splitOnSpace: boolean,
): Box[] {
  const boxes: Box[] = [];
  let cur: Box | null = null;
  let prevX1 = -Infinity;
  chars.forEach((ci, k) => {
    const c = model.chars[ci]!;
    const isSpace = c.text.trim() === '';
    const [x0, x1] = quadX(c.quad);
    const gap = x0 - prevX1;
    if (isSpace) {
      if (splitOnSpace) cur = null;
      else if (cur) {
        cur.chars.push(ci);
        cur.text += c.text;
      }
      prevX1 = Math.max(prevX1, x1);
      return;
    }
    if (!cur || gap > gapLimit) {
      cur = { x0, x1, chars: [], text: '' };
      boxes.push(cur);
    }
    cur.chars.push(ci);
    cur.text += c.text;
    cur.x0 = Math.min(cur.x0, x0);
    cur.x1 = Math.max(cur.x1, x1);
    prevX1 = x1;
    if (spaceAfter.has(k)) {
      if (splitOnSpace) cur = null;
      else cur.text += ' ';
    }
  });
  for (const b of boxes) b.text = b.text.trim();
  return boxes;
}

export function lineFeatures(model: PageModel): LineFeature[] {
  return model.lines.map((line, index) => {
    const chars = line.chars;
    const spaceAfter = new Set(line.spaceAfter);
    const cs = chars.map((i) => model.chars[i]!);
    const visible = cs.filter((c) => c.text.trim() !== '');
    // Line size is based on non-math-font characters (so math subscript characters do not pull the line size down).
    const prose = visible.filter((c) => !MATH_FONT.test(model.fonts[c.fontId]?.name ?? ''));
    const sizes = (prose.length ? prose : visible).map((c) => c.size);
    const size = median(sizes.length ? sizes : cs.map((c) => c.size));
    const fontCount = new Map<number, number>();
    for (const c of visible) fontCount.set(c.fontId, (fontCount.get(c.fontId) ?? 0) + 1);
    const fontId =
      [...fontCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? cs[0]?.fontId ?? 0;
    const font = model.fonts[fontId];
    let text = '';
    chars.forEach((ci, k) => {
      text += model.chars[ci]!.text;
      if (spaceAfter.has(k)) text += ' ';
    });
    const horizontal = Math.abs(line.dir[1]) < 0.05 && line.dir[0] > 0 && line.wmode === 0;
    return {
      index,
      bbox: line.bbox,
      text: text.replace(/\s+$/u, ''),
      size,
      fontId,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false,
      baseline: median(visible.map((c) => c.origin[1])),
      horizontal,
      chars,
      words: splitBoxes(model, chars, spaceAfter, Math.max(size * 0.5, 1), true),
      segments: splitBoxes(model, chars, spaceAfter, Math.max(size * 1.5, 3), false),
    };
  });
}

/**
 * Extraction fingerprint source: line texts (lineFeatures rules) joined with "\n". The label's linesSha256 is the
 * UTF-8 SHA-256 of this string (docs/m2-contract.md 4.1). The caller computes the hash (this package does not depend on a crypto module).
 */
export function fingerprintText(model: PageModel): string {
  return lineFeatures(model)
    .map((f) => f.text)
    .join('\n');
}
