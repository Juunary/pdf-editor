/**
 * Table detection (contract section 3, step 3). Ruling-line strategy and alignment strategy.
 *
 * Ruling-line strategy (port of the PyMuPDF/pdfplumber `find_tables` lines strategy + text correction)
 *   1. Segments: rules (Rule) + the 4 edges of fill rectangles. Snap (3pt) → join (3pt) → drop under 3pt.
 *   2. Band closing: between pairs of horizontal lines with matching ends (booktabs top/mid/bottom rules, striped rows, tables without outer vertical lines)
 *      if the text in the band is laid out like a table, virtual vertical lines are added at both ends. Tables with only horizontal lines enter through this path.
 *   3. Intersections (3pt) → minimal cells (rectangles whose four corners are intersections and whose four edges are covered by segments) → groups of cells sharing corners
 *      = table candidate. Row/column boundaries = distinct values of cell edges.
 *   4. Text correction (finest grid): add projection gaps inside ruled columns as column boundaries, and split into baseline rows when several columns inside a ruled row
 *      share the same baseline (body without row rules).
 *   5. Keep conditions: at least 2 rows and 2 columns, at least 2 cells with text and at least 30%. Band tables without inner vertical rules additionally go through a text alignment
 *      check (multi-cell rows, not prose). Areas covered by complex shapes (charts) are discarded.
 * Alignment strategy (lines outside ruled tables)
 *   Baseline rows → runs of consecutive rows with two or more short fragments → projection gap columns → alignment, prose, numeric column and figure checks.
 * Fragment: a line's word boxes merged by gap threshold. Number lines that MuPDF filled with space characters (several columns in one line) are also
 *   split per column as fragments. Line assignment is per line (line box center; if spanning several cells, majority vote of character centers), and
 *   one line belongs to only one table and one cell.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import type { LineFeature } from './features.js';
import { C as RECON } from './constants.js';
import { GridIndex, median } from './geom.js';
import type { PathSummary } from './paths.js';

export interface DetectedCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: Rect;
  /** Lines in the cell (LineFeature.index = PageModel.lines index), top→bottom, left→right. */
  lines: number[];
}

export interface DetectedTable {
  bbox: Rect;
  /** rows+1 entries, top→bottom. */
  rowBounds: number[];
  /** cols+1 entries, left→right. */
  colBounds: number[];
  /** Covering cells only (a merged cell counts once). Empty cells are included. */
  cells: DetectedCell[];
  strategy: 'lines' | 'text';
  /** PageModel.paths indices used as table rules or background (excluded from figure detection). */
  paths: number[];
}

/**
 * Table detection constants (contract section 3, step 3). Lengths are in pt, *Em is a multiple of font size, *Ratio is a ratio.
 * Tuned only against the accuracy harness dev set, under the same rule as C in constants.ts.
 */
export const T = {
  // ── Ruling-line strategy ──
  /** Snap tolerance for segments on the same line. */
  snap: 3,
  /** Join gap for broken segments. */
  join: 3,
  /** Segments shorter than this are dropped. */
  minEdge: 3,
  /** Intersection tolerance. */
  intersect: 3,
  /** Cell boundaries within this distance are merged into one (prevents thin empty rows and columns). */
  minCell: 6,
  /** Fill rectangles dropped as page background (relative to page width/height). */
  pageBoxRatio: 0.9,
  /** Band closing: tolerance for matching horizontal line ends. */
  closeEnd: 6,
  /** Band closing: horizontal lines shorter than this are not used. */
  closeMinWidth: 30,
  /** Band closing: maximum height for closing a band without text. */
  closeEmptyMax: 20,
  /** Band closing: maximum height treated as a thin one- or two-row band (header row, section row) (number of rows × line height multiple). */
  thinBandRatio: 2.2,
  /** Fill rectangle edges parallel to a rule and within this distance (above snap) of it are treated as cell background margin and dropped. */
  boxInset: 8,
  /** If all fill color components are at least this value, the rectangle is treated as a white background and its edges are not used. */
  whiteBox: 0.97,
  /** Fragment merging (for column projection): a word gap below this multiple makes one fragment. The minimum column gap width is the same. */
  colGapEm: 0.8,
  /** Lower bound of the minimum column gap width. */
  colGapMin: 2,
  /** Ratio of rows allowed to cross a column gap (permits header cells spanning several columns). */
  colCrossRatio: 0.15,
  /** Text column boundaries in ruled tables: minimum number of rows with fragments on both sides of a gap. */
  gapSupport: 2,
  /** Ruled-row splitting: the median number of filled columns in baseline rows is at least this ratio of the number of columns with text in the row. */
  splitFillRatio: 0.6,
  /** Ruled-row splitting: tolerance between the baseline row median and a line's baseline (multiple of font size). */
  alignBaseEm: 0.25,
  /** Ruled-row splitting: lower bound of the ratio of lines whose baselines match. */
  alignBaseRatio: 0.8,
  /** Wrapped paragraph column (multi-line sentences in a cell): lower bound of the median fragment word count. */
  wrapWords: 3,
  /** Wrapped paragraph column: lower bound of the median fragment width / column width. */
  wrapFill: 0.6,
  /** Slack for detecting a line that crosses a cell boundary. */
  crossEps: 1,
  /** Table keep: minimum ratio of cells with text. */
  minFilledRatio: 0.3,
  /** Table keep: at least this ratio of rows with text (minimum 2 rows) must have two or more columns with text (rejects diagrams). */
  richColRatio: 0.3,
  /** Grid table keep: lower bound of the ratio of rows with two or more filled cells (relative to rows with text). */
  gridMultiRatio: 0.3,
  /** Band table keep: lower bound of the ratio of rows with two or more filled cells (relative to rows with text). */
  bandMultiRatio: 0.5,
  /** Prose column: lower bound of the median fragment word count. */
  proseWords: 5,
  /** Prose column: lower bound of the median fragment width / column width. */
  proseFill: 0.6,
  /** Chart: discarded if complex shapes (curves, diagonals) cover at least this ratio of the table box. */
  chartCover: 0.4,
  /** Band table extension: maximum baseline gap for attaching rows above/below (multiple of the median row gap). */
  extendPitchRatio: 1.6,
  // ── Alignment strategy ──
  /** Gap that splits fragments within one row (multiple of font size). */
  fragGapEm: 1.5,
  /** Upper bound of the word count of a short fragment (cell candidate). */
  shortWords: 6,
  /** Upper bound of the width of a short fragment (multiple of font size). */
  shortWidthEm: 18,
  /** Run linking: baseline gap is at most this multiple of the typical gap. */
  runPitchRatio: 2,
  /** Number of consecutive single-fragment rows allowed inside a run. */
  runSingles: 2,
  /** Alignment strategy: minimum number of multi-fragment rows, column-supporting rows and aligned fragments. */
  textMinRows: 3,
  /** Alignment tolerance (left, right, center). */
  alignTol: 2,
  /** Lower bound of the ratio of aligned columns. */
  alignRatio: 0.6,
  /** Prose rejection: upper bound of median fragment width / region width. */
  textMaxFragRatio: 0.3,
  /** Prose rejection: upper bound of the median fragment word count. */
  textMaxWords: 4,
  /** Two-column table: lower bound of the ratio of numeric fragments in the right column. */
  numericRatio: 0.6,
  /** Alignment strategy rejection: upper bound of graphics (vertical lines, shapes, narrow boxes) in the region. */
  textMaxGraphics: 4,
} as const;

// ───────────────────────── Common types ─────────────────────────

/** Line used for table classification (horizontal line with visible characters). */
interface TLine {
  f: LineFeature;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  size: number;
}

/** Character fragment within one row (an x range made by merging word boxes by gap). */
interface Frag {
  x0: number;
  x1: number;
  /** y center of the first word line (for cell fill checks). */
  cy: number;
  text: string;
  words: number;
  size: number;
}

/** Baseline row. */
interface Row {
  lines: TLine[];
  y0: number;
  y1: number;
  /** Reference box for the same-row check (the line with the most characters). */
  ref0: number;
  ref1: number;
  refChars: number;
}

interface Gap {
  x0: number;
  x1: number;
}

/** Cell of a table candidate (index in the finest grid). */
interface GridCell {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

interface Candidate {
  kind: 'grid' | 'band' | 'text';
  rowBounds: number[];
  colBounds: number[];
  cells: GridCell[];
  /** Line → cell index. */
  assign: Map<TLine, number>;
  paths: number[];
}

const NUMERIC_RE = /^[\s$€£¥₩+\-–—−(]*(?:\d[\d,.\s]*|\.\d+)[%)*]*$|^[\s.…–—-]+$|^n\/?a$/iu;
/** Symbols that cannot form a column alone (currency, signs). They attach to the numeric cell on the right. */
const SYMBOL_RE = /^[$€£¥₩+\-–—−±]$/u;

const centerIn = (l: TLine, x0: number, y0: number, x1: number, y1: number): boolean =>
  l.cx >= x0 && l.cx <= x1 && l.cy >= y0 && l.cy <= y1;

const fragCx = (f: Frag): number => (f.x0 + f.x1) / 2;

/** The cell of the sorted boundary array that v falls into (0..n-1; values outside are clamped to the end cells). */
function locate(bounds: readonly number[], v: number): number {
  let lo = 0;
  let hi = bounds.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function uniqSorted(xs: readonly number[], tol = 0.01): number[] {
  const s = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) if (out.length === 0 || x - out.at(-1)! > tol) out.push(x);
  return out;
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

// ───────────────────────── Lines, rows and fragments ─────────────────────────

function prepareLines(lines: readonly LineFeature[]): TLine[] {
  const out: TLine[] = [];
  for (const f of lines) {
    if (!f.horizontal || f.text.trim() === '') continue;
    const [x0, y0, x1, y1] = f.bbox;
    out.push({ f, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: f.size || y1 - y0 });
  }
  return out;
}

/**
 * Baseline row grouping: scans in y-center order and puts a line into a row if its vertical overlap with the reference box of either of the last two rows is at least
 * 50% of the shorter height. Lines within a row are in x order; rows are top→bottom.
 */
function clusterRows(ls: readonly TLine[]): Row[] {
  const sorted = [...ls].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const l of sorted) {
    const h = Math.max(l.y1 - l.y0, 0.1);
    let target: Row | null = null;
    for (let k = rows.length - 1; k >= Math.max(0, rows.length - 2); k--) {
      const r = rows[k]!;
      const ov = Math.min(r.ref1, l.y1) - Math.max(r.ref0, l.y0);
      if (ov >= 0.5 * Math.min(h, Math.max(r.ref1 - r.ref0, 0.1))) {
        target = r;
        break;
      }
    }
    if (!target) {
      const n = l.f.chars.length;
      rows.push({ lines: [l], y0: l.y0, y1: l.y1, ref0: l.y0, ref1: l.y1, refChars: n });
      continue;
    }
    target.lines.push(l);
    target.y0 = Math.min(target.y0, l.y0);
    target.y1 = Math.max(target.y1, l.y1);
    if (l.f.chars.length > target.refChars) {
      target.ref0 = l.y0;
      target.ref1 = l.y1;
      target.refChars = l.f.chars.length;
    }
  }
  for (const r of rows) r.lines.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
}

const rowBaseline = (r: Row): number => median(r.lines.map((l) => l.f.baseline));

/** Collects the word boxes of lines in x order and merges them into one fragment if the gap is below gapEm × font size. */
function fragsOf(lines: readonly TLine[], gapEm: number): Frag[] {
  const ws: Frag[] = [];
  for (const l of lines) {
    const boxes = l.f.words.length ? l.f.words : [{ x0: l.x0, x1: l.x1, text: l.f.text }];
    for (const w of boxes)
      if (w.text.trim() !== '')
        ws.push({ x0: w.x0, x1: w.x1, cy: l.cy, text: w.text.trim(), words: 1, size: l.size });
  }
  ws.sort((a, b) => a.x0 - b.x0);
  const out: Frag[] = [];
  for (const w of ws) {
    const cur = out.at(-1);
    if (cur && w.x0 - cur.x1 < gapEm * Math.max(cur.size, w.size)) {
      cur.x1 = Math.max(cur.x1, w.x1);
      cur.text = `${cur.text} ${w.text}`;
      cur.words += 1;
      cur.size = Math.max(cur.size, w.size);
    } else out.push({ ...w });
  }
  return out;
}

// ───────────────────────── Projection gaps (columns) ─────────────────────────

/**
 * Projects the per-row fragment x ranges to find inner gaps. A gap is (a) a range covered by no row, or (b) a range covered by at most
 * allowance rows whose fragments all extend beyond the range (header cells spanning several columns).
 * In (b), if a fragment is contained within the range (a sparsely filled column), it is not a gap. Gaps narrower than minWidth are dropped.
 */
function findGaps(rows: readonly Frag[][], minWidth: number, allowance: number): Gap[] {
  const empty = coverageGaps(rows, 0).filter((g) => g.x1 - g.x0 >= minWidth);
  if (allowance <= 0) return empty;
  const all = rows.flat();
  const bridged = coverageGaps(rows, allowance).filter(
    (g) =>
      g.x1 - g.x0 >= minWidth &&
      !empty.some((e) => e.x1 > g.x0 && e.x0 < g.x1) &&
      !all.some((f) => f.x0 >= g.x0 - 0.5 && f.x1 <= g.x1 + 0.5),
  );
  return [...empty, ...bridged].sort((a, b) => a.x0 - b.x0);
}

/** Inner x ranges (projection) covered by at most allowance rows of fragments. */
function coverageGaps(rows: readonly Frag[][], allowance: number): Gap[] {
  const ev: [number, number][] = [];
  for (const fr of rows) {
    const iv = fr.map((f) => [f.x0, f.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
    let cur: [number, number] | null = null;
    for (const [a, b] of iv) {
      if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else {
        if (cur) ev.push([cur[0], 1], [cur[1], -1]);
        cur = [a, b];
      }
    }
    if (cur) ev.push([cur[0], 1], [cur[1], -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: Gap[] = [];
  let cnt = 0;
  let prev = ev[0]?.[0] ?? 0;
  for (const [x, d] of ev) {
    if (x > prev && cnt <= allowance) {
      const last = gaps.at(-1);
      if (last && last.x1 >= prev) last.x1 = x;
      else gaps.push({ x0: prev, x1: x });
    }
    cnt += d;
    prev = x;
  }
  return gaps;
}

/** Number of rows with fragments on both sides of the gap (within lo..hi). */
function gapSupport(rows: readonly Frag[][], g: Gap, lo: number, hi: number): number {
  let n = 0;
  for (const fr of rows) {
    const left = fr.some((f) => f.x1 <= g.x0 + 0.5 && f.x0 >= lo - 0.5);
    const right = fr.some((f) => f.x0 >= g.x1 - 0.5 && f.x1 <= hi + 0.5);
    if (left && right) n++;
  }
  return n;
}

const minGapWidth = (size: number): number => Math.max(T.colGapMin, T.colGapEm * size);

// ───────────────────────── Column character ─────────────────────────

interface ColStat {
  frags: Frag[];
  /** Long sentence fragments (prose, wrapped paragraphs in cells). */
  prose: boolean;
  /** Ratio of numeric fragments. */
  numeric: number;
  /** Column containing only currency or sign symbols. */
  symbolOnly: boolean;
}

/** Assigns fragments to columns by center x and evaluates the character of each column. */
function columnStats(frags: readonly Frag[], cb: readonly number[]): ColStat[] {
  const cols: Frag[][] = cb.slice(1).map(() => []);
  for (const f of frags) cols[locate(cb, fragCx(f))]!.push(f);
  return cols.map((fs, k) => {
    const w = Math.max(cb[k + 1]! - cb[k]!, 1);
    const words = median(fs.map((f) => f.words));
    const fill = median(fs.map((f) => (f.x1 - f.x0) / w));
    return {
      frags: fs,
      prose: fs.length > 0 && words >= T.proseWords && fill >= T.proseFill,
      numeric: fs.length ? fs.filter((f) => NUMERIC_RE.test(f.text)).length / fs.length : 0,
      symbolOnly: fs.length > 0 && fs.every((f) => SYMBOL_RE.test(f.text)),
    };
  });
}

/** Removes a text column boundary if its left column has only currency or sign symbols (the symbol attaches to the numeric cell on the right). */
function mergeCurrencyCols(
  cb: readonly number[],
  frags: readonly Frag[],
  removable: (x: number) => boolean,
): number[] {
  const stats = columnStats(frags, cb);
  return cb.filter(
    (x, i) => !(i > 0 && i < cb.length - 1 && removable(x) && stats[i - 1]?.symbolOnly),
  );
}

// ───────────────────────── Line assignment ─────────────────────────

/** The grid cell a line falls into. A line crossing a boundary uses a majority vote of character centers. */
function gridPosOfLine(
  model: PageModel,
  l: TLine,
  rb: readonly number[],
  cb: readonly number[],
): [number, number] {
  const r = locate(rb, l.cy);
  const c = locate(cb, l.cx);
  const e = T.crossEps;
  if (l.x0 >= cb[c]! - e && l.x1 <= cb[c + 1]! + e && l.y0 >= rb[r]! - e && l.y1 <= rb[r + 1]! + e)
    return [r, c];
  const votes = new Map<number, number>();
  let best: [number, number] = [r, c];
  let bestN = 0;
  for (const ci of l.f.chars) {
    const ch = model.chars[ci];
    if (!ch || ch.text.trim() === '') continue;
    const q = ch.quad;
    const x = (Math.min(q[0], q[2], q[4], q[6]) + Math.max(q[0], q[2], q[4], q[6])) / 2;
    const y = (Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2;
    const rr = locate(rb, y);
    const cc = locate(cb, x);
    const key = rr * 100000 + cc;
    const n = (votes.get(key) ?? 0) + 1;
    votes.set(key, n);
    if (n > bestN) {
      bestN = n;
      best = [rr, cc];
    }
  }
  return best;
}

/** Grid cell → cell index table (-1 = empty cell). */
function ownerGrid(cells: readonly GridCell[], nr: number, nc: number): Int32Array {
  const own = new Int32Array(nr * nc).fill(-1);
  cells.forEach((c, i) => {
    for (let r = c.r; r < c.r + c.rs; r++)
      for (let k = c.c; k < c.c + c.cs; k++) own[r * nc + k] = i;
  });
  return own;
}

function assignLines(
  model: PageModel,
  ls: readonly TLine[],
  rb: readonly number[],
  cb: readonly number[],
  cells: readonly GridCell[],
): Map<TLine, number> {
  const nc = cb.length - 1;
  const own = ownerGrid(cells, rb.length - 1, nc);
  const out = new Map<TLine, number>();
  for (const l of ls) {
    const [r, c] = gridPosOfLine(model, l, rb, cb);
    const k = own[r * nc + c]!;
    if (k >= 0) out.set(l, k);
  }
  return out;
}

/** Fills grid cells not covered by any cell with 1×1 empty cells. */
function fillHoles(cells: GridCell[], nr: number, nc: number): void {
  const own = ownerGrid(cells, nr, nc);
  for (let r = 0; r < nr; r++)
    for (let c = 0; c < nc; c++) if (own[r * nc + c]! < 0) cells.push({ r, c, rs: 1, cs: 1 });
}

// ───────────────────────── Ruling-line strategy: segments ─────────────────────────

interface Edge {
  o: 'h' | 'v';
  /** h: y, v: x. */
  pos: number;
  /** h: x0..x1, v: y0..y1. */
  a0: number;
  a1: number;
  paths: number[];
  virt: boolean;
}

/** Collects rules and the 4 edges of fill rectangles as segments. Full-page background rectangles are excluded. */
function collectEdges(model: PageModel, ps: PathSummary): Edge[] {
  const pw = model.bounds[2] - model.bounds[0];
  const ph = model.bounds[3] - model.bounds[1];
  const out: Edge[] = [];
  const add = (o: 'h' | 'v', pos: number, a0: number, a1: number, path: number | null): void => {
    if (a1 - a0 >= 1) out.push({ o, pos, a0, a1, paths: path === null ? [] : [path], virt: false });
  };
  for (const r of ps.rules) {
    if (r.orient === 'h') add('h', r.y0, r.x0, r.x1, r.path);
    else add('v', r.x0, r.y0, r.y1, r.path);
  }
  // A thin image of thickness at most thinBoxMax is also a rule (some LaTeX output draws table rules as 1-pixel images).
  for (const im of model.images) {
    const [x0, y0, x1, y1] = im.bbox;
    if (y1 - y0 <= RECON.thinBoxMax && x1 - x0 > RECON.thinBoxMax)
      add('h', (y0 + y1) / 2, x0, x1, null);
    else if (x1 - x0 <= RECON.thinBoxMax && y1 - y0 > RECON.thinBoxMax)
      add('v', (x0 + x1) / 2, y0, y1, null);
  }
  // Fill rectangle edges: only visible edges are used. Dropped are (a) near-white rectangles, (b) edges whose immediately outer band is covered by a same-color rectangle
  // (backgrounds of the same color adjoining or overlapping), and (c) edges parallel to and just inside a rule (above snap, at most boxInset) (margin inside
  // a cell background). This keeps backgrounds drawn shrunk per cell from creating thin empty rows and columns.
  const hRules = out.filter((e) => e.o === 'h');
  const vRules = out.filter((e) => e.o === 'v');
  const insetOfRule = (rules: readonly Edge[], pos: number, a0: number, a1: number): boolean =>
    rules.some((r) => {
      const d = Math.abs(r.pos - pos);
      const cover = Math.min(r.a1, a1) - Math.max(r.a0, a0);
      return d > T.snap && d <= T.boxInset && cover >= 0.8 * (a1 - a0);
    });
  const boxes = ps.boxes.filter((b) => {
    const [x0, y0, x1, y1] = b.bbox;
    if (x1 - x0 >= T.pageBoxRatio * pw && y1 - y0 >= T.pageBoxRatio * ph) return false;
    return !(b.color && b.color.every((c) => c >= T.whiteBox));
  });
  // Per-color spatial index (even with thousands of same-color rectangles, only those near the sample points are checked).
  const byColor = new Map<string, { rects: Rect[]; index: GridIndex }>();
  for (const b of boxes) {
    const key = colorKey(b.color);
    let g = byColor.get(key);
    if (!g) {
      g = { rects: [], index: new GridIndex() };
      byColor.set(key, g);
    }
    g.index.insert(g.rects.length, b.bbox);
    g.rects.push(b.bbox);
  }
  for (const b of boxes) {
    const [x0, y0, x1, y1] = b.bbox;
    const same = b.color ? byColor.get(colorKey(b.color)) : undefined;
    // If all 5 sample points in the 1pt band outside the edge lie inside a same-color rectangle, the edge is invisible.
    const hidden = (pts: [number, number][]): boolean =>
      same !== undefined &&
      pts.every(([x, y]) =>
        same.index.query([x, y, x, y]).some((i) => {
          const r = same.rects[i]!;
          return r !== b.bbox && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
        }),
      );
    const along = (a0: number, a1: number): number[] =>
      [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => a0 + t * (a1 - a0));
    if (!insetOfRule(hRules, y0, x0, x1) && !hidden(along(x0, x1).map((x) => [x, y0 - 1])))
      add('h', y0, x0, x1, b.path);
    if (!insetOfRule(hRules, y1, x0, x1) && !hidden(along(x0, x1).map((x) => [x, y1 + 1])))
      add('h', y1, x0, x1, b.path);
    if (!insetOfRule(vRules, x0, y0, y1) && !hidden(along(y0, y1).map((y) => [x0 - 1, y])))
      add('v', x0, y0, y1, b.path);
    if (!insetOfRule(vRules, x1, y0, y1) && !hidden(along(y0, y1).map((y) => [x1 + 1, y])))
      add('v', x1, y0, y1, b.path);
  }
  return out;
}

/** Fill color comparison key (rounded to 0.02 units). An empty, non-unique key if the color is unknown. */
const colorKey = (c: readonly number[] | null): string =>
  c ? c.map((v) => Math.round(v * 50)).join(',') : '';

/** Aligns the positions of same-direction segments to the chained cluster average within tol (pdfplumber snap_edges). */
function snapEdges(es: readonly Edge[], tol: number): void {
  const s = [...es].sort((a, b) => a.pos - b.pos);
  let i = 0;
  while (i < s.length) {
    let j = i + 1;
    while (j < s.length && s[j]!.pos - s[j - 1]!.pos <= tol) j++;
    let sum = 0;
    for (let k = i; k < j; k++) sum += s[k]!.pos;
    for (let k = i; k < j; k++) s[k]!.pos = sum / (j - i);
    i = j;
  }
}

/** Joins same-position segments when the gap is at most tol, and drops those shorter than minLen (pdfplumber join_edge_group). */
function joinEdges(es: readonly Edge[], tol: number, minLen: number): Edge[] {
  const byPos = new Map<number, Edge[]>();
  for (const e of es) pushTo(byPos, e.pos, e);
  const out: Edge[] = [];
  for (const g of byPos.values()) {
    g.sort((a, b) => a.a0 - b.a0);
    let cur: Edge | null = null;
    for (const e of g) {
      if (cur && e.a0 <= cur.a1 + tol) {
        cur.a1 = Math.max(cur.a1, e.a1);
        cur.paths.push(...e.paths);
        cur.virt = cur.virt && e.virt;
      } else {
        if (cur) out.push(cur);
        cur = { ...e, paths: [...e.paths] };
      }
    }
    if (cur) out.push(cur);
  }
  return out.filter((e) => e.a1 - e.a0 >= minLen);
}

/**
 * Whether the text in a band is laid out like table rows (band closing check). An empty band closes only when thin; a thin one- or two-row band (header row, section row)
 * closes as is; any other band closes when column gaps are supported by two or more rows and not every column is prose.
 */
function bandLooksTabular(
  ls: readonly TLine[],
  x0: number,
  x1: number,
  top: number,
  bottom: number,
): boolean {
  const inBand = ls.filter((l) => centerIn(l, x0, top, x1, bottom));
  if (inBand.length === 0) return bottom - top <= T.closeEmptyMax;
  const rows = clusterRows(inBand);
  const size = median(inBand.map((l) => l.size));
  const lineH = median(inBand.map((l) => l.y1 - l.y0));
  if (rows.length <= 2 && bottom - top <= T.thinBandRatio * rows.length * lineH) return true;
  const frs = rows.map((r) => fragsOf(r.lines, T.colGapEm));
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * rows.length)).filter(
    (g) => gapSupport(frs, g, x0, x1) >= T.gapSupport,
  );
  if (gaps.length === 0) return false;
  const cb = [x0, ...gaps.map((g) => (g.x0 + g.x1) / 2), x1];
  const stats = columnStats(frs.flat(), cb).filter((s) => s.frags.length > 0);
  return !stats.every((s) => s.prose);
}

/**
 * Band closing: groups long horizontal lines with matching ends and, if the band between a vertically adjacent pair looks like a table,
 * creates virtual vertical lines at both ends.
 */
function closeBands(h: readonly Edge[], ls: readonly TLine[]): Edge[] {
  const long = h.filter((e) => e.a1 - e.a0 >= T.closeMinWidth);
  const parent = long.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < long.length; i++)
    for (let j = i + 1; j < long.length; j++) {
      const a = long[i]!;
      const b = long[j]!;
      if (Math.abs(a.a0 - b.a0) <= T.closeEnd && Math.abs(a.a1 - b.a1) <= T.closeEnd)
        parent[find(i)] = find(j);
    }
  const groups = new Map<number, Edge[]>();
  long.forEach((e, i) => pushTo(groups, find(i), e));
  const out: Edge[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.pos - b.pos);
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1]!;
      const b = g[i]!;
      if (b.pos - a.pos <= T.snap) continue;
      // If the ends differ slightly, the line is placed at the inner end (so it intersects both horizontal lines).
      const x0 = Math.max(a.a0, b.a0);
      const x1 = Math.min(a.a1, b.a1);
      if (!bandLooksTabular(ls, x0, x1, a.pos, b.pos)) continue;
      out.push(
        { o: 'v', pos: x0, a0: a.pos, a1: b.pos, paths: [], virt: true },
        { o: 'v', pos: x1, a0: a.pos, a1: b.pos, paths: [], virt: true },
      );
    }
  }
  return out;
}

// ───────────────────────── Ruling-line strategy: intersections and cells ─────────────────────────

interface Pt {
  x: number;
  y: number;
  /** Indices of the horizontal and vertical segments passing through. */
  h: Set<number>;
  v: Set<number>;
}

const ptKey = (x: number, y: number): string => `${x}|${y}`;

/** Intersections of vertical and horizontal segments (tolerance tol). The key is (vertical line x, horizontal line y). */
function intersections(h: readonly Edge[], v: readonly Edge[], tol: number): Map<string, Pt> {
  const hs = h.map((e, i) => ({ e, i })).sort((a, b) => a.e.pos - b.e.pos);
  const pts = new Map<string, Pt>();
  v.forEach((ve, vi) => {
    // Selects only horizontal lines whose y is within [a0 - tol, a1 + tol] using binary search.
    let lo = 0;
    let hi = hs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid]!.e.pos < ve.a0 - tol) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < hs.length && hs[k]!.e.pos <= ve.a1 + tol; k++) {
      const { e: he, i: hIdx } = hs[k]!;
      if (ve.pos < he.a0 - tol || ve.pos > he.a1 + tol) continue;
      const key = ptKey(ve.pos, he.pos);
      let p = pts.get(key);
      if (!p) {
        p = { x: ve.pos, y: he.pos, h: new Set(), v: new Set() };
        pts.set(key, p);
      }
      p.h.add(hIdx);
      p.v.add(vi);
    }
  });
  return pts;
}

const shares = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Minimal cells (pdfplumber intersections_to_cells): for each intersection, examines the intersections below and to the right in order of proximity,
 * taking the first rectangle whose left and top edges are covered by segments and whose bottom-right intersection connects via the right and bottom edges.
 */
function findCells(pts: ReadonlyMap<string, Pt>): Rect[] {
  const byX = new Map<number, Pt[]>();
  const byY = new Map<number, Pt[]>();
  for (const p of pts.values()) {
    pushTo(byX, p.x, p);
    pushTo(byY, p.y, p);
  }
  for (const g of byX.values()) g.sort((a, b) => a.y - b.y);
  for (const g of byY.values()) g.sort((a, b) => a.x - b.x);
  const cells: Rect[] = [];
  for (const p of pts.values()) {
    const below = byX.get(p.x)!.filter((q) => q.y > p.y);
    const right = byY.get(p.y)!.filter((q) => q.x > p.x);
    search: for (const b of below) {
      if (!shares(p.v, b.v)) continue;
      for (const r of right) {
        if (!shares(p.h, r.h)) continue;
        const br = pts.get(ptKey(r.x, b.y));
        if (br && shares(br.v, r.v) && shares(br.h, b.h)) {
          cells.push([p.x, p.y, r.x, b.y]);
          break search;
        }
      }
    }
  }
  return cells;
}

/** Groups cells that share corners (pdfplumber cells_to_tables). */
function groupCells(cells: readonly Rect[]): Rect[][] {
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const corner = new Map<string, number>();
  cells.forEach((c, i) => {
    for (const k of [ptKey(c[0], c[1]), ptKey(c[2], c[1]), ptKey(c[0], c[3]), ptKey(c[2], c[3])]) {
      const j = corner.get(k);
      if (j === undefined) corner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Rect[]>();
  cells.forEach((c, i) => pushTo(groups, find(i), c));
  return [...groups.values()];
}

// ───────────────────────── Ruling-line strategy: table candidates ─────────────────────────

interface BuildCtx {
  model: PageModel;
  free: readonly TLine[];
  ps: PathSummary;
}

/**
 * Removing thin gaps: cell boundary values within minCell of each other (misaligned background rectangles, double lines) are merged into one value, and
 * cells that lose their area are dropped.
 */
function collapseSlivers(group: readonly Rect[]): Rect[] {
  const snapMap = (vals: number[]): Map<number, number> => {
    const u = uniqSorted(vals);
    const m = new Map<number, number>();
    let start = 0;
    for (let i = 1; i <= u.length; i++) {
      if (i < u.length && u[i]! - u[i - 1]! <= T.minCell) continue;
      const rep = u[(start + i - 1) >> 1]!;
      for (let k = start; k < i; k++) m.set(u[k]!, rep);
      start = i;
    }
    return m;
  };
  const mx = snapMap(group.flatMap((c) => [c[0], c[2]]));
  const my = snapMap(group.flatMap((c) => [c[1], c[3]]));
  const out = new Map<string, Rect>();
  for (const c of group) {
    const r: Rect = [mx.get(c[0])!, my.get(c[1])!, mx.get(c[2])!, my.get(c[3])!];
    if (r[2] > r[0] && r[3] > r[1]) out.set(r.join(','), r);
  }
  return [...out.values()];
}

/** Maps ruled cells to ruled grid indices. Overlapping cells claim positions smallest first. */
function ruledCells(
  group: readonly Rect[],
  R0: readonly number[],
  C0: readonly number[],
): GridCell[] {
  const nc0 = C0.length - 1;
  const occ = new Uint8Array((R0.length - 1) * nc0);
  const area = (c: Rect): number => (c[2] - c[0]) * (c[3] - c[1]);
  const out: GridCell[] = [];
  for (const c of [...group].sort((a, b) => area(a) - area(b))) {
    const r = R0.indexOf(c[1]);
    const rs = R0.indexOf(c[3]) - r;
    const k = C0.indexOf(c[0]);
    const cs = C0.indexOf(c[2]) - k;
    let free = true;
    for (let i = r; i < r + rs && free; i++)
      for (let j = k; j < k + cs; j++) if (occ[i * nc0 + j]) free = false;
    if (!free) continue;
    for (let i = r; i < r + rs; i++) for (let j = k; j < k + cs; j++) occ[i * nc0 + j] = 1;
    out.push({ r, c: k, rs, cs });
  }
  return out;
}

/** Text column boundaries: among projection gaps inside a ruled column, those where at least gapSupport rows have fragments on both sides within the same ruled column. */
function textColumnBounds(frs: readonly Frag[][], C0: readonly number[], size: number): number[] {
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * frs.length));
  const out: number[] = [];
  for (const g of gaps) {
    if (C0.some((x) => x >= g.x0 - T.snap && x <= g.x1 + T.snap)) continue;
    const k = locate(C0, (g.x0 + g.x1) / 2);
    if (gapSupport(frs, g, C0[k]!, C0[k + 1]!) >= T.gapSupport) out.push((g.x0 + g.x1) / 2);
  }
  return out;
}

/**
 * Whether to split one ruled row into baseline rows: at least two baseline rows, at least two baseline rows with two or more filled columns, and the median
 * number of filled columns at least splitFillRatio of the number of columns with text in the row (a record row). Do not split if at least half of the multi-line columns are wrapped paragraphs
 * (long sentences in cells), if line baselines disagree with the baseline rows (vertically centered header), or if the top ruled row of the table has no numeric fragments
 * (multi-line column titles). When splitting, returns the y values between baseline rows.
 */
function rowSplits(
  subs: readonly Row[],
  C: readonly number[],
  top: number,
  bottom: number,
  isTopRow: boolean,
): number[] {
  if (subs.length < 2) return [];
  const subFr = subs.map((s) => fragsOf(s.lines, T.colGapEm));
  if (isTopRow && !subFr.flat().some((f) => NUMERIC_RE.test(f.text))) return [];
  const occ = subFr.map((fr) => new Set(fr.map((f) => locate(C, fragCx(f)))).size);
  const nonEmpty = new Set(subFr.flat().map((f) => locate(C, fragCx(f)))).size;
  const multi = occ.filter((n) => n >= 2).length;
  if (multi < 2 || median(occ) < Math.max(2, T.splitFillRatio * nonEmpty)) return [];
  const byCol = new Map<number, Frag[]>();
  for (const f of subFr.flat()) pushTo(byCol, locate(C, fragCx(f)), f);
  let multiLine = 0;
  let wrapped = 0;
  for (const [k, fs] of byCol) {
    if (fs.length < 2) continue;
    multiLine++;
    const w = Math.max(C[k + 1]! - C[k]!, 1);
    const words = median(fs.map((f) => f.words));
    const fill = median(fs.map((f) => (f.x1 - f.x0) / w));
    if (words >= T.wrapWords && fill >= T.wrapFill) wrapped++;
  }
  if (multiLine > 0 && wrapped * 2 >= multiLine) return [];
  // Baseline alignment: a line's baseline must be within alignBaseEm × font size of the median of its own baseline row. Rows misaligned by half a line, like vertically centered
  // multi-line header cells, are not record rows.
  const lines = subs.flatMap((sr) => sr.lines.map((l) => [l, rowBaseline(sr)] as const));
  const aligned = lines.filter(([l, b]) => Math.abs(l.f.baseline - b) <= T.alignBaseEm * l.size);
  if (aligned.length < T.alignBaseRatio * lines.length) return [];
  // Continuation lines: a baseline row with text in only one column other than the first text column holds the remaining lines of a multi-line cell, so it is attached to the neighboring row whose baseline is
  // closer.
  const groups = subs.map((sr, i) => ({
    y0: sr.y0,
    y1: sr.y1,
    base: rowBaseline(sr),
    cols: new Set(subFr[i]!.map((f) => locate(C, fragCx(f)))),
  }));
  const firstCol = Math.min(...groups.flatMap((g) => [...g.cols]));
  for (let i = 0; i < groups.length && groups.length > 1;) {
    const g = groups[i]!;
    if (g.cols.size !== 1 || g.cols.has(firstCol)) {
      i++;
      continue;
    }
    const up = groups[i - 1];
    const dn = groups[i + 1];
    const target = !up ? dn! : !dn ? up : g.base - up.base <= dn.base - g.base ? up : dn;
    target.y0 = Math.min(target.y0, g.y0);
    target.y1 = Math.max(target.y1, g.y1);
    for (const c of g.cols) target.cols.add(c);
    groups.splice(i, 1);
    i = Math.max(0, i - 1);
  }
  const seps: number[] = [];
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1]!;
    const b = groups[i]!;
    const y = b.y0 >= a.y1 ? (a.y1 + b.y0) / 2 : (a.base + b.y0) / 2;
    if (y > top && y < bottom && (seps.length === 0 || y > seps.at(-1)!)) seps.push(y);
  }
  return seps;
}

/**
 * Emits ruled cell pieces (rectangles of the finest grid) as cells. If content fragments span two or more columns, the cell is split at boundaries that no line crosses
 * (striped rows, body without row rules). If the content occupies only one column or is empty, the merged cell is kept as is.
 */
function emitPiece(
  out: GridCell[],
  ls: readonly TLine[],
  R: readonly number[],
  C: readonly number[],
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): void {
  if (c1 - c0 === 1) {
    out.push({ r: r0, c: c0, rs: r1 - r0, cs: 1 });
    return;
  }
  const inPiece = ls.filter((l) => centerIn(l, C[c0]!, R[r0]!, C[c1]!, R[r1]!));
  const used = new Set(fragsOf(inPiece, T.colGapEm).map((f) => locate(C, fragCx(f))));
  if (used.size < 2) {
    out.push({ r: r0, c: c0, rs: r1 - r0, cs: c1 - c0 });
    return;
  }
  let start = c0;
  for (let k = c0 + 1; k <= c1; k++) {
    const x = C[k]!;
    const crossed = k < c1 && inPiece.some((l) => l.x0 < x - T.crossEps && l.x1 > x + T.crossEps);
    if (k === c1 || !crossed) {
      out.push({ r: r0, c: start, rs: r1 - r0, cs: k - start });
      start = k;
    }
  }
}

/**
 * Builds one cell group into a table candidate. Ruled grid → add text column boundaries → split ruled rows → cells (keep merges / split)
 * → line assignment → keep-condition check. virtCols holds the x positions of virtual vertical lines (for band table classification).
 */
function buildLinesTable(
  ctx: BuildCtx,
  group: readonly Rect[],
  virtCols: ReadonlySet<number>,
): Candidate | null {
  // If any inner vertical boundary has a real line, it is a grid table; otherwise a band table (virtual edges only).
  const interiorReal = uniqSorted(group.flatMap((c) => [c[0], c[2]]))
    .slice(1, -1)
    .some((x) => !virtCols.has(x));
  group = collapseSlivers(group);
  const R0 = uniqSorted(group.flatMap((c) => [c[1], c[3]]));
  const C0 = uniqSorted(group.flatMap((c) => [c[0], c[2]]));
  const bbox: Rect = [C0[0]!, R0[0]!, C0.at(-1)!, R0.at(-1)!];
  const ls = ctx.free.filter((l) => centerIn(l, ...bbox));
  if (ls.length === 0) return null;
  const ruled = ruledCells(group, R0, C0);

  // 1) Columns: ruled column boundaries + text column boundaries (currency and sign symbol columns attach to the right).
  const rowsAll = clusterRows(ls);
  const frsAll = rowsAll.map((r) => fragsOf(r.lines, T.colGapEm));
  const textBounds = new Set(textColumnBounds(frsAll, C0, median(ls.map((l) => l.size))));
  const C = mergeCurrencyCols(uniqSorted([...C0, ...textBounds]), frsAll.flat(), (x) =>
    textBounds.has(x),
  );

  // 2) Rows: ruled row boundaries + baseline row boundaries of ruled rows split into record rows.
  const splitRows = new Map<number, number[]>();
  for (let r = 0; r < R0.length - 1; r++) {
    const subs = clusterRows(ls.filter((l) => l.cy >= R0[r]! && l.cy < R0[r + 1]!));
    const seps = rowSplits(subs, C, R0[r]!, R0[r + 1]!, r === 0);
    if (seps.length) splitRows.set(r, seps);
  }
  const R = uniqSorted([...R0, ...[...splitRows.values()].flat()]);

  // 3) Cells: maps ruled cells onto the finer grid. One-row cells of a split ruled row are emitted separately per baseline row.
  const cells: GridCell[] = [];
  for (const rc of ruled) {
    const r0 = R.indexOf(R0[rc.r]!);
    const r1 = R.indexOf(R0[rc.r + rc.rs]!);
    const c0 = C.indexOf(C0[rc.c]!);
    const c1 = C.indexOf(C0[rc.c + rc.cs]!);
    if (rc.rs === 1 && splitRows.has(rc.r))
      for (let r = r0; r < r1; r++) emitPiece(cells, ls, R, C, r, r + 1, c0, c1);
    else emitPiece(cells, ls, R, C, r0, r1, c0, c1);
  }
  fillHoles(cells, R.length - 1, C.length - 1);

  // 4) Keep conditions: size, ratio of cells with text, rows with two or more filled cells (grid 30%, band 50%), band tables not prose, not a chart.
  if (R.length < 3 || C.length < 3) return null;
  const assign = assignLines(ctx.model, ls, R, C, cells);
  const fill = cellFill(cells, R, C, frsAll.flat(), assign);
  if (fill.filled < 2 || fill.filled < T.minFilledRatio * cells.length) return null;
  const kind: Candidate['kind'] = R0.length >= 3 && interiorReal ? 'grid' : 'band';
  const multiMin = kind === 'grid' ? T.gridMultiRatio : T.bandMultiRatio;
  if (fill.multiRows < 2 || fill.multiRows < multiMin * fill.textRows) return null;
  if (fill.richCols < 2) return null;
  if (
    kind === 'band' &&
    columnStats(frsAll.flat(), C).every((s) => s.frags.length === 0 || s.prose)
  )
    return null;
  if (chartCovered(ctx.ps, bbox)) return null;
  return { kind, rowBounds: R, colBounds: C, cells, assign, paths: pathsInside(ctx.ps, bbox) };
}

/**
 * Cell filling: cells with assigned lines + cells containing fragment centers (the case where one line spans several cells, like a number line filled with spaces).
 * filled = number of cells with text, textRows = number of rows with text, multiRows = number of rows with two or more filled cells,
 * richCols = number of columns with text in at least richColRatio of the rows with text (minimum 2 rows).
 */
function cellFill(
  cells: readonly GridCell[],
  R: readonly number[],
  C: readonly number[],
  frags: readonly Frag[],
  assign: ReadonlyMap<TLine, number>,
): { filled: number; textRows: number; multiRows: number; richCols: number } {
  const nc = C.length - 1;
  const own = ownerGrid(cells, R.length - 1, nc);
  const filled = new Set<number>();
  const perRow = new Map<number, Set<number>>();
  const perCol = new Map<number, Set<number>>();
  const mark = (r: number, k: number): void => {
    if (k < 0) return;
    filled.add(k);
    const set = perRow.get(r) ?? new Set<number>();
    set.add(k);
    perRow.set(r, set);
    const c = cells[k]!.c;
    const rows = perCol.get(c) ?? new Set<number>();
    rows.add(r);
    perCol.set(c, rows);
  };
  for (const [l, k] of assign) mark(locate(R, l.cy), k);
  for (const f of frags) {
    const r = locate(R, f.cy);
    mark(r, own[r * nc + locate(C, fragCx(f))]!);
  }
  const multiRows = [...perRow.values()].filter((x) => x.size >= 2).length;
  const richMin = Math.max(2, T.richColRatio * perRow.size);
  const richCols = [...perCol.values()].filter((x) => x.size >= richMin).length;
  return { filled: filled.size, textRows: perRow.size, multiRows, richCols };
}

/** Whether complex shape (curve, diagonal) boxes cover at least chartCover of the region (16×16 cell approximation). */
function chartCovered(ps: PathSummary, r: Rect): boolean {
  const shapes = ps.shapes.filter(
    (s) =>
      s.complex && s.bbox[2] > r[0] && s.bbox[0] < r[2] && s.bbox[3] > r[1] && s.bbox[1] < r[3],
  );
  if (shapes.length === 0) return false;
  const N = 16;
  const w = (r[2] - r[0]) / N;
  const h = (r[3] - r[1]) / N;
  let covered = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = r[0] + (i + 0.5) * w;
      const y = r[1] + (j + 0.5) * h;
      if (shapes.some((s) => x >= s.bbox[0] && x <= s.bbox[2] && y >= s.bbox[1] && y <= s.bbox[3]))
        covered++;
    }
  return covered >= T.chartCover * N * N;
}

/** Rule and fill rectangle paths inside the table box (rule slack snap). */
function pathsInside(ps: PathSummary, r: Rect): number[] {
  const tol = T.snap;
  const inside = (x0: number, y0: number, x1: number, y1: number): boolean =>
    x0 >= r[0] - tol && y0 >= r[1] - tol && x1 <= r[2] + tol && y1 <= r[3] + tol;
  const out = new Set<number>();
  for (const e of ps.rules) if (inside(e.x0, e.y0, e.x1, e.y1)) out.add(e.path);
  for (const b of ps.boxes) if (inside(...b.bbox)) out.add(b.path);
  return [...out].sort((a, b) => a - b);
}

/**
 * Band table extension: if the rows directly above/below a band table closed by virtual edges (striped, booktabs) fill two or more columns within the table x range
 * and the baseline gap is at most extendPitchRatio × the table row gap, they are attached as rows (header and end rows without stripes).
 */
function extendBand(ctx: BuildCtx, cand: Candidate, taken: ReadonlySet<TLine>): void {
  const C = cand.colBounds;
  const tol = T.snap;
  const pool = ctx.free.filter(
    (l) => !taken.has(l) && !cand.assign.has(l) && l.x0 >= C[0]! - tol && l.x1 <= C.at(-1)! + tol,
  );
  const rows = clusterRows(pool);
  const tableRows = (): Row[] => clusterRows([...cand.assign.keys()]);
  const tr = tableRows();
  const pitch = median(tr.slice(1).map((r, i) => rowBaseline(r) - rowBaseline(tr[i]!)));
  if (!(pitch > 0)) return;
  const fits = (r: Row): boolean =>
    new Set(fragsOf(r.lines, T.colGapEm).map((f) => locate(C, fragCx(f)))).size >= 2;
  const addRow = (r: Row, top: boolean): void => {
    const R = cand.rowBounds;
    let row: number;
    if (top) {
      cand.rowBounds = [Math.min(r.y0, R[0]! - 0.5), ...R];
      for (const c of cand.cells) c.r += 1;
      row = 0;
    } else {
      cand.rowBounds = [...R, Math.max(r.y1, R.at(-1)! + 0.5)];
      row = R.length - 1;
    }
    const base = cand.cells.length;
    for (let k = 0; k < C.length - 1; k++) cand.cells.push({ r: row, c: k, rs: 1, cs: 1 });
    for (const l of r.lines) cand.assign.set(l, base + locate(C, l.cx));
  };
  for (;;) {
    const first = tableRows()[0]!;
    const above = rows.filter((r) => r.y1 <= cand.rowBounds[0]! + 1).at(-1);
    if (!above || above.lines.some((l) => cand.assign.has(l))) break;
    if (rowBaseline(first) - rowBaseline(above) > T.extendPitchRatio * pitch || !fits(above)) break;
    addRow(above, true);
  }
  for (;;) {
    const last = tableRows().at(-1)!;
    const below = rows.find((r) => r.y0 >= cand.rowBounds.at(-1)! - 1);
    if (!below || below.lines.some((l) => cand.assign.has(l))) break;
    if (rowBaseline(below) - rowBaseline(last) > T.extendPitchRatio * pitch || !fits(below)) break;
    addRow(below, false);
  }
}

/** Whole ruling-line strategy: segments → band closing → intersections → cells → groups → candidates. */
function linesStrategy(ctx: BuildCtx): Candidate[] {
  const raw = collectEdges(ctx.model, ctx.ps);
  const hRaw = raw.filter((e) => e.o === 'h');
  const vRaw = raw.filter((e) => e.o === 'v');
  snapEdges(hRaw, T.snap);
  snapEdges(vRaw, T.snap);
  const h = joinEdges(hRaw, T.join, T.minEdge);
  const vAll = [...joinEdges(vRaw, T.join, T.minEdge), ...closeBands(h, ctx.free)];
  snapEdges(vAll, T.snap);
  const v = joinEdges(vAll, T.join, T.minEdge);
  if (h.length < 2 || v.length < 2) return [];
  // x positions crossed only by virtual vertical lines (those connected to real lines count as real).
  const virtCols = new Set(v.filter((e) => e.virt).map((e) => e.pos));
  for (const e of v) if (!e.virt) virtCols.delete(e.pos);
  const groups = groupCells(findCells(intersections(h, v, T.intersect)));
  const out: Candidate[] = [];
  for (const g of groups) {
    const C0 = uniqSorted(g.flatMap((c) => [c[0], c[2]]));
    // A 1×1 box whose four edges are real lines (text box, page border) is not a table. Virtual-edge bands are judged by text correction.
    if (g.length === 1 && !C0.some((x) => virtCols.has(x))) continue;
    const cand = buildLinesTable(ctx, g, virtCols);
    if (cand) out.push(cand);
  }
  return out;
}

// ───────────────────────── Alignment strategy ─────────────────────────

const isShort = (f: Frag): boolean =>
  f.words <= T.shortWords && f.x1 - f.x0 <= T.shortWidthEm * f.size;

/**
 * Alignment strategy: finds runs of consecutive baseline rows of the remaining lines that have two or more short fragments (multi-fragment rows),
 * builds columns (projection gaps) and rows (baselines) from the lines in the run, then checks them.
 */
function textStrategy(
  ctx: BuildCtx,
  taken: ReadonlySet<TLine>,
  accepted: readonly Rect[],
): Candidate[] {
  const rows = clusterRows(ctx.free.filter((l) => !taken.has(l)));
  const shorts = rows.map((r) => fragsOf(r.lines, T.fragGapEm).filter(isShort));
  const multi = shorts.map((s) => s.length >= 2);
  const out: Candidate[] = [];
  const used = new Set<TLine>();
  const boxes = [...accepted];
  let i = 0;
  while (i < rows.length) {
    if (!multi[i]) {
      i++;
      continue;
    }
    // Run linking: baseline gap is at most runPitchRatio × the typical gap, with up to runSingles consecutive single-fragment rows.
    const run = [i];
    const pitches: number[] = [];
    let singles = 0;
    let j = i + 1;
    for (; j < rows.length; j++) {
      const d = rowBaseline(rows[j]!) - rowBaseline(rows[run.at(-1)!]!);
      const size = median(rows[j]!.lines.map((l) => l.size));
      const typical = Math.max(pitches.length ? median(pitches) : 0, 1.2 * size);
      if (d > T.runPitchRatio * typical) break;
      if (multi[j]) singles = 0;
      else if (++singles > T.runSingles) break;
      run.push(j);
      pitches.push(d);
    }
    while (run.length && !multi[run.at(-1)!]) run.pop();
    i = Math.max(j, i + 1);
    const multiRuns = run.filter((k) => multi[k]);
    if (multiRuns.length < T.textMinRows) continue;
    const cand = buildTextTable(
      ctx,
      run.map((k) => rows[k]!),
      multiRuns.flatMap((k) => shorts[k]!),
      used,
    );
    if (!cand) continue;
    const bb = candBBox(cand);
    if (boxes.some((b) => overlapFrac(bb, b) > 0.2)) continue;
    boxes.push(bb);
    for (const l of cand.assign.keys()) used.add(l);
    out.push(cand);
  }
  return out;
}

function buildTextTable(
  ctx: BuildCtx,
  runRows: readonly Row[],
  shortFrags: readonly Frag[],
  used: ReadonlySet<TLine>,
): Candidate | null {
  // Region x range: the short fragments of multi-fragment rows. Only run lines whose center lies within it are used.
  const rx0 = Math.min(...shortFrags.map((f) => f.x0));
  const rx1 = Math.max(...shortFrags.map((f) => f.x1));
  const ls = runRows
    .flatMap((r) => r.lines)
    .filter((l) => !used.has(l) && l.cx >= rx0 - 1 && l.cx <= rx1 + 1);
  const rows = clusterRows(ls);
  if (rows.length < T.textMinRows) return null;
  const frs = rows.map((r) => fragsOf(r.lines, T.fragGapEm));
  const allFr = frs.flat();
  const size = median(ls.map((l) => l.size));
  const bx0 = Math.min(...ls.map((l) => l.x0));
  const bx1 = Math.max(...ls.map((l) => l.x1));

  // Prose rejection: fragments are wide relative to the region or have many words (two-column body, lists).
  const width = Math.max(bx1 - bx0, 1);
  if (median(allFr.map((f) => (f.x1 - f.x0) / width)) > T.textMaxFragRatio) return null;
  if (median(allFr.map((f) => f.words)) > T.textMaxWords) return null;

  // Columns: projection gaps with fragments on both sides in at least textMinRows rows. Currency and sign symbol columns attach to the right.
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * rows.length)).filter(
    (g) => gapSupport(frs, g, bx0, bx1) >= T.textMinRows,
  );
  const C = mergeCurrencyCols([bx0, ...gaps.map((g) => (g.x0 + g.x1) / 2), bx1], allFr, () => true);
  const nc = C.length - 1;
  const stats = columnStats(allFr, C);
  if (nc < 2) return null;
  if (nc === 2 && stats[1]!.numeric < T.numericRatio) return null;

  // Alignment: in each column, at least textMinRows fragments must cluster within alignTol on one of left, right or center.
  const aligned = stats.filter(
    (s) => alignedCount(s.frags) >= Math.min(T.textMinRows, Math.max(s.frags.length, 1)),
  ).length;
  if (aligned < 2 || aligned < T.alignRatio * nc) return null;

  // Rows: baseline rows. At least textMinRows rows with two or more filled cells.
  const R = rowBoundsOf(rows);
  const cells: GridCell[] = [];
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < nc; c++) cells.push({ r, c, rs: 1, cs: 1 });
  const assign = assignLines(ctx.model, ls, R, C, cells);
  const perRow = new Map<number, Set<number>>();
  for (const k of assign.values()) {
    const c = cells[k]!;
    const s = perRow.get(c.r) ?? new Set<number>();
    s.add(c.c);
    perRow.set(c.r, s);
  }
  if ([...perRow.values()].filter((s) => s.size >= 2).length < T.textMinRows) return null;

  const bbox: Rect = [C[0]!, R[0]!, C.at(-1)!, R.at(-1)!];
  if (chartCovered(ctx.ps, bbox)) return null;
  if (graphicsCount(ctx.ps, bbox) > T.textMaxGraphics) return null;
  return {
    kind: 'text',
    rowBounds: R,
    colBounds: C,
    cells,
    assign,
    paths: pathsInside(ctx.ps, bbox),
  };
}

/** Number of fragments that cluster most within alignTol among left, right and center edges. */
function alignedCount(fs: readonly Frag[]): number {
  let best = 0;
  for (const key of [(f: Frag) => f.x0, (f: Frag) => f.x1, fragCx]) {
    const xs = fs.map(key).sort((a, b) => a - b);
    let lo = 0;
    for (let hi = 0; hi < xs.length; hi++) {
      while (xs[hi]! - xs[lo]! > T.alignTol) lo++;
      best = Math.max(best, hi - lo + 1);
    }
  }
  return best;
}

/** Baseline row boundaries: top and bottom are the text outline, in between is the middle of the gap between neighboring row boxes. */
function rowBoundsOf(rows: readonly Row[]): number[] {
  const R = [rows[0]!.y0];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const y = b.y0 >= a.y1 ? (a.y1 + b.y0) / 2 : (rowBaseline(a) + b.y0) / 2;
    R.push(Math.max(y, R.at(-1)! + 0.01));
  }
  R.push(Math.max(rows.at(-1)!.y1, R.at(-1)! + 0.01));
  return R;
}

/** Number of graphics in an alignment-strategy region: vertical lines, shapes, fill boxes under 80% of the region width (excluding stripes). */
function graphicsCount(ps: PathSummary, r: Rect): number {
  const inside = (b: Rect): boolean =>
    b[0] >= r[0] - 1 && b[1] >= r[1] - 1 && b[2] <= r[2] + 1 && b[3] <= r[3] + 1;
  const w = r[2] - r[0];
  const vPaths = new Set<number>();
  for (const e of ps.rules)
    if (e.orient === 'v' && inside([e.x0, e.y0, e.x1, e.y1])) vPaths.add(e.path);
  let n = vPaths.size;
  for (const s of ps.shapes) if (inside(s.bbox)) n++;
  for (const b of ps.boxes) if (inside(b.bbox) && b.bbox[2] - b.bbox[0] < 0.8 * w) n++;
  return n;
}

// ───────────────────────── Wrap-up ─────────────────────────

const candBBox = (c: Candidate): Rect => [
  c.colBounds[0]!,
  c.rowBounds[0]!,
  c.colBounds.at(-1)!,
  c.rowBounds.at(-1)!,
];

/** Ratio of a's area that overlaps b. */
function overlapFrac(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max((a[2] - a[0]) * (a[3] - a[1]), 1e-6);
}

function toDetected(c: Candidate): DetectedTable {
  const R = c.rowBounds;
  const C = c.colBounds;
  const linesOf = new Map<number, TLine[]>();
  for (const [l, k] of c.assign) pushTo(linesOf, k, l);
  const cells: DetectedCell[] = c.cells
    .map((g, k) => ({
      row: g.r,
      col: g.c,
      rowSpan: g.rs,
      colSpan: g.cs,
      bbox: [C[g.c]!, R[g.r]!, C[g.c + g.cs]!, R[g.r + g.rs]!] as Rect,
      lines: (linesOf.get(k) ?? [])
        .sort((a, b) => a.f.baseline - b.f.baseline || a.x0 - b.x0)
        .map((l) => l.f.index),
    }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    bbox: candBBox(c),
    rowBounds: R,
    colBounds: C,
    cells,
    strategy: c.kind === 'text' ? 'text' : 'lines',
    paths: c.paths,
  };
}

/**
 * Finds tables. The cell lines of the returned tables do not overlap (a line belongs to at most one cell).
 * Only horizontal lines are passed in `lines`.
 */
export function detectTables(
  model: PageModel,
  lines: readonly LineFeature[],
  paths: PathSummary,
): DetectedTable[] {
  const ctx: BuildCtx = { model, free: prepareLines(lines), ps: paths };
  // 1) Ruling-line strategy: grid tables then band tables, and within a kind, tables with more cells first. A candidate overlapping an accepted table by more than 20% is discarded.
  const order = { grid: 0, band: 1, text: 2 } as const;
  const cands = linesStrategy(ctx).sort(
    (a, b) => order[a.kind] - order[b.kind] || b.cells.length - a.cells.length,
  );
  const accepted: Candidate[] = [];
  const taken = new Set<TLine>();
  for (const c of cands) {
    const bb = candBBox(c);
    if (
      accepted.some((a) => overlapFrac(bb, candBBox(a)) > 0.2 || overlapFrac(candBBox(a), bb) > 0.2)
    )
      continue;
    for (const l of [...c.assign.keys()]) if (taken.has(l)) c.assign.delete(l);
    if (c.kind === 'band') extendBand(ctx, c, taken);
    for (const l of c.assign.keys()) taken.add(l);
    accepted.push(c);
  }
  // 2) Alignment strategy: lines outside ruled tables.
  accepted.push(...textStrategy(ctx, taken, accepted.map(candBBox)));
  const byIndex = new Map(lines.map((f) => [f.index, f]));
  return dedupeTables(
    accepted
      .map(toDetected)
      .map((t) => normalizeTable(t, byIndex))
      .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]),
  );
}

// ── Post-processing (cleanup against the label grid) ──────────────────────────────────────

/** Grid cell → cell index. */
function gridOf(t: DetectedTable): number[][] {
  const rows = t.rowBounds.length - 1;
  const cols = t.colBounds.length - 1;
  const g = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  t.cells.forEach((c, k) => {
    for (let r = c.row; r < c.row + c.rowSpan; r++)
      for (let q = c.col; q < c.col + c.colSpan; q++) if (g[r]) g[r]![q] = k;
  });
  return g;
}

/** Rebuilds cells from the grid cell assignment (cells with the same index are assumed to form a rectangle). */
function rebuild(
  t: DetectedTable,
  g: number[][],
  rowBounds: number[],
  colBounds: number[],
  lines: (k: number) => number[],
): DetectedTable {
  const seen = new Map<number, DetectedCell>();
  const cells: DetectedCell[] = [];
  g.forEach((row, r) =>
    row.forEach((k, q) => {
      const key = k < 0 ? -1 - (r * 10_000 + q) : k;
      const cur = seen.get(key);
      if (cur) {
        cur.rowSpan = Math.max(cur.rowSpan, r - cur.row + 1);
        cur.colSpan = Math.max(cur.colSpan, q - cur.col + 1);
        return;
      }
      const cell: DetectedCell = {
        row: r,
        col: q,
        rowSpan: 1,
        colSpan: 1,
        bbox: [0, 0, 0, 0],
        lines: k < 0 ? [] : lines(k),
      };
      seen.set(key, cell);
      cells.push(cell);
    }),
  );
  for (const c of cells)
    c.bbox = [
      colBounds[c.col]!,
      rowBounds[c.row]!,
      colBounds[c.col + c.colSpan]!,
      rowBounds[c.row + c.rowSpan]!,
    ];
  return {
    ...t,
    rowBounds,
    colBounds,
    cells,
    bbox: [colBounds[0]!, rowBounds[0]!, colBounds.at(-1)!, rowBounds.at(-1)!],
  };
}

/**
 * 1) Top and bottom rows consisting of "a single cell spanning all columns" (title band or note band inside the frame) are removed from the table (labels treat them as captions or footnotes).
 * 2) Merging wrapped row titles: if the row after a row filled only in the first column indents its first-column line by at least 0.5em, and the previous line fills at least 60% of the first column width
 *    and does not end with ':' or '.', the two rows are merged.
 * 3) Removes column boundaries that no row places text on both sides of, with a single cell spanning across (boundaries created by text projection).
 */
function normalizeTable(t: DetectedTable, byIndex: Map<number, LineFeature>): DetectedTable {
  let g = gridOf(t);
  let rowBounds = t.rowBounds.slice();
  let colBounds = t.colBounds.slice();
  const cellLines = (k: number) => t.cells[k]?.lines ?? [];
  const merged = new Map<number, number[]>(); // merged cell index → lines
  const linesOf = (k: number) => merged.get(k) ?? cellLines(k);
  const fullSpan = (row: number[]) => row.every((k) => k === row[0]) && row[0]! >= 0;
  // 1) Title and note bands.
  while (g.length > 3 && fullSpan(g[0]!)) {
    g = g.slice(1);
    rowBounds = rowBounds.slice(1);
  }
  while (g.length > 3 && fullSpan(g.at(-1)!) && g.at(-2)!.some((k, q) => k !== g.at(-1)![q])) {
    g = g.slice(0, -1);
    rowBounds = rowBounds.slice(0, -1);
  }
  // 2) Wrapped row titles.
  const filled = (k: number) => k >= 0 && linesOf(k).length > 0;
  for (let r = 0; r + 1 < g.length; r++) {
    const a = g[r]!;
    const b = g[r + 1]!;
    const onlyFirst = a.every((k, q) => q === 0 || k === a[0] || !filled(k));
    if (!onlyFirst || !filled(a[0]!) || !filled(b[0]!) || a[0] === b[0]) continue;
    if (!b.some((k, q) => q > 0 && k !== b[0] && filled(k))) continue;
    const la = linesOf(a[0]!)
      .map((i) => byIndex.get(i))
      .filter((f) => f !== undefined);
    const lb = linesOf(b[0]!)
      .map((i) => byIndex.get(i))
      .filter((f) => f !== undefined);
    if (!la.length || !lb.length) continue;
    const last = la.at(-1)!;
    const first = lb[0]!;
    const col0Right = colBounds[1]!;
    const col0W = col0Right - colBounds[0]!;
    const indented = first.bbox[0] >= Math.min(...la.map((f) => f.bbox[0])) + 0.5 * first.size;
    const fills = last.bbox[2] - colBounds[0]! >= 0.6 * col0W;
    if (!indented || !fills || /[:.]\s*$/u.test(last.text)) continue;
    // If a's first-column cell also spans other rows (merged cell), do not merge (prevents a line from ending up in two cells).
    const spansOther = g.some((row, i) => i !== r && row.includes(a[0]!));
    if (spansOther || g.some((row, i) => i !== r + 1 && row.includes(b[0]!))) continue;
    // Merge a's first-column cell into b's first-column cell, leave the rest of b's cells as they are, and make the two rows one.
    const keep = b[0]!;
    merged.set(keep, [...linesOf(a[0]!), ...linesOf(keep)]);
    const row = b.slice();
    row[0] = keep;
    g = [...g.slice(0, r), row, ...g.slice(r + 2)];
    rowBounds = [...rowBounds.slice(0, r + 1), ...rowBounds.slice(r + 2)];
    r--;
  }
  // 3) Column boundaries with only spanning cells.
  for (let q = 0; q + 1 < (g[0]?.length ?? 0); q++) {
    const distinguishes = g.some(
      (row) => row[q] !== row[q + 1] && filled(row[q]!) && filled(row[q + 1]!),
    );
    const spanned = g.some((row) => row[q] === row[q + 1] && filled(row[q]!));
    if (distinguishes || !spanned) continue;
    g = g.map((row) => {
      const keep = filled(row[q]!) ? row[q]! : row[q + 1]!;
      return [...row.slice(0, q), keep, ...row.slice(q + 2)];
    });
    colBounds = [...colBounds.slice(0, q + 1), ...colBounds.slice(q + 2)];
    q--;
  }
  if (
    g.length === t.rowBounds.length - 1 &&
    colBounds.length === t.colBounds.length &&
    merged.size === 0
  )
    return t;
  return rebuild(t, g, rowBounds, colBounds, linesOf);
}

/**
 * A line belongs to at most one cell (contract 2.1). If post-processing or combining several candidates puts the same line into two cells, only the earlier cell keeps it.
 * Tables with fewer than 2 cells that retain lines are discarded (keep conditions are rechecked after removing lines and rows).
 */
function dedupeTables(tables: DetectedTable[]): DetectedTable[] {
  const used = new Set<number>();
  const out: DetectedTable[] = [];
  for (const t of tables) {
    const cells = t.cells.map((c) => {
      const lines = c.lines.filter((l) => !used.has(l));
      for (const l of lines) used.add(l);
      return lines.length === c.lines.length ? c : { ...c, lines };
    });
    if (cells.filter((c) => c.lines.length > 0).length < 2) {
      for (const c of cells) for (const l of c.lines) used.delete(l);
      continue;
    }
    out.push({ ...t, cells });
  }
  return out;
}
