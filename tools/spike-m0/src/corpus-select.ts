import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * Automatically picks body paragraphs from real documents (generalizes the Day 1 hard-coded coordinates, docs/m0-corpus-recheck.md section 2).
 * Treats MuPDF stext blocks as paragraph candidates, filters them by body font size, line alignment, line spacing, and character ratio, then
 * builds a redaction area that does not overlap other blocks' characters. All coordinates are MuPDF page coordinates (origin at top left).
 *
 * MuPDF redaction erases a character if its glyph outline (ink extent) overlaps the area at all (measured 2026-10-19:
 * removed even if the character center is outside the area; kept if only the quad's top/bottom margin overlaps). So the overlap check against the area
 * uses the estimated ink extent relative to the baseline (0.8em above, 0.22em below), not the quad.
 */

export interface StextChar {
  c: string;
  /** Baseline origin */
  x: number;
  y: number;
  size: number;
  font: string;
  /** Quad bounding rectangle */
  box: Rect;
}

export interface StextLine {
  bbox: Rect;
  wmode: number;
  dir: [number, number];
  chars: StextChar[];
}

export interface StextBlock {
  bbox: Rect;
  lines: StextLine[];
}

const INK_ASCENT = 0.8;
const INK_DESCENT = 0.22;

const quadBox = (q: mupdf.Quad): Rect => [
  Math.min(q[0], q[2], q[4], q[6]),
  Math.min(q[1], q[3], q[5], q[7]),
  Math.max(q[0], q[2], q[4], q[6]),
  Math.max(q[1], q[3], q[5], q[7]),
];

export function readTextBlocks(page: mupdf.Page): StextBlock[] {
  const blocks: StextBlock[] = [];
  const stext = page.toStructuredText('preserve-whitespace');
  try {
    stext.walk({
      beginTextBlock: (bbox) => void blocks.push({ bbox: [...bbox] as Rect, lines: [] }),
      beginLine: (bbox, wmode, dir) =>
        void blocks.at(-1)?.lines.push({
          bbox: [...bbox] as Rect,
          wmode,
          dir: [dir[0], dir[1]],
          chars: [],
        }),
      onChar: (c, origin, font, size, quad) =>
        void blocks
          .at(-1)
          ?.lines.at(-1)
          ?.chars.push({
            c,
            x: origin[0],
            y: origin[1],
            size,
            font: font.getName(),
            box: quadBox(quad),
          }),
    });
  } finally {
    stext.destroy();
  }
  return blocks;
}

export const lineText = (l: StextLine) => l.chars.map((c) => c.c).join('');
const isSpace = (c: string) => /^\s$/u.test(c);

/** Estimated ink extent (narrower than the quad above and below the character). null for whitespace. */
function inkBox(ch: StextChar): Rect | null {
  if (isSpace(ch.c)) return null;
  return [ch.box[0], ch.y - INK_ASCENT * ch.size, ch.box[2], ch.y + INK_DESCENT * ch.size];
}

export const rectsIntersect = (a: Rect, b: Rect) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

export const unionRect = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface ParagraphCandidate {
  pageIndex: number;
  blockIndex: number;
  /** The stext block as is (block), or consecutive single-line blocks joined (merged-lines) */
  source: 'block' | 'merged-lines';
  /** stext block numbers forming the candidate (excluded from the adjacent-text check) */
  memberBlocks: number[];
  /** redaction area = union of the estimated ink extents of the block's characters (0.5pt margin) */
  rect: Rect;
  /** Per-line text, baseline, and horizontal extent */
  lines: { text: string; baseline: number; x0: number; x1: number }[];
  text: string;
  /** Median font size (pt) */
  fontSize: number;
  /** Median baseline spacing (pt) */
  linePitch: number;
  fonts: string[];
  /** Number of non-whitespace characters */
  charCount: number;
  hangulRatio: number;
  /** Ratio of U+FFFD·private-use-area characters (indicator of hard-to-recover character mapping) */
  unmappedRatio: number;
}

export type RejectReason =
  | 'too-few-lines'
  | 'too-few-chars'
  | 'not-horizontal'
  | 'font-size-off-body'
  | 'mixed-font-size'
  | 'low-letter-ratio'
  | 'ragged-left'
  | 'irregular-line-pitch'
  | 'header-footer-band'
  | 'overlaps-other-text';

export interface PageScan {
  pageIndex: number;
  rotation: number;
  blocks: number;
  candidates: number;
}

export interface SelectionReport {
  pageCount: number;
  scannedPages: PageScan[];
  /** Character-count-weighted mode of font size over the scanned pages (0.5pt units) */
  bodyFontSize: number | null;
  /** Number of pages skipped because they are rotated (/Rotate ≠ 0) (among scanned pages) */
  rotatedSkipped: number;
  rejected: Partial<Record<RejectReason, number>>;
  /** Reasons single-line-block-merged candidates were rejected on pages with no block candidates */
  mergedRejected: Partial<Record<RejectReason, number>>;
  /** Share of single-line blocks among scanned pages (blocks with exactly one non-whitespace line ÷ text blocks) */
  singleLineBlockRatio: number | null;
  selected: ParagraphCandidate[];
}

interface ScannedPage {
  pageIndex: number;
  height: number;
  blocks: StextBlock[];
}

/** Paragraph candidate check. null means a candidate; otherwise the rejection reason. */
export function judgeBlock(
  block: StextBlock,
  others: StextBlock[],
  pageHeight: number,
  bodySize: number | null,
):
  | { reason: RejectReason }
  | {
      candidate: Omit<ParagraphCandidate, 'pageIndex' | 'blockIndex' | 'source' | 'memberBlocks'>;
    } {
  const lines = block.lines.filter((l) => l.chars.some((c) => !isSpace(c.c)));
  if (lines.length < 3) return { reason: 'too-few-lines' };
  if (
    lines.some((l) => l.wmode !== 0 || Math.abs(l.dir[0] - 1) > 1e-3 || Math.abs(l.dir[1]) > 1e-3)
  )
    return { reason: 'not-horizontal' };
  const chars = lines.flatMap((l) => l.chars).filter((c) => !isSpace(c.c));
  if (chars.length < 80) return { reason: 'too-few-chars' };
  const size = median(chars.map((c) => c.size));
  if (bodySize !== null && Math.abs(size - bodySize) > Math.max(0.6, bodySize * 0.15))
    return { reason: 'font-size-off-body' };
  const sameSize = chars.filter((c) => Math.abs(c.size - size) <= 0.6).length / chars.length;
  if (sameSize < 0.9) return { reason: 'mixed-font-size' };
  const letters = chars.filter((c) => /\p{L}/u.test(c.c)).length / chars.length;
  if (letters < 0.6) return { reason: 'low-letter-ratio' };
  const x0 = Math.min(...lines.map((l) => l.chars[0]!.box[0]));
  const aligned = lines.filter((l) => Math.abs(l.chars[0]!.box[0] - x0) <= 2 * size).length;
  if (aligned / lines.length < 0.8) return { reason: 'ragged-left' };
  const baselines = lines.map((l) => median(l.chars.map((c) => c.y)));
  const gaps = baselines.slice(1).map((b, i) => b - baselines[i]!);
  const pitch = median(gaps);
  if (
    !(pitch >= 0.95 * size && pitch <= 2.4 * size) ||
    gaps.some((g) => Math.abs(g - pitch) > 0.25 * pitch)
  )
    return { reason: 'irregular-line-pitch' };
  if (block.bbox[1] < pageHeight * 0.05 || block.bbox[3] > pageHeight * 0.95)
    return { reason: 'header-footer-band' };

  let rect: Rect | null = null;
  for (const ch of chars) {
    const ink = inkBox(ch);
    if (ink) rect = rect ? unionRect(rect, ink) : ink;
  }
  rect = [rect![0] - 0.5, rect![1] - 0.5, rect![2] + 0.5, rect![3] + 0.5];
  const intrudes = others.some((o) =>
    o.lines.some((l) =>
      l.chars.some((ch) => {
        const ink = inkBox(ch);
        return ink !== null && rectsIntersect(ink, rect!);
      }),
    ),
  );
  if (intrudes) return { reason: 'overlaps-other-text' };

  const text = lines.map(lineText).join('\n');
  const nonSpace = [...text].filter((c) => !isSpace(c) && c !== '\n');
  return {
    candidate: {
      rect,
      lines: lines.map((l, i) => {
        const ink = l.chars.filter((c) => !isSpace(c.c));
        return {
          text: lineText(l),
          baseline: baselines[i]!,
          x0: Math.min(...ink.map((c) => c.box[0])),
          x1: Math.max(...ink.map((c) => c.box[2])),
        };
      }),
      text,
      fontSize: size,
      linePitch: pitch,
      fonts: [...new Set(chars.map((c) => c.font))],
      charCount: nonSpace.length,
      hangulRatio: nonSpace.filter((c) => /\p{Script=Hangul}/u.test(c)).length / nonSpace.length,
      unmappedRatio: nonSpace.filter((c) => c === '�' || /[-]/u.test(c)).length / nonSpace.length,
    },
  };
}

const MAX_MERGED_LINES = 8;

const nonEmptyLines = (b: StextBlock) => b.lines.filter((l) => l.chars.some((c) => !isSpace(c.c)));

/**
 * Auxiliary path: for documents where MuPDF stext splits a block per line (measured: Word, Hancom, some LaTeX output), joins consecutive single-line
 * blocks into paragraph candidates. Same font size (±0.6pt), left-aligned (±2em), baseline spacing 0.95~2.4em, and
 * within ±25% of the previous spacing are treated as the same paragraph. Only groups of 3 or more lines are returned. Multi-line blocks break a group.
 * Documents with no spacing between paragraphs would form one group for the whole page, so groups are split every 8 lines (short-paragraph replacement scenario).
 */
export function mergeLineBlocks(blocks: StextBlock[]): { block: StextBlock; members: number[] }[] {
  const out: { block: StextBlock; members: number[] }[] = [];
  let group: { lines: StextLine[]; members: number[]; gap: number | null } | null = null;
  const flush = () => {
    if (group && group.lines.length >= 3) {
      const bbox = group.lines.map((l) => l.bbox).reduce(unionRect);
      out.push({ block: { bbox, lines: group.lines }, members: group.members });
    }
    group = null;
  };
  const sizeOf = (l: StextLine) => median(l.chars.filter((c) => !isSpace(c.c)).map((c) => c.size));
  const baseOf = (l: StextLine) => median(l.chars.map((c) => c.y));
  blocks.forEach((b, i) => {
    const lines = nonEmptyLines(b);
    if (lines.length !== 1) {
      flush();
      return;
    }
    const line = lines[0]!;
    const g = group as { lines: StextLine[]; members: number[]; gap: number | null } | null;
    if (g) {
      const last = g.lines.at(-1)!;
      const size = sizeOf(last);
      const gap = baseOf(line) - baseOf(last);
      const ok =
        Math.abs(sizeOf(line) - size) <= 0.6 &&
        Math.abs(line.chars[0]!.box[0] - g.lines[0]!.chars[0]!.box[0]) <= 2 * size &&
        gap >= 0.95 * size &&
        gap <= 2.4 * size &&
        (g.gap === null || Math.abs(gap - g.gap) <= 0.25 * g.gap);
      if (ok && g.lines.length < MAX_MERGED_LINES) {
        g.lines.push(line);
        g.members.push(i);
        g.gap ??= gap;
        return;
      }
      flush();
    }
    group = { lines: [line], members: [i], gap: null };
  });
  flush();
  return out;
}

/**
 * Page scan ranges: starting after the cover (page 0) at 15%·50%·85% of the document, `perStart` pages each going forward; the last range is
 * the remaining pages (from the front, capped at 60 pages total). Pages do not repeat.
 */
export function scanSegments(pageCount: number, perStart = 12): number[][] {
  if (pageCount <= 1) return [[0]];
  const seen = new Set<number>();
  const take = (from: number, to: number, limit: number) => {
    const seg: number[] = [];
    for (let p = from; p < to && seen.size < limit; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        seg.push(p);
      }
    }
    return seg;
  };
  const segments = [0.15, 0.5, 0.85].map((f) => {
    const start = Math.max(1, Math.floor((pageCount - 1) * f));
    return take(start, Math.min(pageCount, start + perStart), Infinity);
  });
  segments.push(take(0, pageCount, 60));
  return segments;
}

/**
 * Picks at most `max` body paragraphs from a document (from different pages, one from each of the three ranges in scan order first).
 * Rotated pages are skipped (edit placement assumes horizontal writing in PDF user space).
 */
export function selectParagraphs(doc: mupdf.PDFDocument, max = 3): SelectionReport {
  const pageCount = doc.countPages();
  const segments = scanSegments(pageCount);
  const order = segments.flat();
  const scanned: ScannedPage[] = [];
  const scans: PageScan[] = [];
  let rotatedSkipped = 0;
  for (const p of order) {
    const rot = doc.findPage(p).getInheritable('Rotate');
    const rotation = rot.isNull() ? 0 : ((rot.asNumber() % 360) + 360) % 360;
    if (rotation !== 0) {
      rotatedSkipped++;
      scans.push({ pageIndex: p, rotation, blocks: 0, candidates: 0 });
      continue;
    }
    const page = doc.loadPage(p);
    const bounds = page.getBounds();
    scanned.push({ pageIndex: p, height: bounds[3] - bounds[1], blocks: readTextBlocks(page) });
    page.destroy();
  }

  const hist = new Map<number, number>();
  for (const s of scanned)
    for (const b of s.blocks)
      for (const l of b.lines)
        for (const c of l.chars) {
          if (isSpace(c.c)) continue;
          const k = Math.round(c.size * 2) / 2;
          hist.set(k, (hist.get(k) ?? 0) + 1);
        }
  const bodyFontSize = hist.size ? [...hist].sort((a, b) => b[1] - a[1])[0]![0] : null;

  const rejected: SelectionReport['rejected'] = {};
  const mergedRejected: SelectionReport['mergedRejected'] = {};
  let textBlocks = 0;
  let singleLineBlocks = 0;
  const byPage = new Map<number, ParagraphCandidate[]>();
  for (const s of scanned) {
    const found: ParagraphCandidate[] = [];
    for (const b of s.blocks) {
      const n = nonEmptyLines(b).length;
      if (n > 0) textBlocks++;
      if (n === 1) singleLineBlocks++;
    }
    s.blocks.forEach((b, i) => {
      const r = judgeBlock(
        b,
        s.blocks.filter((o) => o !== b),
        s.height,
        bodyFontSize,
      );
      if ('reason' in r) rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
      else
        found.push({
          pageIndex: s.pageIndex,
          blockIndex: i,
          source: 'block',
          memberBlocks: [i],
          ...r.candidate,
        });
    });
    if (found.length === 0) {
      for (const m of mergeLineBlocks(s.blocks)) {
        const r = judgeBlock(
          m.block,
          s.blocks.filter((_o, i) => !m.members.includes(i)),
          s.height,
          bodyFontSize,
        );
        if ('reason' in r) mergedRejected[r.reason] = (mergedRejected[r.reason] ?? 0) + 1;
        else
          found.push({
            pageIndex: s.pageIndex,
            blockIndex: m.members[0]!,
            source: 'merged-lines',
            memberBlocks: m.members,
            ...r.candidate,
          });
      }
    }
    byPage.set(s.pageIndex, found);
    scans.push({
      pageIndex: s.pageIndex,
      rotation: 0,
      blocks: s.blocks.length,
      candidates: found.length,
    });
  }

  // Pick one per range first, then fill from the remaining pages if short. Only one per page, preferring near 5 lines.
  const best = (cs: ParagraphCandidate[]) =>
    [...cs].sort((a, b) => Math.abs(a.lines.length - 5) - Math.abs(b.lines.length - 5))[0];
  const selected: ParagraphCandidate[] = [];
  const used = new Set<number>();
  const pick = (pages: number[]) => {
    for (const p of pages) {
      const c = best(byPage.get(p) ?? []);
      if (c && !used.has(p)) {
        used.add(p);
        selected.push(c);
        return true;
      }
    }
    return false;
  };
  for (const seg of segments.slice(0, 3)) if (selected.length < max) pick(seg);
  while (selected.length < max && pick(order)) {
    // fill from the remaining pages
  }
  return {
    pageCount,
    scannedPages: scans.sort((a, b) => a.pageIndex - b.pageIndex),
    bodyFontSize,
    rotatedSkipped,
    rejected,
    mergedRejected,
    singleLineBlockRatio: textBlocks ? singleLineBlocks / textBlocks : null,
    selected,
  };
}
