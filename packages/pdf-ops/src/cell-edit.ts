/**
 * Table cell edit target (M4, docs/m4-contract.md 4.1, D1, D5). Pure computation that does not read the document.
 *
 * - Target: one cell = one edit unit (D1). All paragraphs in the cell are handled as a single paragraph joined in reading order.
 * - Line joining: between lines in a cell (within and between paragraphs) is a space for an automatic wrap, otherwise "\n". Automatic wrap = the first word of the next line
 *   would not fit in the inner cell width after the previous line. Between paragraphs, a space only when the baseline gap equals the previous paragraph's line spacing (±10%).
 *   This check is used instead of the contract's "the previous line fills to within 1em of the cell's right edge": number lines stacked with right alignment
 *   would be joined by spaces and laid out again, which moves their positions (corpus measurement, docs/m4-pdf-ops.md contract mismatch 2).
 * - Cell box: for a ruled table, the layout cell box. For an alignment-strategy table, the outer columns/rows are widened by half the neighbor gap (1em if none), and up to the table box
 *   if the table box is larger (D5).
 * - Margin: per side min(gap between original characters and the boundary, 2pt). Area limit (areaLimit) = (cell box − margin) ∪ original character box (so that, in a cell where the original characters
 *   stick out of the cell box, the same text does not become an overflow, docs/m4-pdf-ops.md contract mismatch 3).
 * - Start area: vertically the character box, horizontally cell box − margin. But for the aligned side (left edge for left alignment, both sides equally for center),
 *   the original character gap is used as is so that characters do not move on a same-text commit (contract 1.1 position preservation ≤ 0.5pt,
 *   docs/m4-pdf-ops.md contract mismatch 1).
 * - Alignment: for a ruled table, compare left/right gaps in the cell (difference < 1pt is center, a smaller right gap is right, otherwise left). For an alignment-strategy table,
 *   the key with the smallest spread of x0, x1 and center of the character boxes in the same column (cells without merging) (when there are 2 or more cells, otherwise gap comparison).
 */
import { offsetMap } from './text-map.js';
import type {
  LayoutParagraph,
  LayoutTable,
  PageLayout,
  PageModel,
  ParagraphAlign,
  Rect,
  StyleRun,
  TableCell,
} from '@pdf-editor/shared-types';

export interface CellTarget {
  table: LayoutTable;
  cell: TableCell;
  /** Cell box (D5; the widened box for an alignment-strategy table). */
  box: Rect;
  /** (cell box − margin (per side min(gap, 2pt))) ∪ original character box = area limit. */
  limit: Rect;
  /** Horizontal extent of the start area (original gap on the aligned side). */
  areaX: [number, number];
  align: ParagraphAlign;
  /** Line spacing: the first paragraph's value, otherwise the median of cell line baseline gaps (null for a single line). */
  lineHeight: number | null;
  /** Paragraph that joins the cell paragraphs (id = first cell paragraph id). */
  paragraph: LayoutParagraph;
  /** All cell paragraph ids. */
  members: Set<number>;
}

const MARGIN = 2;

const unionRect = (a: Rect | null, b: Rect): Rect =>
  a
    ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
    : [...b];

/** Cell containing the paragraph (null if it is not a table cell paragraph or the cell is not found). */
export function cellOfParagraph(
  layout: PageLayout,
  paragraphId: number,
): { table: LayoutTable; cell: TableCell } | null {
  const p = layout.paragraphs.find((q) => q.id === paragraphId);
  if (!p || p.table === null) return null;
  const table = layout.tables.find((t) => t.id === p.table);
  const cell = table?.cells.find((c) => c.paragraphs.includes(paragraphId));
  return table && cell ? { table, cell } : null;
}

/** Union of line boxes (visible character lines). */
function linesBox(model: PageModel, lines: readonly number[]): Rect | null {
  let r: Rect | null = null;
  for (const li of lines) {
    const l = model.lines[li];
    if (l) r = unionRect(r, l.bbox);
  }
  return r;
}

/** Cell box of an alignment-strategy table: outer columns/rows are widened to half the neighbor gap (or to the table box). */
function textCellBox(model: PageModel, table: LayoutTable, cell: TableCell): Rect {
  const box: Rect = [...cell.bbox];
  const textOf = (c: TableCell) => linesBox(model, c.lines);
  // Minimum of the character gap between columns and the character gap between rows.
  const gaps = (axis: 0 | 1): number[] => {
    const n = axis === 0 ? table.cols : table.rows;
    const out: number[] = [];
    for (let k = 0; k + 1 < n; k++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (const c of table.cells) {
        const t = textOf(c);
        if (!t) continue;
        const start = axis === 0 ? c.col : c.row;
        const span = axis === 0 ? c.colSpan : c.rowSpan;
        if (start + span - 1 === k) hi = Math.max(hi, t[axis + 2]!);
        if (start === k + 1) lo = Math.min(lo, t[axis]!);
      }
      if (Number.isFinite(hi) && Number.isFinite(lo) && lo > hi) out.push(lo - hi);
    }
    return out;
  };
  const size = (() => {
    const l = model.lines[cell.lines[0] ?? -1];
    const ch = l ? model.chars[l.chars[0] ?? -1] : undefined;
    return ch?.size ?? 10;
  })();
  const half = (g: number[]) => (g.length > 0 ? Math.min(...g) / 2 : size);
  const hx = half(gaps(0));
  const hy = half(gaps(1));
  if (cell.col === 0) box[0] = Math.min(box[0] - hx, table.bbox[0]);
  if (cell.col + cell.colSpan === table.cols) box[2] = Math.max(box[2] + hx, table.bbox[2]);
  if (cell.row === 0) box[1] = Math.min(box[1] - hy, table.bbox[1]);
  if (cell.row + cell.rowSpan === table.rows) box[3] = Math.max(box[3] + hy, table.bbox[3]);
  return box;
}

/** Column alignment key of an alignment-strategy table. null if it cannot be determined. */
function columnAlign(model: PageModel, table: LayoutTable, col: number): ParagraphAlign | null {
  const boxes = table.cells
    .filter((c) => c.col === col && c.colSpan === 1)
    .map((c) => linesBox(model, c.lines))
    .filter((b): b is Rect => b !== null);
  if (boxes.length < 2) return null;
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const s = [
    spread(boxes.map((b) => b[0])),
    spread(boxes.map((b) => b[2])),
    spread(boxes.map((b) => (b[0] + b[2]) / 2)),
  ];
  const best = Math.min(...s);
  if (s[0] === best) return 'left';
  if (s[1] === best) return 'right';
  return 'center';
}

function gapAlign(text: Rect, box: Rect): ParagraphAlign {
  const l = text[0] - box[0];
  const r = box[2] - text[2];
  if (Math.abs(l - r) < 1) return 'center';
  return r < l ? 'right' : 'left';
}

/**
 * Whether the line break at the end of the previous line is an automatic wrap: if the first word of the next line (+ 0.25em space) did not fit in the inner cell width after the previous line, it is an
 * automatic wrap (join with a space); if it fit, a forced break ("\n"). Also classifies short lines stacked with right/center alignment (number columns, etc.).
 */
function wrapped(model: PageModel, prev: number, next: number, innerWidth: number): boolean {
  const a = model.lines[prev];
  const b = model.lines[next];
  if (!a || !b) return false;
  const visible = b.chars.map((i) => model.chars[i]!);
  const start = visible.findIndex((c) => c.text.trim() !== '');
  if (start < 0) return false;
  let end = start;
  while (end + 1 < visible.length && visible[end + 1]!.text.trim() !== '') end++;
  const qx = (q: readonly number[]) => [Math.min(q[0]!, q[4]!), Math.max(q[2]!, q[6]!)] as const;
  const word = qx(visible[end]!.quad)[1] - qx(visible[start]!.quad)[0];
  const size = visible[start]!.size || 10;
  const width = a.bbox[2] - a.bbox[0];
  return width + 0.25 * size + word > innerWidth - 0.5;
}

/** Text where, among spaces between lines in a paragraph, those to be treated as forced breaks are replaced with "\n" (length and character mapping unchanged). */
function lineBreaks(model: PageModel, p: LayoutParagraph, innerWidth: number): string {
  if (p.lines.length < 2) return p.text;
  const text = p.text;
  const map = offsetMap(p, model.chars);
  const lineAt = map.map((ci) => (ci >= 0 ? model.chars[ci]!.line : -2));
  const breaks: number[] = [];
  for (let k = 1; k < p.lines.length; k++) {
    const prev = p.lines[k - 1]!;
    const next = p.lines[k]!;
    const last = lineAt.lastIndexOf(prev);
    const first = lineAt.indexOf(next, last + 1);
    // Only when the line gap is a single space (leave it as is when joined by an end-of-line hyphen).
    if (last < 0 || first !== last + 2 || text[last + 1] !== ' ') continue;
    if (!wrapped(model, prev, next, innerWidth)) breaks.push(last + 1);
  }
  let out = text;
  for (const i of breaks) out = `${out.slice(0, i)}\n${out.slice(i + 1)}`;
  return out;
}

/** Joins cell paragraphs into one paragraph (D1). Between lines and between paragraphs: a space for an automatic wrap, otherwise "\n". */
function mergeParagraphs(
  model: PageModel,
  paras: readonly LayoutParagraph[],
  innerWidth: number,
): LayoutParagraph {
  const first = paras[0]!;
  if (paras.length === 1) return { ...first, text: lineBreaks(model, first, innerWidth) };
  let text = '';
  const chars: number[] = [];
  const lines: number[] = [];
  const styleRuns: StyleRun[] = [];
  let bbox: Rect | null = null;
  paras.forEach((p, k) => {
    if (k > 0) text += joiner(model, paras[k - 1]!, p, innerWidth);
    const off = chars.length;
    for (const r of p.styleRuns) styleRuns.push({ ...r, start: r.start + off, end: r.end + off });
    text += lineBreaks(model, p, innerWidth);
    chars.push(...p.chars);
    lines.push(...p.lines);
    bbox = unionRect(bbox, p.bbox);
  });
  return {
    ...first,
    bbox: bbox!,
    lines,
    chars,
    text,
    styleRuns,
    firstLineIndent: 0,
    continuesTo: null,
  };
}

/** Baseline y of the first visible character. */
function baselineOf(model: PageModel, line: number): number | null {
  const l = model.lines[line];
  const c = l?.chars.map((i) => model.chars[i]!).find((ch) => ch.text.trim() !== '');
  return c ? c.origin[1] : null;
}

/** Between paragraphs: a space if it is an automatic wrap and the baseline gap equals the previous paragraph's line spacing (±10%), otherwise "\n". */
function joiner(
  model: PageModel,
  prev: LayoutParagraph,
  next: LayoutParagraph,
  innerWidth: number,
): string {
  const lastLine = prev.lines.at(-1);
  const firstLine = next.lines[0];
  if (lastLine === undefined || firstLine === undefined) return '\n';
  const b0 = baselineOf(model, lastLine);
  const b1 = baselineOf(model, firstLine);
  const ref = prev.lineHeight ?? next.lineHeight;
  const pitch = b0 !== null && b1 !== null ? b1 - b0 : null;
  const sameLeading = ref !== null && pitch !== null && Math.abs(pitch - ref) <= 0.1 * ref;
  return sameLeading && wrapped(model, lastLine, firstLine, innerWidth) ? ' ' : '\n';
}

/** Horizontal range of the visible (non-whitespace) character boxes of the cell paragraphs. null if none. */
function inkSpan(model: PageModel, paras: readonly LayoutParagraph[]): [number, number] | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of paras) {
    for (const c of p.chars) {
      const ch = model.chars[c];
      if (!ch || ch.text.trim() === '') continue;
      const q = ch.quad;
      x0 = Math.min(x0, q[0], q[2], q[4], q[6]);
      x1 = Math.max(x1, q[0], q[2], q[4], q[6]);
    }
  }
  return x0 <= x1 ? [x0, x1] : null;
}

/** Cell target of paragraph paragraphId. null if it is not a table cell paragraph. */
export function cellTarget(
  model: PageModel,
  layout: PageLayout,
  paragraphId: number,
): CellTarget | null {
  const found = cellOfParagraph(layout, paragraphId);
  if (!found) return null;
  const { table, cell } = found;
  const paras = cell.paragraphs
    .map((id) => layout.paragraphs.find((p) => p.id === id))
    .filter((p): p is LayoutParagraph => p !== undefined);
  if (paras.length === 0) return null;
  const box =
    table.strategy === 'text' ? textCellBox(model, table, cell) : ([...cell.bbox] as Rect);
  let text: Rect | null = null;
  for (const p of paras) text = unionRect(text, p.bbox);
  const t = text!;
  const gap = [t[0] - box[0], t[1] - box[1], box[2] - t[2], box[3] - t[3]].map((g) =>
    Math.max(0, g),
  );
  const m = gap.map((g) => Math.min(g, MARGIN));
  // For a cell whose original characters stick out of the cell box (characters straddling a ruling line; cell assignment is by line center), merge the original
  // character box into the limit so the same text does not become an overflow.
  const limit = unionRect([box[0] + m[0]!, box[1] + m[1]!, box[2] - m[2]!, box[3] - m[3]!], t);
  const align =
    (table.strategy === 'text' && cell.colSpan === 1
      ? columnAlign(model, table, cell.col)
      : null) ?? gapAlign(t, box);
  // The aligned side uses the original gap (position preservation), the opposite side uses cell boundary − margin. The position of the aligned side is set from the horizontal range of the visible character ink:
  // the paragraph box covers even the trailing-space glyph at line end, so reflowed lines (excluding the trailing space) shift by half a space width for center alignment and
  // a full space width for right alignment (docs/m4-pdf-ops.md section 6 #7, fed-combined-finstmt-2025 page 8, 1.0pt). Alignment classification uses the paragraph box as is.
  const [i0, i1] = inkSpan(model, paras) ?? [t[0], t[2]];
  let areaX: [number, number];
  if (align === 'right') areaX = [limit[0], i1];
  else if (align === 'center') {
    const side = Math.min(i0 - limit[0], limit[2] - i1);
    areaX = [i0 - side, i1 + side];
  } else areaX = [i0, limit[2]];
  const paragraph = mergeParagraphs(model, paras, limit[2] - limit[0]);
  let lineHeight = paras[0]!.lineHeight;
  if (lineHeight === null) {
    const bases = paragraph.lines
      .map((li) => baselineOf(model, li))
      .filter((b): b is number => b !== null)
      .sort((a, b) => a - b);
    const pitches = bases
      .slice(1)
      .map((b, i) => b - bases[i]!)
      .filter((d) => d > 0.5);
    pitches.sort((a, b) => a - b);
    lineHeight = pitches.length > 0 ? pitches[Math.floor(pitches.length / 2)]! : null;
  }
  return {
    table,
    cell,
    box,
    limit,
    areaX,
    align,
    lineHeight,
    paragraph,
    members: new Set(paras.map((p) => p.id)),
  };
}
