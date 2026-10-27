/**
 * Visual line (Unit): a unit merging nearby stext line fragments in the same row (contract section 3, step 5, first item).
 * Region stacking, paragraph splitting and header/footer classification operate on Units.
 */
import type { PageModel, RGB, Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import { MATH_CHAR, MATH_FONT } from './text-rules.js';
import type { LineFeature } from './features.js';
import { height, overlapY, union, width } from './geom.js';

export interface Unit {
  /** Fragments left → right (including absorbed subscript and symbol fragments). */
  parts: LineFeature[];
  /** Box used for layout decisions (excluding absorbed fragments). */
  bbox: Rect;
  /** Box covering absorbed fragments too (for paragraph boxes). */
  full: Rect;
  size: number;
  baseline: number;
  /** Majority of visible characters use a bold font. */
  bold: boolean;
  /** Color of the majority of visible characters (null if none). */
  color: RGB | null;
  /** Fragment texts joined with spaces. */
  text: string;
  /** Ratio of math-font or math-symbol characters among visible characters (0–1). Used to decide display-equation grouping. */
  math: number;
}

/** Trailing line number: page number or equation number. */
export const NUMBER_TAG = /^\s*\(?\d{1,4}(?:\.\d{1,3})?[a-z]?\)?\s*$/u;

/** Section and table-of-contents numbers ("4.1", "B.", "IV.", "(a)"). */
const SECTION_NO =
  /^\s*(?:\(?[\dA-Za-z]{1,3}\)|[\dIVXivx]{1,4}(?:\.\d{1,3})*\.?|[A-Z]\.|§\s*\d+)\s*$/u;

/** Dot leader (table of contents). */
export const LEADER = /(?:\.\s?){4,}\s*$|…{2,}\s*$/u;

const colorKey = (c: RGB | null): string =>
  c ? c.map((v) => Math.round(v * 20)).join(',') : 'none';

/** Builds a Unit from fragments (parts are already left→right). */
export function makeUnit(model: PageModel, parts: LineFeature[]): Unit {
  let bbox = parts[0]!.bbox;
  for (const p of parts.slice(1)) bbox = union(bbox, p.bbox);
  let boldChars = 0;
  let visible = 0;
  let mathChars = 0;
  const colors = new Map<string, { c: RGB | null; n: number }>();
  for (const p of parts) {
    for (const ci of p.chars) {
      const ch = model.chars[ci]!;
      if (ch.text.trim() === '') continue;
      visible++;
      if (model.fonts[ch.fontId]?.bold) boldChars++;
      if (MATH_FONT.test(model.fonts[ch.fontId]?.name ?? '') || MATH_CHAR.test(ch.text))
        mathChars++;
      const k = colorKey(ch.color);
      const e = colors.get(k) ?? { c: ch.color, n: 0 };
      e.n++;
      colors.set(k, e);
    }
  }
  const top = [...colors.values()].sort((a, b) => b.n - a.n)[0];
  // Reference fragment: the one with the most characters (the larger one on ties). Keeps subscript and large-operator fragments from shifting the baseline and size.
  const main = parts.reduce((m, p) =>
    p.chars.length > m.chars.length || (p.chars.length === m.chars.length && p.size > m.size)
      ? p
      : m,
  );
  return {
    parts,
    bbox,
    full: bbox,
    size: main.size,
    baseline: main.baseline,
    bold: visible > 0 ? boldChars * 2 > visible : parts.every((p) => p.bold),
    color: top && top.n * 2 > visible ? top.c : null,
    text: parts.map((p) => p.text).join(' '),
    math: visible > 0 ? mathChars / visible : 0,
  };
}

/** Same-row check. */
export function sameRow(a: Rect, b: Rect): boolean {
  return overlapY(a, b) >= C.sameRowOverlap * Math.min(height(a), height(b));
}

/**
 * Groups horizontal lines into rows and merges neighboring fragments within a row whose gap is at most font size × rowJoinGapEm.
 * The result is top→bottom, left→right.
 */
export function buildUnits(
  model: PageModel,
  feats: readonly LineFeature[],
  fillers: readonly Rect[] = [],
  /** Joins same-row fragments regardless of gap (inside a table cell: the cell already bounds the horizontal range). */
  joinRow = false,
): Unit[] {
  const pageWidth = width(model.bounds);
  // What fills a row gap: inline images and other character fragments (large operators and subscripts in math are fragments on a different baseline).
  // A character fragment fills the gap only if it is narrow (at most 25% of page width) and covers almost the whole row height (lines in other columns do not fill it).
  const textFillers = feats.map((f) => f.bbox).filter((r) => width(r) <= 0.25 * pageWidth);
  const sorted = [...feats].sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0]);
  const rows: LineFeature[][] = [];
  for (const f of sorted) {
    const row = rows.at(-1);
    const ref = row?.[0];
    // Subscript/superscript fragments (size ratio over 1.3) allow a larger baseline difference.
    const ratio = ref ? Math.max(f.size, ref.size) / Math.max(Math.min(f.size, ref.size), 0.1) : 1;
    // Rows containing math fragments (baselines shifted by fractions and subscripts) allow a larger baseline difference.
    const mathy = ref !== undefined && (fragMath(model, f) >= 0.3 || fragMath(model, ref) >= 0.3);
    const tol = (ratio > 1.3 || mathy ? 0.6 : 0.35) * Math.max(f.size, ref?.size ?? 0);
    if (row && ref && Math.abs(f.baseline - ref.baseline) <= tol && sameRow(f.bbox, ref.bbox))
      row.push(f);
    else rows.push([f]);
  }
  const units: Unit[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0]);
    // Trailing-number joining is not applied to rows in the header/footer band (running head + page number).
    const pageH = height(model.bounds);
    const inMargin =
      row[0]!.bbox[3] <= model.bounds[1] + C.marginBand * pageH ||
      row[0]!.bbox[1] >= model.bounds[3] - C.marginBand * pageH;
    let parts: LineFeature[] = [row[0]!];
    for (const f of row.slice(1)) {
      const prev = parts.at(-1)!;
      const gap = Math.min(
        uncoveredGap(prev.bbox, f.bbox, fillers, 0.5),
        uncoveredGap(prev.bbox, f.bbox, [...fillers, ...textFillers], 0.8),
      );
      const ratio = Math.max(f.size, prev.size) / Math.max(Math.min(f.size, prev.size), 0.1);
      // Subscripts/superscripts (a small fragment directly attached) are merged regardless of size ratio.
      const script = ratio > 1.5 && gap <= 0.3 * Math.max(f.size, prev.size);
      const em = Math.max(f.size, prev.size);
      // Short fragments such as numbers and page numbers (width at most 3em) are joined up to a 2em gap (table of contents, section numbers).
      // (only when the left fragment has a number format, so short fragments in other columns are not joined)
      // A number fragment only when it is the first fragment of the row (so a trailing equation number "(8)" does not join a line in the next column).
      const shortPart =
        parts.length === 1 &&
        prev === row[0] &&
        width(prev.bbox) <= 3 * em &&
        SECTION_NO.test(prev.text);
      // Whether the fragment is at the end of the row (or at a column end at least 1.5em from the next fragment).
      const next = row[row.indexOf(f) + 1];
      const atRowEnd = !next || next.bbox[0] - f.bbox[2] >= 1.5 * em;
      const near = gap <= C.rowJoinGapEm * em || (shortPart && gap <= 2 * em);
      // A trailing number (table-of-contents page number, equation number) is joined regardless of gap if the left fragment is wide (at least 25% of page width) or follows a dot leader.
      const tag =
        !inMargin &&
        atRowEnd &&
        NUMBER_TAG.test(f.text) &&
        (width(prev.bbox) >= 0.25 * pageWidth || LEADER.test(prev.text));
      // Display math: math fragments in the same row (and an equation number after the math) are joined regardless of gap if within 40% of page width.
      // Math fragments within 3em of each other (not crossing column gaps); an equation number after math within 40% of page width if at a column end.
      const mathRow =
        fragMath(model, prev) >= 0.4 &&
        ((fragMath(model, f) >= 0.4 && gap <= 3 * em) ||
          (atRowEnd && NUMBER_TAG.test(f.text) && gap <= 0.4 * pageWidth));
      if ((near && (ratio <= 1.5 || script)) || tag || mathRow || joinRow) parts.push(f);
      else {
        units.push(makeUnit(model, parts));
        parts = [f];
      }
    }
    units.push(makeUnit(model, parts));
  }
  return mergeMathClusters(model, absorbMinor(model, units), joinRow).sort(
    (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
  );
}

/**
 * Display math grouping: units with a math ratio of at least 40% (including subscript/superscript and fraction lines) and the equation number beside them are merged into one unit when their boxes touch after
 * being expanded by 1em. This keeps a display equation from becoming several pieces in region stacking and paragraph splitting.
 */
function mergeMathClusters(model: PageModel, units: Unit[], disabled: boolean): Unit[] {
  if (disabled) return units;
  const pageWidth = width(model.bounds);
  const isMath = units.map((u) => u.math >= 0.4);
  if (!isMath.some(Boolean)) return units;
  // An equation number beside math is also a grouping candidate.
  units.forEach((u, i) => {
    if (isMath[i] || !NUMBER_TAG.test(u.text)) return;
    if (units.some((v, j) => isMath[j] && sameRow(v.bbox, u.bbox) && u.bbox[0] >= v.bbox[2]))
      isMath[i] = true;
  });
  const idx = units.map((_, i) => i).filter((i) => isMath[i]);
  const parent = new Map(idx.map((i) => [i, i]));
  const find = (i: number): number => {
    let x = i;
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (let a = 0; a < idx.length; a++)
    for (let b = a + 1; b < idx.length; b++) {
      const u = units[idx[a]!]!;
      const v = units[idx[b]!]!;
      const em = Math.max(u.size, v.size);
      const gx = Math.max(u.full[0], v.full[0]) - Math.min(u.full[2], v.full[2]);
      const gy = Math.max(u.full[1], v.full[1]) - Math.min(u.full[3], v.full[3]);
      // An equation number is grouped even when far away if it is in the same row.
      // An equation number is grouped even when far away if it is in the same row and column (number to the right of the math, gap at most 35% of page width).
      const [eq, tag] = NUMBER_TAG.test(v.text)
        ? [u, v]
        : NUMBER_TAG.test(u.text)
          ? [v, u]
          : [null, null];
      const tagged =
        eq !== null &&
        tag !== null &&
        sameRow(eq.bbox, tag.bbox) &&
        tag.bbox[0] >= eq.bbox[2] - 1 &&
        tag.bbox[0] - eq.bbox[2] <= 0.35 * pageWidth;
      if ((gx <= 1.5 * em && gy <= 0.4 * em) || tagged) parent.set(find(idx[a]!), find(idx[b]!));
    }
  const groups = new Map<number, number[]>();
  for (const i of idx) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const merged = new Set<number>();
  const out: Unit[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const i of g) merged.add(i);
    const members = g.map((i) => units[i]!);
    const parts = members
      .flatMap((u) => u.parts)
      .sort((p, q) => p.baseline - q.baseline || p.bbox[0] - q.bbox[0]);
    const nu = makeUnit(model, parts);
    // The decision box, size and baseline come from the widest member (the math body).
    const main = members.reduce((m, u) => (u.bbox[2] - u.bbox[0] > m.bbox[2] - m.bbox[0] ? u : m));
    const full = members.reduce<Rect>((r, u) => union(r, u.full), members[0]!.full);
    out.push({
      ...nu,
      bbox: union(main.bbox, nu.bbox),
      size: main.size,
      baseline: main.baseline,
      full,
    });
  }
  return [...units.filter((_, i) => !merged.has(i)), ...out];
}

const visibleCount = (u: Unit): number => u.text.replace(/\s/gu, '').length;

/** Ratio of math-font or math-symbol characters in one fragment. */
function fragMath(model: PageModel, f: LineFeature): number {
  let n = 0;
  let m = 0;
  for (const ci of f.chars) {
    const ch = model.chars[ci]!;
    if (ch.text.trim() === '') continue;
    n++;
    if (MATH_FONT.test(model.fonts[ch.fontId]?.name ?? '') || MATH_CHAR.test(ch.text)) m++;
  }
  return n ? m / n : 0;
}

/**
 * Absorbs fragments with at most 3 visible characters (math subscripts, large operators, separately captured bullets) into the main unit that overlaps vertically and is horizontally close.
 * Absorbed fragments are included in the text and line list but do not change the layout decision box (bbox).
 */
function absorbMinor(model: PageModel, units: Unit[]): Unit[] {
  // Small fragment: at most 3 visible characters, or a fragment of at most 10 characters at 80% of body size or smaller (subscript group).
  const sizes = units.map((u) => u.size).sort((a, b) => a - b);
  const typical = sizes.length ? sizes[sizes.length >> 1]! : 10;
  // A unit made only of fragments with at most 3 characters each (large operators grouped into one row) is also a small fragment.
  const isMinor = (u: Unit) =>
    visibleCount(u) <= 3 ||
    (u.size <= 0.8 * typical && visibleCount(u) <= 10) ||
    (u.parts.length > 1 && u.parts.every((p) => p.text.replace(/\s/gu, '').length <= 3));
  const minor = units.filter(isMinor);
  if (minor.length === 0) return units;
  const major = units.filter((u) => !isMinor(u));
  const hosts = new Map<Unit, Unit[]>();
  const kept: Unit[] = [];
  for (const m of minor) {
    let best: Unit | null = null;
    let bestScore = -Infinity;
    for (const u of major) {
      const ov = overlapY(m.bbox, u.bbox);
      if (ov < 0.3 * Math.min(height(m.bbox), height(u.bbox))) continue;
      const gapX = Math.max(0, Math.max(m.bbox[0], u.bbox[0]) - Math.min(m.bbox[2], u.bbox[2]));
      if (gapX > 1.5 * u.size) continue;
      const score = ov / Math.max(height(m.bbox), 0.1) - gapX / (10 * u.size);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    if (best) hosts.set(best, [...(hosts.get(best) ?? []), m]);
    else kept.push(m);
  }
  const merged = major.map((u) => {
    const extra = hosts.get(u);
    if (!extra) return u;
    const parts = [...u.parts, ...extra.flatMap((m) => m.parts)].sort(
      (a, b) => a.bbox[0] - b.bbox[0],
    );
    const nu = makeUnit(model, parts);
    // The decision box, size and baseline come from the main unit.
    return { ...nu, bbox: u.bbox, size: u.size, baseline: u.baseline, full: nu.bbox };
  });
  return [...merged, ...kept];
}

/**
 * The horizontal gap between two fragments minus the length covered by inline images (glyph pictures, etc.) in the same row.
 * Hancom output embeds gugyeol and single-character glyphs as small images, splitting a line into several stext lines (measured 2026-10-19).
 */
function uncoveredGap(a: Rect, b: Rect, fillers: readonly Rect[], minCover: number): number {
  const lo = a[2];
  const hi = b[0];
  if (hi <= lo || fillers.length === 0) return hi - lo;
  const row: Rect = [lo, Math.min(a[1], b[1]), hi, Math.max(a[3], b[3])];
  const spans = fillers
    .filter(
      (r) =>
        r[2] > lo && r[0] < hi && overlapY(r, row) >= minCover * Math.min(height(r), height(row)),
    )
    .map((r) => [Math.max(r[0], lo), Math.min(r[2], hi)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let end = lo;
  for (const [s0, s1] of spans) {
    const st = Math.max(s0, end);
    if (s1 > st) covered += s1 - st;
    end = Math.max(end, s1);
  }
  return hi - lo - covered;
}

/** Inline image candidate: a small image whose height is at most 3x the font size. */
export function inlineImages(model: PageModel, size: number): Rect[] {
  return model.images
    .filter(
      (im) => im.op !== 'clip-image-mask' && height(im.bbox) <= 3 * size && height(im.bbox) > 0,
    )
    .map((im) => im.bbox);
}
