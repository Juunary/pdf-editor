/**
 * Paragraph layout (contract 5.4). Cluster shaping -> line breaking (greedy, first fit) -> on overflow, auto-extend the region's bottom edge (up to the limit) -> alignment and coordinates.
 * Coordinates are in page space (y down), lengths in pt. The same input gives the same result (excluding reflowMs).
 */
import type { PlacedGlyph, PlacedLine, Rect } from '@pdf-editor/shared-types';
import { now } from './clock.js';
import type { FontFace, FontSegment, ReflowInput, ReflowResult, WritableGlyph } from './index.js';
import { shaperFor, type ShapedGlyph } from './shaper.js';
import {
  classifyCluster,
  graphemeRanges,
  normalBreakBefore,
  preferredEmergencyBreakBefore,
  type CharClass,
} from './text.js';

/** Tolerance for the line-width check (pt). Keeps a line the same width as the original paragraph bbox from overflowing due to floating-point error. */
export const FIT_EPSILON = 0.01;
/** Tolerance for the overflow check (pt, contract 5.4: region bottom + 0.5pt). */
export const OVERFLOW_TOLERANCE = 0.5;
/** Default used when there is no font height information (1/1000 em). */
const DEFAULT_ASCENT = 800;
const DEFAULT_DESCENT = -200;

type ItemKind = 'glyph' | 'missing' | 'break';

interface Item {
  start: number;
  end: number;
  seg: FontSegment;
  kind: ItemKind;
  /** Present only when kind is glyph. */
  face: FontFace | null;
  glyphs: ShapedGlyph[];
  /** Advance (pt, including kerning). */
  adv: number;
  /** Kerning of adv with the next cluster (pt). */
  kernAfter: number;
  cc: CharClass;
}

interface LineRange {
  /** Cluster index [a, b). */
  a: number;
  b: number;
  hard: boolean;
}

interface Metrics {
  ascent: number;
  descent: number;
}

export function layout(input: ReflowInput): ReflowResult {
  const t0 = now();
  validate(input);
  const { text, segments, format, areaLimit } = input;
  const items = buildItems(text, segments);
  const ccs = items.map((it) => it.cc);
  const normal = items.map((_, i) => i > 0 && normalBreakBefore(ccs, i));
  const preferred = items.map((_, i) => i > 0 && preferredEmergencyBreakBefore(ccs, i));

  let area = intersect(format.area, areaLimit);
  const indent = Number.isFinite(format.firstLineIndent) ? format.firstLineIndent : 0;
  const lineLeft = (idx: number): number =>
    area[0] + (idx === 0 ? Math.max(indent, 0) : Math.max(-indent, 0));
  const lineWidth = (idx: number): number =>
    Math.max(0, area[2] - area[0] - (idx === 0 ? Math.max(indent, 0) : Math.max(-indent, 0)));
  const maxSize = segments.reduce((m, sg) => Math.max(m, sg.size), 0) || 12;
  const lineHeight = format.lineHeight > 0 ? format.lineHeight : maxSize * 1.2;
  const firstBaselineOffset = Number.isFinite(format.firstBaselineOffset)
    ? format.firstBaselineOffset
    : maxSize;
  const baseline = (idx: number): number => area[1] + firstBaselineOffset + idx * lineHeight;
  const firstFace = segments.find((sg) => sg.face !== null)?.face ?? null;
  const metricsOf = (line: LineRange): Metrics =>
    lineMetrics(items, line) ??
    caretMetrics(text, segments, firstFace, offsetOf(items, line, text), lineHeight);
  const bottomOf = (lines: LineRange[]): number => {
    const last = lines.length - 1;
    const lastLine = lines[last];
    return lastLine === undefined ? area[1] : baseline(last) - metricsOf(lastLine).descent;
  };

  const lines = breakLines(items, normal, preferred, lineWidth);
  const bottom = bottomOf(lines);
  // On overflow, automatically lower the bottom edge to the required height (up to the limit, 2026-10-20 user decision). The line width is unchanged, so line breaking is
  // not affected. Even if the user shrinks the region below the text height with a handle, it grows again by the same rule. If blocked by the limit, the overflow is kept.
  let overflow = bottom > area[3] + OVERFLOW_TOLERANCE;
  if (overflow) {
    area = [area[0], area[1], area[2], Math.max(area[3], Math.min(areaLimit[3], bottom))];
    overflow = bottom > area[3] + OVERFLOW_TOLERANCE;
  }

  const placedLines: PlacedLine[] = [];
  const glyphs: PlacedGlyph[] = [];
  const writable: WritableGlyph[][] = [];
  let box: Rect | null = null;
  lines.forEach((line, idx) => {
    const y = baseline(idx);
    const m = metricsOf(line);
    const isLast = idx === lines.length - 1;
    const placed = placeLine(items, line, lineLeft(idx), lineWidth(idx), format.align, isLast, y);
    glyphs.push(...placed.glyphs);
    writable.push(placed.writable);
    const start = line.a < line.b ? (items[line.a]?.start ?? 0) : offsetOf(items, line, text);
    const end = line.a < line.b ? (items[line.b - 1]?.end ?? start) : start;
    placedLines.push({
      baseline: y,
      x0: placed.x0,
      x1: placed.x1,
      ascent: m.ascent,
      descent: m.descent,
      start,
      end,
      hardBreak: line.hard,
    });
    const lineBox: Rect = [placed.x0, y - m.ascent, placed.x1, y - m.descent];
    box = box === null ? lineBox : union(box, lineBox);
  });

  return {
    summary: {
      lines: placedLines,
      glyphs,
      contentBox: box ?? [area[0], area[1], area[0], area[1]],
      area,
      overflow,
      reflowMs: now() - t0,
    },
    lines: writable,
  };
}

function validate(input: ReflowInput): void {
  const { text, segments } = input;
  let pos = 0;
  for (const sg of segments) {
    if (sg.start !== pos || sg.end < sg.start) {
      throw new Error(
        `reflow: segments 가 텍스트를 빈틈 없이 덮지 않는다(위치 ${pos}, 구간 [${sg.start}, ${sg.end}))`,
      );
    }
    if (!(sg.size > 0) || !Number.isFinite(sg.size)) {
      throw new Error(
        `reflow: 글자 크기가 양수가 아니다(구간 [${sg.start}, ${sg.end}), size ${sg.size})`,
      );
    }
    pos = sg.end;
  }
  if (pos !== text.length) {
    throw new Error(`reflow: segments 가 텍스트 끝(${text.length})까지 덮지 않는다(끝 ${pos})`);
  }
}

/** Builds clusters (extended grapheme clusters, also split at segment boundaries) and shapes each run of the same font in one pass. */
function buildItems(text: string, segments: readonly FontSegment[]): Item[] {
  const items: Item[] = [];
  for (const seg of segments) {
    for (const [start, end] of graphemeRanges(text, seg.start, seg.end)) {
      const cc = classifyCluster(text.slice(start, end));
      const kind: ItemKind = cc.cls === 'BK' ? 'break' : seg.face === null ? 'missing' : 'glyph';
      items.push({ start, end, seg, kind, face: seg.face, glyphs: [], adv: 0, kernAfter: 0, cc });
    }
  }
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    if (first === undefined || first.kind !== 'glyph' || first.face === null) {
      i++;
      continue;
    }
    const face = first.face;
    let j = i + 1;
    while (j < items.length && items[j]?.kind === 'glyph' && items[j]?.face?.key === face.key) j++;
    const unit = items.slice(i, j);
    const shaped = shaperFor(face).shape(
      text,
      unit.map((it) => [it.start, it.end] as const),
    );
    unit.forEach((it, k) => {
      const r = shaped[k] ?? null;
      if (r === null) {
        it.kind = 'missing';
        return;
      }
      const em = it.seg.size / 1000;
      // Letter spacing (Tc) is attached after the advance of each glyph. The spacing after the last glyph of a cluster is the gap to the next cluster, so like kerning
      // it is subtracted at the line end (kernAfter).
      const cs = it.seg.charSpacing ?? 0;
      const hs = it.seg.horizontalScale ?? 1;
      it.glyphs = r.glyphs;
      it.adv = r.advance * em * hs + cs * r.glyphs.length;
      it.kernAfter = r.kernAfter * em * hs + (r.glyphs.length > 0 ? cs : 0);
    });
    i = j;
  }
  return items;
}

/**
 * Greedy line breaking. Whitespace is not counted in the width check (it hangs at the line end), and the next kerning of the last cluster on a line is subtracted. On overflow, break at the last ordinary
 * break opportunity in the line; if there is none (a word is longer than the line width), use an emergency break (per syllable/character). A line holds at least one cluster.
 * Whitespace goes onto the line before the overflow check, and a break position cannot be before whitespace or a forced line break, so trailing whitespace and a forced line break after it
 * always stay on that line (no separate empty line is created).
 */
function breakLines(
  items: readonly Item[],
  normal: readonly boolean[],
  preferred: readonly boolean[],
  lineWidth: (idx: number) => number,
): LineRange[] {
  const lines: LineRange[] = [];
  const n = items.length;
  let i = 0;
  while (i < n) {
    const a = i;
    const width = lineWidth(lines.length) + FIT_EPSILON;
    let pen = 0;
    let lastBreak = -1;
    let end = -1;
    let hard = false;
    for (let j = a; j < n; j++) {
      const it = items[j];
      if (it === undefined) break;
      if (it.kind === 'break') {
        end = j + 1;
        hard = true;
        break;
      }
      if (it.cc.cls !== 'SP') {
        if (j > a && normal[j]) lastBreak = j;
        if (j > a && pen + (it.adv - it.kernAfter) > width) {
          end = lastBreak > a ? lastBreak : emergencyBreak(items, preferred, a, j);
          break;
        }
      }
      pen += it.adv;
    }
    if (end < 0) end = n;
    lines.push({ a, b: end, hard });
    i = end;
  }
  const last = items[n - 1];
  if (n === 0 || last?.kind === 'break') lines.push({ a: n, b: n, hard: false });
  return lines;
}

/** Emergency break position k (a < k <= j, break before k). Not allowed before whitespace; prefers the latest position that respects the prohibition rules. */
function emergencyBreak(
  items: readonly Item[],
  preferred: readonly boolean[],
  a: number,
  j: number,
): number {
  for (let k = j; k > a; k--) {
    if (items[k]?.cc.cls !== 'SP' && preferred[k]) return k;
  }
  return j;
}

interface PlacedLineGlyphs {
  glyphs: PlacedGlyph[];
  writable: WritableGlyph[];
  x0: number;
  x1: number;
}

/** Alignment and coordinates of one line. justify distributes extra space among the whitespace in the line, except for the last line and a line before a forced line break; if there is no whitespace, between clusters. */
function placeLine(
  items: readonly Item[],
  line: LineRange,
  left: number,
  width: number,
  align: string,
  isLast: boolean,
  y: number,
): PlacedLineGlyphs {
  const { a, b } = line;
  let contentEnd = b;
  while (contentEnd > a) {
    const cls = items[contentEnd - 1]?.cc.cls;
    if (cls !== 'SP' && cls !== 'BK') break;
    contentEnd--;
  }
  const advs: number[] = [];
  let natural = 0;
  for (let i = a; i < b; i++) {
    const it = items[i];
    let adv = it === undefined || it.kind !== 'glyph' ? 0 : it.adv;
    if (it !== undefined && i === contentEnd - 1 && it.kind === 'glyph') adv -= it.kernAfter;
    advs.push(adv);
    if (i < contentEnd) natural += adv;
  }
  const free = width - natural;
  const extra = new Array<number>(b - a).fill(0);
  let offset = 0;
  if (align === 'right') offset = Math.max(0, free);
  else if (align === 'center') offset = Math.max(0, free / 2);
  else if (align === 'justify' && !line.hard && !isLast && free > 0) {
    let firstContent = a;
    while (firstContent < contentEnd && items[firstContent]?.cc.cls === 'SP') firstContent++;
    const spaces: number[] = [];
    for (let i = firstContent + 1; i < contentEnd; i++) {
      if (items[i]?.cc.cls === 'SP' && items[i]?.kind === 'glyph') spaces.push(i);
    }
    if (spaces.length > 0) {
      for (const i of spaces) extra[i - a] = free / spaces.length;
    } else {
      // Line without whitespace: distribute only between two neighboring clusters that are both CJK/Hangul. Spreading a line that is a single Latin word
      // letter by letter makes the extractor insert a space between letters, which breaks copy and search (M3 corpus measurement 2026-10-20). If there is nowhere to distribute, left-align.
      const visible: number[] = [];
      for (let i = a; i < contentEnd; i++) if (items[i]?.kind === 'glyph') visible.push(i);
      const gaps: number[] = [];
      for (let k = 0; k < visible.length - 1; k++) {
        const i = visible[k] ?? a;
        const j = visible[k + 1] ?? a;
        if (items[i]?.cc.wide && items[j]?.cc.wide) gaps.push(i);
      }
      for (const i of gaps) extra[i - a] = free / gaps.length;
    }
  }

  const glyphs: PlacedGlyph[] = [];
  const writable: WritableGlyph[] = [];
  const x0 = left + offset;
  let pen = x0;
  let x1 = x0;
  for (let i = a; i < b; i++) {
    const it = items[i];
    if (it === undefined || it.kind === 'break') continue;
    const size = it.seg.size;
    if (it.kind === 'missing' || it.face === null) {
      glyphs.push({
        offset: it.start,
        length: it.end - it.start,
        font: { kind: 'missing' },
        x: pen,
        y,
        advance: 0,
        size,
      });
    } else {
      const face = it.face;
      const advance = (advs[i - a] ?? 0) + (extra[i - a] ?? 0);
      glyphs.push({
        offset: it.start,
        length: it.end - it.start,
        font:
          face.kind === 'original'
            ? { kind: 'original', fontId: face.fontId ?? -1 }
            : { kind: 'fallback' },
        x: pen,
        y,
        advance,
        size,
      });
      const em = size / 1000;
      const hs = it.seg.horizontalScale ?? 1;
      let gx = pen;
      for (const g of it.glyphs) {
        writable.push({
          offset: it.start,
          length: it.end - it.start,
          faceKey: face.key,
          code: g.code,
          gid: g.gid,
          x: gx + g.xOffset * em * hs,
          y,
          size,
          pdfWidth: g.pdfWidth,
          syntheticBold: it.seg.syntheticBold,
          syntheticItalic: it.seg.syntheticItalic,
          runIndex: it.seg.runIndex,
          ...(hs !== 1 ? { horizontalScale: hs } : {}),
        });
        gx += g.advance * em * hs + (it.seg.charSpacing ?? 0);
      }
      pen += advance;
    }
    if (i === contentEnd - 1) x1 = pen;
  }
  return { glyphs, writable, x0, x1 };
}

/**
 * Largest ascent and deepest descent among the line's glyph clusters (pt, descent negative). null if there are no glyphs.
 * Whitespace clusters are counted only on lines that consist solely of whitespace: this keeps whitespace that fell back to the fallback font because the original font has no space glyph (TeX fonts etc.)
 * from enlarging the line box with the fallback font's height.
 */
function lineMetrics(items: readonly Item[], line: LineRange): Metrics | null {
  return metricsOver(items, line, false) ?? metricsOver(items, line, true);
}

function metricsOver(items: readonly Item[], line: LineRange, spaces: boolean): Metrics | null {
  let m: Metrics | null = null;
  for (let i = line.a; i < line.b; i++) {
    const it = items[i];
    if (it === undefined || it.kind !== 'glyph' || it.face === null) continue;
    if ((it.cc.cls === 'SP') !== spaces) continue;
    const fm = faceMetrics(it.face, it.seg.size);
    m =
      m === null
        ? fm
        : { ascent: Math.max(m.ascent, fm.ascent), descent: Math.min(m.descent, fm.descent) };
  }
  return m;
}

function faceMetrics(face: FontFace | null, size: number): Metrics {
  const ok = face !== null && face.ascent > face.descent;
  return {
    ascent: ((ok ? face.ascent : DEFAULT_ASCENT) / 1000) * size,
    descent: ((ok ? face.descent : DEFAULT_DESCENT) / 1000) * size,
  };
}

/** Caret height for a line without glyphs (empty text or empty line): the font and size of the segment at that position (a zero-length segment takes priority). */
function caretMetrics(
  text: string,
  segments: readonly FontSegment[],
  firstFace: FontFace | null,
  offset: number,
  lineHeight: number,
): Metrics {
  let seg: FontSegment | undefined;
  for (const sg of segments) if (sg.start === offset && sg.end === offset) seg = sg;
  seg ??= segments.find((sg) => sg.start <= offset && offset < sg.end);
  if (seg === undefined && offset === text.length)
    seg = segments.findLast((sg) => sg.end === offset);
  seg ??= segments[0];
  const size = seg?.size ?? lineHeight / 1.2;
  return faceMetrics(seg?.face ?? firstFace, size);
}

/** Start text position of a line (an empty line takes the end of the previous line). */
function offsetOf(items: readonly Item[], line: LineRange, text: string): number {
  if (line.a < line.b) return items[line.a]?.start ?? 0;
  return line.a > 0 ? (items[line.a - 1]?.end ?? text.length) : 0;
}

function intersect(r: Rect, limit: Rect): Rect {
  const x0 = Math.max(r[0], limit[0]);
  const y0 = Math.max(r[1], limit[1]);
  return [x0, y0, Math.max(x0, Math.min(r[2], limit[2])), Math.max(y0, Math.min(r[3], limit[3]))];
}

function union(p: Rect, q: Rect): Rect {
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];
}
