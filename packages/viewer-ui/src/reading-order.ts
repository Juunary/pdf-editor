/**
 * Reading order and selection classification (pure functions).
 *
 * The reading order is the order of the `PageModel.lines` array (MuPDF reading order), and within a line it is the order of `LineInfo.chars`.
 * Characters absent from the structured text (`line` = -1, characters no line references) are collected and appended at the end.
 * `LineInfo.spaceAfter` (a synthetic space with no Device glyph, docs/m1-contract.md section 4) is used only as the
 * position where a space is inserted between characters. A space is not a character, so it does not enter caret positions or selection ranges, and it enters the copied text
 * only when the characters on both sides are in the selection range.
 * Selection is handled as "caret positions" between characters (0 … items.length). Selection range = caret range [from, to).
 */
import type { CharInfo, PageModel, Point } from '@pdf-editor/shared-types';
import { quadFrame } from './layout.js';

export interface ReadingItem {
  /** PageModel.chars index. */
  charIndex: number;
  /** ReadingOrder.lines index. */
  line: number;
  /** PageModel.blocks index. For a character that belongs to no line, ORPHAN_BLOCK. */
  block: number;
  /**
   * There is a synthetic space between this character and the next character on the same line. A space after the last character of a line (a line break follows immediately, so
   * it is the same once whitespace is collapsed) is not shown.
   */
  spaceAfter: boolean;
}

export interface ReadingLine {
  /** ReadingOrder.items range [start, end). */
  start: number;
  end: number;
  block: number;
  /** Lines grouped by glyph order and position because they are absent from the structured text. */
  orphan: boolean;
}

export interface ReadingOrder {
  items: ReadingItem[];
  lines: ReadingLine[];
  /** Number of characters absent from the structured text. */
  orphanChars: number;
}

export const ORPHAN_BLOCK = -1;

/** Groups characters whose glyph order continues into lines by baseline position. */
function sameOrphanLine(a: CharInfo, b: CharInfo): boolean {
  if (a.wmode !== b.wmode) return false;
  const tolerance = 0.5 * Math.max(a.size, b.size, 1);
  // Horizontal writing advances along x with y as the line position; vertical writing is the opposite.
  const [alongA, acrossA] = a.wmode === 1 ? [a.origin[1], a.origin[0]] : [a.origin[0], a.origin[1]];
  const [alongB, acrossB] = a.wmode === 1 ? [b.origin[1], b.origin[0]] : [b.origin[0], b.origin[1]];
  if (Math.abs(acrossA - acrossB) > tolerance) return false;
  return alongB >= alongA - tolerance;
}

function groupOrphanLines(chars: CharInfo[], indices: number[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | null = null;
  let prev: CharInfo | null = null;
  for (const index of indices) {
    const char = chars[index]!;
    if (current && prev && sameOrphanLine(prev, char)) {
      current.push(index);
    } else {
      current = [index];
      groups.push(current);
    }
    prev = char;
  }
  return groups;
}

export function buildReadingOrder(model: PageModel): ReadingOrder {
  const n = model.chars.length;
  const covered = new Uint8Array(n);
  const items: ReadingItem[] = [];
  const lines: ReadingLine[] = [];

  for (const line of model.lines) {
    const start = items.length;
    const spaces = new Set(line.spaceAfter);
    line.chars.forEach((charIndex, position) => {
      if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= n || covered[charIndex]) {
        return;
      }
      covered[charIndex] = 1;
      // The k of spaceAfter is the position in the original chars array (positions do not shift even if some characters were filtered out).
      items.push({
        charIndex,
        line: lines.length,
        block: line.block,
        spaceAfter: spaces.has(position),
      });
    });
    if (items.length > start) {
      // A space at the end of a line is not shown.
      items[items.length - 1]!.spaceAfter = false;
      lines.push({ start, end: items.length, block: line.block, orphan: false });
    }
  }

  const orphans: number[] = [];
  for (let i = 0; i < n; i++) if (!covered[i]) orphans.push(i);
  for (const group of groupOrphanLines(model.chars, orphans)) {
    const start = items.length;
    for (const charIndex of group) {
      items.push({ charIndex, line: lines.length, block: ORPHAN_BLOCK, spaceAfter: false });
    }
    lines.push({ start, end: items.length, block: ORPHAN_BLOCK, orphan: true });
  }

  return { items, lines, orphanChars: orphans.length };
}

export interface AssembleOptions {
  /** Between lines in the same block (default "\n"). */
  lineSeparator?: string;
  /** Between blocks (default "\n\n", the same blank line as MuPDF text output). */
  blockSeparator?: string;
}

/** Assembles the characters of the caret range [from, to) into reading-order text. The range is corrected automatically. */
export function assembleText(
  model: PageModel,
  order: ReadingOrder,
  from: number,
  to: number,
  options: AssembleOptions = {},
): string {
  const { lineSeparator = '\n', blockSeparator = '\n\n' } = options;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(order.items.length, Math.max(from, to));
  let out = '';
  for (let k = lo; k < hi; k++) {
    const item = order.items[k]!;
    if (k > lo) {
      const prev = order.items[k - 1]!;
      if (item.line !== prev.line) {
        out += item.block !== prev.block ? blockSeparator : lineSeparator;
      } else if (prev.spaceAfter) {
        out += ' ';
      }
    }
    out += model.chars[item.charIndex]!.text;
  }
  return out;
}

/**
 * Weight of the distance along the line direction in the distance to a character quad. The distance across lines is weighted more, so that when dragging below or beside text
 * the line that is vertically closer is chosen over the last character of a long preceding line (0 looks only at the line-height range).
 */
export const ALONG_LINE_WEIGHT = 0.25;

export interface PointLocation {
  /** Weighted distance to the character quad (pt). 0 if inside. */
  distance: number;
  /** Position ratio along the reading direction (ul→ur for horizontal writing, ul→ll for vertical). 0–1 if inside. */
  progress: number;
}

/** Where the point is relative to a character quad. Also handles quads with zero width or height safely. */
export function locatePoint(char: CharInfo, p: Point): PointLocation {
  const f = quadFrame(char.quad);
  const dx = p[0] - f.ox;
  const dy = p[1] - f.oy;
  const s = dx * f.ux + dy * f.uy;
  const t = dx * f.vx + dy * f.vy;
  const ds = s < 0 ? -s : s > f.lu ? s - f.lu : 0;
  const dt = t < 0 ? -t : t > f.lv ? t - f.lv : 0;
  const vertical = char.wmode === 1;
  const progress = vertical ? (f.lv > 0 ? t / f.lv : 0) : f.lu > 0 ? s / f.lu : 0;
  // For horizontal writing u (ds) is the line advance direction; for vertical writing v (dt) is.
  const distance = vertical
    ? Math.hypot(ds, ALONG_LINE_WEIGHT * dt)
    : Math.hypot(ALONG_LINE_WEIGHT * ds, dt);
  return { distance, progress };
}

export interface CaretHit {
  /** Caret position (0 … items.length). Before character k is k, after it is k + 1. */
  caret: number;
  /** ReadingOrder.items index of the nearest character. */
  item: number;
  distance: number;
}

/**
 * The nearest character and caret position for a point (page space). Inside a character, the front half is before the character and the back half is after it.
 * Outside a line end, between lines, or where there are no characters, the nearest character (weighted distance, `ALONG_LINE_WEIGHT`) is still chosen, so
 * dragging does not jump around.
 * If distances are equal, the character earlier in reading order wins.
 */
export function caretAt(model: PageModel, order: ReadingOrder, p: Point): CaretHit | null {
  let best = -1;
  let bestDistance = Infinity;
  let bestProgress = 0;
  for (let k = 0; k < order.items.length; k++) {
    const char = model.chars[order.items[k]!.charIndex]!;
    const loc = locatePoint(char, p);
    if (loc.distance < bestDistance) {
      best = k;
      bestDistance = loc.distance;
      bestProgress = loc.progress;
      // When inside a character, keep the character that is earlier in reading order even if later characters overlap it.
      if (bestDistance === 0) break;
    }
  }
  if (best < 0) return null;
  return { caret: best + (bestProgress > 0.5 ? 1 : 0), item: best, distance: bestDistance };
}

/** ReadingOrder.items index of the character that contains the point. -1 if none. */
export function itemAtPoint(model: PageModel, order: ReadingOrder, p: Point): number {
  for (let k = 0; k < order.items.length; k++) {
    const char = model.chars[order.items[k]!.charIndex]!;
    if (locatePoint(char, p).distance === 0) return k;
  }
  return -1;
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

/**
 * Double-click: the run of whitespace/non-whitespace on the same line (caret range). A synthetic space (`spaceAfter`) is a word boundary.
 */
export function wordRange(model: PageModel, order: ReadingOrder, item: number): [number, number] {
  const target = order.items[item];
  if (!target) return [0, 0];
  const line = order.lines[target.line]!;
  const kind = isBlank(model.chars[target.charIndex]!.text);
  let from = item;
  let to = item + 1;
  while (
    from > line.start &&
    !order.items[from - 1]!.spaceAfter &&
    isBlank(model.chars[order.items[from - 1]!.charIndex]!.text) === kind
  ) {
    from--;
  }
  while (
    to < line.end &&
    !order.items[to - 1]!.spaceAfter &&
    isBlank(model.chars[order.items[to]!.charIndex]!.text) === kind
  ) {
    to++;
  }
  return [from, to];
}

/** Triple-click: the whole line (caret range). */
export function lineRange(order: ReadingOrder, item: number): [number, number] {
  const target = order.items[item];
  if (!target) return [0, 0];
  const line = order.lines[target.line]!;
  return [line.start, line.end];
}
