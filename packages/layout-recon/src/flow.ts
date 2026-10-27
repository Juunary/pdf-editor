/**
 * Flow text reconstruction (contract section 3, step 5): header/footer separation, region stacking, paragraph splitting within regions.
 */
import type { Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { height, median, overlapX, quantile, width } from './geom.js';
import { BULLET, PAGE_NUMBER, SENTENCE_END, STARTS_UPPER } from './text-rules.js';
import { NUMBER_TAG, type Unit } from './units.js';

const TOC_ENTRY = /(?:\.\s?){4,}\s*\d{1,4}\s*$|…{2,}\s*\d{1,4}\s*$/u;

/** Same row: baseline difference is at most 0.4x the font size (math lines have tall boxes, so box overlap is not used). */
const sameLine = (a: Unit, b: Unit): boolean =>
  Math.abs(a.baseline - b.baseline) <= 0.4 * Math.max(a.size, b.size);

/** Body font size: median size weighted by the number of visible characters. */
export function bodySize(units: readonly Unit[]): number {
  const sizes: number[] = [];
  for (const u of units) {
    const n = Math.min(u.text.replace(/\s/gu, '').length, 200);
    for (let i = 0; i < n; i++) sizes.push(u.size);
  }
  return sizes.length ? median(sizes) : 10;
}

export interface MarginSplit {
  header: Unit[];
  footer: Unit[];
  body: Unit[];
}

/**
 * Header/footer (contract 2.5): units inside the top/bottom margin band and at least marginGapEm away from the body.
 * Text much larger than body text (titles) is excluded unless it has a page number format. A footer must be short (at most 60% of page width) or only a page number format.
 */
export function splitMargins(
  units: readonly Unit[],
  bounds: Rect,
  body: number,
  repeated: ReadonlySet<Unit> = new Set(),
): MarginSplit {
  const H = height(bounds);
  const W = width(bounds);
  const topLimit = bounds[1] + C.marginBand * H;
  const bottomLimit = bounds[3] - C.marginBand * H;
  const minGap = C.marginGapEm * body;
  const inTop = (u: Unit) => u.bbox[3] <= topLimit;
  const inBottom = (u: Unit) => u.bbox[1] >= bottomLimit;
  // A long prose line (body-sized, at least 8 words, at least 60% of page width) is not a header/footer (e.g. a highlight box at the top of the page).
  const prose = (u: Unit) =>
    u.size >= 0.8 * body &&
    u.parts.reduce((n, p) => n + p.words.length, 0) >= 8 &&
    width(u.bbox) >= 0.6 * W;
  const eligible = (u: Unit) => PAGE_NUMBER.test(u.text) || (u.size <= body * 1.3 && !prose(u));
  const header = new Set<Unit>();
  const footer = new Set<Unit>();
  // A header/footer group made only of text smaller than body text uses half the gap threshold.
  const gapFor = (block: Unit[]): number =>
    block.every((u) => u.size < 0.95 * body) ? minGap / 2 : minGap;
  // Top band: among cut positions y (the bottom edge of a unit in the band), the lowest one where all units above y are inside the band and eligible, and the nearest unit below y
  // is at least minGap away. The units above it are the header. The bottom band is symmetric.
  let topCut = -Infinity;
  for (const c of units.filter(inTop)) {
    const y = c.bbox[3];
    const above = units.filter((u) => u.bbox[1] < y - 1);
    if (!above.every((u) => inTop(u) && eligible(u))) continue;
    const bottom = Math.max(...above.map((u) => u.bbox[3]));
    const below = units.filter((u) => u.bbox[1] >= bottom - 1 && !above.includes(u));
    // If there is no body unit below (all characters are inside the band), it is not classified as a header.
    if (below.length === 0) continue;
    const next = below.reduce((m, u) => Math.min(m, u.bbox[1]), Infinity);
    if (next - bottom >= gapFor(above)) topCut = Math.max(topCut, bottom);
  }
  for (const u of units) if (u.bbox[3] <= topCut) header.add(u);
  let bottomCut = Infinity;
  for (const c of units.filter(inBottom)) {
    const y = c.bbox[1];
    const belowSet = units.filter((u) => u.bbox[3] > y + 1);
    const ok = belowSet.every(
      (u) =>
        inBottom(u) &&
        eligible(u) &&
        // A wide line counts as a footer only if its text is much smaller than body text (e.g. a slide bottom bar), to distinguish it from footnotes.
        (width(u.bbox) <= 0.6 * W || PAGE_NUMBER.test(u.text) || u.size < 0.8 * body),
    );
    if (!ok) continue;
    const top = Math.min(...belowSet.map((u) => u.bbox[1]));
    const aboveSet = units.filter((u) => u.bbox[3] <= top + 1 && !belowSet.includes(u));
    if (aboveSet.length === 0) continue;
    const prev = aboveSet.reduce((m, u) => Math.max(m, u.bbox[3]), -Infinity);
    if (top - prev >= gapFor(belowSet)) bottomCut = Math.min(bottomCut, top);
  }
  for (const u of units) if (u.bbox[1] >= bottomCut) footer.add(u);
  // A unit repeated at the same position with the same text (ignoring digits) on neighboring pages (running head, page number): within the top/bottom 20% of the page, and
  // if there is no non-repeating body unit further outside, it is a header/footer (in place of the margin band and gap conditions).
  for (const u of repeated) {
    if (u.bbox[3] <= bounds[1] + 0.2 * H) {
      const outer = units.filter((v) => v.bbox[3] <= u.bbox[1] + 1);
      if (outer.every((v) => header.has(v) || repeated.has(v))) header.add(u);
    } else if (u.bbox[1] >= bounds[3] - 0.2 * H) {
      const outer = units.filter((v) => v.bbox[1] >= u.bbox[3] - 1);
      if (outer.every((v) => footer.has(v) || repeated.has(v))) footer.add(u);
    }
  }
  return {
    header: units.filter((u) => header.has(u)),
    footer: units.filter((u) => footer.has(u)),
    body: units.filter((u) => !header.has(u) && !footer.has(u)),
  };
}

export interface Region {
  units: Unit[];
  bbox: Rect;
}

const unionRect = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];

const xFits = (a: Rect, b: Rect): boolean =>
  overlapX(a, b) >= C.stackOverlap * Math.min(width(a), width(b));

/**
 * Region stacking (contract section 3, step 5): same region if x overlaps the unit above and the vertical gap is small.
 * Not linked if the unit above overlaps two or more units in the row below (a line spanning several columns). Not linked across obstacles (tables, figures).
 */
export function stackRegions(units: readonly Unit[], obstacles: readonly Rect[]): Region[] {
  const sorted = [...units].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const regions: Region[] = [];
  const regionOf = new Map<Unit, Region>();
  const blocked = (a: Rect, b: Rect): boolean =>
    obstacles.some((o) => o[1] >= a[3] - 1 && o[3] <= b[1] + 1 && overlapX(o, unionRect(a, b)) > 0);
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i]!;
    const rowmates = sorted.filter((m) => m !== u && sameLine(m, u));
    const cands: { r: Region; gap: number }[] = [];
    for (const r of regions) {
      const last = r.units.at(-1)!;
      // Judged by baseline spacing (subtracting the line box of about 1.2em gives the gap between boxes).
      const d = u.baseline - last.baseline;
      const size = Math.max(u.size, last.size);
      if (d > (1.2 + C.stackGapEm) * size || d < 0.5 * Math.min(u.size, last.size)) continue;
      const gap = d;
      if (!xFits(last.bbox, u.bbox)) continue;
      // If the unit above also overlaps another unit in the same row as u, it is a line spanning several columns.
      // The overlap threshold is kept low (a wide title is a spanning line even if it covers only part of the right column).
      if (
        rowmates.some(
          (m) =>
            m.baseline > last.baseline + 0.5 * m.size &&
            overlapX(last.bbox, m.bbox) > 0.25 * Math.min(width(m.bbox), width(last.bbox)),
        )
      )
        continue;
      if (blocked(last.bbox, u.bbox)) continue;
      cands.push({ r, gap });
    }
    cands.sort((a, b) => a.gap - b.gap);
    const best = cands[0];
    // If u spans two side-by-side regions (a line covering several columns below), it starts a new region.
    const spans =
      best && cands.some((c) => c !== best && sameLine(c.r.units.at(-1)!, best.r.units.at(-1)!));
    if (best && !spans) {
      best.r.units.push(u);
      best.r.bbox = unionRect(best.r.bbox, u.bbox);
      regionOf.set(u, best.r);
    } else {
      const r: Region = { units: [u], bbox: u.bbox };
      regions.push(r);
      regionOf.set(u, r);
    }
  }
  return regions;
}

const firstWordAfterBullet = (u: Unit): number | null => {
  const words = u.parts.flatMap((p) => p.words);
  if (words.length < 2 || !BULLET.test(u.text)) return null;
  // If the bullet marker is a separate fragment or the first word, the start of the second word is the start of the body.
  return words[1]!.x0;
};

/**
 * Paragraph splitting within a region (contract section 3, step 5). The result is groups of units (top→bottom).
 */
export function splitParagraphs(region: Region, reasons?: string[]): Unit[][] {
  const us = region.units;
  if (us.length <= 1) return us.length ? [us.slice()] : [];
  // Line spacing reference: the lower 30% quantile of baseline gaps between neighbor pairs with the same font size (±10%). Even if differently shaped
  // text (highlight box + table of contents, etc.) is mixed in one region, each is judged by its own spacing.
  const pairs: { d: number; size: number }[] = [];
  for (let i = 1; i < us.length; i++) {
    const a = us[i - 1]!;
    const b = us[i]!;
    const d = b.baseline - a.baseline;
    // Includes double line spacing (Word, etc.). Even when paragraph gaps are mixed in, the lower quantile is the in-paragraph spacing.
    if (d > 0 && d < 3.5 * Math.max(a.size, b.size) && Math.abs(a.size - b.size) <= 0.1 * b.size)
      pairs.push({ d, size: b.size });
  }
  const pitchCache = new Map<number, number>();
  const pitch = (size: number): number => {
    const key = Math.round(size * 10);
    let v = pitchCache.get(key);
    if (v === undefined) {
      const ds = pairs.filter((p) => Math.abs(p.size - size) <= 0.1 * size).map((p) => p.d);
      v = ds.length ? quantile(ds, 0.3) : Infinity;
      pitchCache.set(key, v);
    }
    return v;
  };
  const left = quantile(
    us.map((u) => u.bbox[0]),
    0.2,
  );
  const right = quantile(
    us.map((u) => u.bbox[2]),
    0.9,
  );
  const regionW = right - left;
  // Local statistics per line: among the 4 lines before and after, using lines whose left edge is within 3em or that overlap horizontally by at least 70% (body text in the same column),
  // determine the right edge, left edge and whether the text is justified. Even if a wide title or abstract and narrow-column body text are stacked in one region,
  // body lines are not judged "short" against the wide line. The window keeps the same size (4 lines before and after + itself) even at region edges
  // (it is shifted inward): if truncated, fewer lines remain, only short ones, and the right edge is estimated too low.
  const localSpan = 2 * C.localHalfWindow + 1;
  const localStats = us.map((u, i) => {
    const em = u.size;
    const lo = Math.max(0, Math.min(i - C.localHalfWindow, us.length - localSpan));
    const group = us.filter((v, j) => {
      if (j < lo || j >= lo + localSpan) return false;
      if (Math.abs(v.bbox[0] - u.bbox[0]) <= 3 * em) return true;
      const ov = Math.min(u.bbox[2], v.bbox[2]) - Math.max(u.bbox[0], v.bbox[0]);
      // Based on the wider width (a wide line enclosing a narrow-column line is not treated as the same column).
      return ov >= 0.7 * Math.max(u.bbox[2] - u.bbox[0], v.bbox[2] - v.bbox[0]);
    });
    const r = quantile(
      group.map((v) => v.bbox[2]),
      0.9,
    );
    const l = quantile(
      group.map((v) => v.bbox[0]),
      0.2,
    );
    const flushN = group.filter((v) => v.bbox[2] >= r - 0.5 * v.size).length;
    return {
      left: l,
      right: r,
      regionW: r - l,
      justified: group.length >= 4 && flushN >= 0.6 * group.length,
    };
  });
  // Display math lines: lines with a math ratio of at least 40% that are short (under 85% of the region width, not the page width), plus equation numbers beside or below them.
  const isMath = us.map(
    (u) => u.math >= 0.4 && u.bbox[2] - u.bbox[0] < 0.85 * Math.max(regionW, 1),
  );
  us.forEach((u, i) => {
    if (!isMath[i] && NUMBER_TAG.test(u.text) && (isMath[i - 1] || isMath[i + 1])) isMath[i] = true;
  });
  const paras: Unit[][] = [[us[0]!]];
  for (let i = 1; i < us.length; i++) {
    const a = us[i - 1]!;
    const b = us[i]!;
    const cur = paras.at(-1)!;
    let why: string | null;
    if (isMath[i - 1] && isMath[i]) {
      // Lines of the same display equation (fractions, subscripts, equation numbers) form one paragraph unless the gap is large.
      why = b.baseline - a.baseline > 3 * Math.max(a.size, b.size) ? 'math-gap' : null;
    } else if (isMath[i - 1] !== isMath[i]) {
      why = 'math-boundary';
    } else why = breakReason(a, b, cur, { pitch, ...localStats[i - 1]! });
    reasons?.push(why ?? '');
    if (why) paras.push([b]);
    else cur.push(b);
  }
  return paras;
}

interface RegionStats {
  justified: boolean;
  pitch: (size: number) => number;
  left: number;
  right: number;
  regionW: number;
}

const firstWordWidth = (u: Unit, em: number): number => {
  const w = u.parts[0]?.words[0];
  return w ? w.x1 - w.x0 : em;
};

/** Reason to split the paragraph (null if none). */
function breakReason(a: Unit, b: Unit, cur: Unit[], s: RegionStats): string | null {
  const em = Math.max(a.size, b.size);
  const indent = C.indentEm * Math.min(a.size, b.size);
  // Change in size, weight or color.
  if (Math.abs(a.size - b.size) / em >= C.sizeChangeRatio) return 'size';
  if (a.bold !== b.bold) return 'bold';
  if (a.color && b.color && a.color.some((v, k) => Math.abs(v - b.color![k]!) > 0.15))
    return 'color';
  // Spacing.
  const d = b.baseline - a.baseline;
  // Subtract from the spacing the line height added by absorbed large operators and subscripts/superscripts.
  const tall = (u: Unit) => Math.max(0, u.full[3] - u.full[1] - (u.bbox[3] - u.bbox[1]));
  const dd = d - (tall(a) + tall(b)) / 2;
  if (dd > s.pitch(b.size) * C.paraPitchRatio + 0.5 && dd > 1.05 * b.size) return 'pitch';
  // Bullet.
  // Center-aligned lines: same center (0.25em) and both left and right edges differ (distinguished from indentation). Caption and title blocks.
  const centered =
    Math.abs((a.bbox[0] + a.bbox[2]) / 2 - (b.bbox[0] + b.bbox[2]) / 2) <= 0.25 * em &&
    Math.abs(a.bbox[0] - b.bbox[0]) > indent &&
    Math.abs(a.bbox[2] - b.bbox[2]) > indent;
  // Bullet: if the previous line is full, the sentence continues and the current paragraph is not a list item, it is treated as an in-text reference like "(b)".
  // A "(b)" inside a center-aligned paragraph is also a reference.
  if (BULLET.test(b.text) && !centered) {
    const inline =
      a.bbox[2] >= s.right - 0.5 * em && !SENTENCE_END.test(a.text) && !BULLET.test(cur[0]!.text);
    if (!inline) return 'bullet';
  }
  // Table-of-contents entries (dot leader + page number) are one paragraph per line.
  if (TOC_ENTRY.test(a.text)) return 'toc';
  const hyphen = /[-‐]$/u.test(a.text);
  // A center-aligned line (centered, with its left edge inset from the region's left) is not treated as an indent.
  if (!centered) {
    if (cur.length === 1) {
      if (b.bbox[0] > a.bbox[0] + indent) {
        const after = firstWordAfterBullet(a);
        const words = BULLET.test(a.text) ? a.parts.flatMap((p) => p.words).slice(1, 6) : [];
        const hanging =
          (after !== null && Math.abs(b.bbox[0] - after) <= 0.6 * em) ||
          words.some((w) => Math.abs(w.x0 - b.bbox[0]) <= 1.5) ||
          // If the first bullet line fills to the right edge and the next line is inset, it is a hanging-indent continuation.
          (BULLET.test(a.text) && a.bbox[2] >= s.right - 0.5 * em) ||
          // If there is no room for the next line's first word after the first bullet line, it is a wrapped line.
          (BULLET.test(a.text) && s.right - a.bbox[2] < firstWordWidth(b, em) + 0.3 * em);
        if (!hanging) return 'indent-first';
      }
    } else {
      const paraLeft = median(cur.slice(1).map((u) => u.bbox[0]));
      if (b.bbox[0] > paraLeft + indent) return 'indent-in';
      if (b.bbox[0] < paraLeft - indent) return 'outdent';
    }
  }
  if (hyphen) return null;
  // Previous line ends early: if the first word of the next line would fit in the remaining space of the previous line, it is not an automatic line wrap.
  if (s.regionW > 8 * em) {
    const firstWord = b.parts[0]?.words[0];
    const wordW = firstWord ? firstWord.x1 - firstWord.x0 : em;
    const room = s.right - a.bbox[2];
    const short = room > Math.max(wordW + 0.3 * em, C.shortLineRatio * s.regionW * 0.5);
    if (short) {
      if (SENTENCE_END.test(a.text)) return 'sentence-end';
      if (s.justified && !centered) return 'short-justified';
      if (STARTS_UPPER.test(b.text) && !centered) return 'upper';
      if (a.bbox[2] < s.left + 0.6 * s.regionW && !centered) return 'very-short';
    }
  }
  return null;
}
