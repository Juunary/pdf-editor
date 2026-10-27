import { describe, expect, it } from 'vitest';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';
import { reconstructPage } from '../src/reconstruct.js';
import { validateLayout as layoutViolations } from '../src/validate.js';
import { buildModel, gridPaths, type LineSpec, type ModelSpec } from './helpers/model-builder.js';

/** Contract 2.1 invariants (helpers/invariants). */
function checkInvariants(model: PageModel, layout: PageLayout): void {
  expect(layoutViolations(model, layout)).toEqual([]);
}

/** Fills a column of width w with lines of n characters (size 10, character width 5). */
function column(
  x: number,
  y0: number,
  texts: string[],
  pitch = 12,
  extra: Partial<LineSpec> = {},
): LineSpec[] {
  return texts.map((text, i) => ({ x, y: y0 + i * pitch, text, ...extra }));
}

const FULL = 'x'.repeat(60); // 300pt
const words = (n: number, w = 'word'): string => Array.from({ length: n }, () => w).join(' ');

describe('reconstructPage', () => {
  it('one column: heading, indented paragraph, line spacing, alignment', () => {
    const lines: LineSpec[] = [
      { x: 72, y: 100, text: 'Introduction', size: 14, bold: true },
      { x: 87, y: 130, text: words(11) + ' an' }, // first-line indent
      ...column(72, 142, [words(12), words(12), 'short end.']),
      { x: 87, y: 178, text: words(11) + ' an' },
      ...column(72, 190, [words(12), 'done here.']),
    ];
    const model = buildModel({ lines });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const flow = layout.paragraphs;
    expect(flow.map((p) => p.lines)).toEqual([[0], [1, 2, 3, 4], [5, 6, 7]]);
    expect(flow[0]!.role).toBe('heading');
    expect(flow[1]!.role).toBe('body');
    expect(flow[1]!.firstLineIndent).toBe(15);
    expect(flow[1]!.lineHeight).toBe(12);
    expect(flow[1]!.align).toBe('justify');
    expect(flow[1]!.text.startsWith('word word')).toBe(true);
    expect(flow[1]!.text).not.toContain('\n');
  });

  it('two columns + a heading spanning columns: reading order and column-overflow linking', () => {
    const left = column(50, 150, [words(9), words(9), words(9), words(9) + ' and']);
    const right = column(320, 150, ['continued ' + words(7), words(9), 'final line.']);
    const model = buildModel({
      lines: [
        { x: 150, y: 100, text: 'A Wide Title Over Both Columns', size: 18, bold: true },
        ...left,
        ...right,
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const order = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.lines);
    expect(order).toEqual([[0], [1, 2, 3, 4], [5, 6, 7]]);
    const [title, a, b] = layout.readingOrder.map((r) => layout.paragraphs[r.id]!);
    expect(title!.role).toBe('heading');
    expect(a!.column).not.toBe(b!.column);
    expect(a!.continuesTo).toBe(b!.id);
    expect(layout.columns.length).toBeGreaterThanOrEqual(2);
  });

  it('header/footer: running head in the top band, page number in the bottom band', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 40, text: 'Journal of Tests', size: 8 },
        { x: 500, y: 40, text: 'Vol. 3', size: 8 },
        ...column(72, 120, [FULL, FULL, 'end.']),
        { x: 300, y: 760, text: '12', size: 9 },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const roles = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.role);
    expect(roles).toEqual(['header', 'header', 'body', 'footer']);
  });

  it('bullet list: hanging-indent continuation and item boundaries', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: '• ' + words(11) },
        { x: 82, y: 112, text: words(5) },
        { x: 72, y: 124, text: '• ' + words(4) },
        { x: 72, y: 136, text: '• last item' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([[0, 1], [2], [3]]);
    expect(layout.paragraphs.every((p) => p.role === 'list-item')).toBe(true);
  });

  it('ragged item list: lines at the start of the region also judge line ends against the column width (W4-4)', () => {
    // Calendar-style list: date (bold) / event name (bold) / person in charge (bold) / venue. The local window of the first line in the region was truncated at the edge
    // and could not contain the long lines (6 and 8), so the right edge was estimated too low; there was a defect where the event-name line was seen as a "fully filled line" and the person-in-charge
    // line was joined to it.
    const b = { bold: true };
    const lines: LineSpec[] = [
      { x: 54, y: 100, text: 'May 14-16, 2024', ...b },
      { x: 54, y: 112, text: 'CERES Science Team Meeting', ...b },
      { x: 54, y: 124, text: 'POC: norman.g.loeb@nasa.gov', ...b },
      { x: 54, y: 136, text: 'Hampton, VA' },
      { x: 54, y: 156.6, text: 'June 3-6, 2024', ...b },
      { x: 54, y: 168.6, text: 'OMI-TROPOMI Science Team', ...b },
      { x: 54, y: 180.6, text: 'Pyeongchang-gun, Gangwon-do, South Korea' },
      { x: 54, y: 201.2, text: 'April 14-19, 2024', ...b },
      { x: 54, y: 213.2, text: 'European Geosciences Union (EGU) General Assembly', ...b },
      { x: 54, y: 225.2, text: 'Vienna, Austria' },
    ];
    const model = buildModel({ lines });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual(lines.map((_, i) => [i]));
  });

  it('merges superscript fragments and table-of-contents page numbers into the same line', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: words(10) },
        { x: 72 + 49 * 5, y: 96, text: '[1]', size: 6 },
        { x: 72, y: 112, text: words(6) + ' end.' },
        { x: 72, y: 150, text: '1.1' },
        { x: 100, y: 150, text: 'Methods . . . . . . . . . .' },
        { x: 400, y: 150, text: '12' },
        { x: 72, y: 165, text: '1.2' },
        { x: 100, y: 165, text: 'Results . . . . . . . . . .' },
        { x: 400, y: 165, text: '15' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const ps = layout.paragraphs.map((p) => p.lines.slice().sort((a, b) => a - b));
    expect(ps).toContainEqual([0, 1, 2]);
    expect(ps).toContainEqual([3, 4, 5]);
    expect(ps).toContainEqual([6, 7, 8]);
  });

  it('figure: a label over an image is a figure label, a caption below is a caption paragraph', () => {
    const model = buildModel({
      lines: [
        ...column(72, 100, [FULL, 'end.']),
        { x: 150, y: 250, text: 'axis', size: 7 },
        { x: 72, y: 420, text: 'Figure 1. A test figure.' },
      ],
      images: [[100, 150, 400, 400]],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.figures).toHaveLength(1);
    const fig = layout.figures[0]!;
    expect(fig.labels.map((p) => layout.paragraphs[p]!.lines)).toEqual([[2]]);
    const caption = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(caption.role).toBe('caption');
    const kinds = layout.readingOrder.map((r) => r.kind);
    expect(kinds).toEqual(['paragraph', 'figure', 'paragraph']);
  });

  it('shape runs: a bold word in between yields 3 runs', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: 'plain ' },
        { x: 102, y: 100, text: 'bold', bold: true },
        { x: 122, y: 100, text: ' tail end.' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs).toHaveLength(1);
    const runs = layout.paragraphs[0]!.styleRuns;
    expect(runs.map((r) => r.bold)).toEqual([false, true, false]);
  });

  it('empty page', () => {
    const model = buildModel({});
    const layout = reconstructPage(model);
    expect(layout.paragraphs).toEqual([]);
    expect(layout.readingOrder).toEqual([]);
  });
});

describe('header/footer repeated on neighboring pages', () => {
  it('running heads and page numbers at the same position on neighboring pages are header/footer even without the margin band and gap conditions', () => {
    // The running head is close to the body (small gap) and the page number is outside the 9% band (at 89% of page height).
    const page = (n: number) =>
      buildModel({
        lines: [
          { x: 72, y: 84, text: 'A Running Head Title' },
          ...column(72, 98, [FULL, FULL, 'end.']),
          { x: 300, y: 712, text: `Page ${n}` },
        ],
      });
    const model = page(6);
    const alone = reconstructPage(model);
    expect(alone.paragraphs.filter((p) => p.role === 'header' || p.role === 'footer')).toHaveLength(
      0,
    );
    const layout = reconstructPage(model, { neighbors: [page(5), page(7)] });
    checkInvariants(model, layout);
    const roles = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.role);
    expect(roles[0]).toBe('header');
    expect(roles.at(-1)).toBe('footer');
  });
});

describe('fixedGroups (edit block as one paragraph, docs/m3-integration.md 9.6)', () => {
  // Edit block lines: a short line after a forced line break + wide word gaps of a justified line (one line becomes two fragments).
  const blockLines = (): LineSpec[] => [
    { x: 72, y: 100, text: 'Short line one.' },
    { x: 72, y: 112, text: 'Short line two.' },
    { x: 72, y: 124, text: words(5) },
    { x: 222, y: 124, text: words(5) }, // same row, 50pt gap from the previous fragment
    { x: 72, y: 136, text: 'last line.' },
  ];

  it('block lines that used to be split become one paragraph (lines top→bottom, including same-row fragments)', () => {
    const model = buildModel({ lines: blockLines() });
    const plain = reconstructPage(model);
    checkInvariants(model, plain);
    expect(plain.paragraphs.length).toBeGreaterThan(1);
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2, 3, 4]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs).toHaveLength(1);
    const p = layout.paragraphs[0]!;
    expect(p.lines).toEqual([0, 1, 2, 3, 4]);
    expect(p.role).toBe('body');
    expect(p.column).toBe(0);
    expect(p.lineHeight).toBe(12);
    expect(p.bbox[0]).toBe(72);
    expect(p.text.startsWith('Short line one. Short line two.')).toBe(true);
    expect(layout.readingOrder).toEqual([{ kind: 'paragraph', id: 0 }]);
  });

  it('top→bottom regardless of the given line order', () => {
    const model = buildModel({ lines: blockLines() });
    const layout = reconstructPage(model, { fixedGroups: [[4, 2, 0, 3, 1]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([[0, 1, 2, 3, 4]]);
  });

  it('a block that used to merge with neighboring paragraph lines is separated', () => {
    // The block (lines 0–2) and the neighboring paragraph directly below (lines 3–5) have the same line spacing and shape, so M2 treats them as one paragraph.
    const model = buildModel({
      lines: column(72, 100, [words(12), words(12), words(12), words(12), words(12), 'end.']),
    });
    const plain = reconstructPage(model);
    expect(plain.paragraphs.map((p) => p.lines)).toEqual([[0, 1, 2, 3, 4, 5]]);
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(layout.readingOrder.map((r) => r.id)).toEqual([0, 1]);
  });

  it('even when overlapping a neighboring paragraph (expanded region), one block and one neighbor', () => {
    // The last line of the block is near the same height as the neighbor's first line (overlap).
    const model = buildModel({
      lines: [
        ...column(72, 100, [words(12), words(12), words(12)]),
        ...column(72, 128, [words(12), words(12), 'end.']),
      ],
    });
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2]] });
    checkInvariants(model, layout);
    const sorted = layout.paragraphs.map((p) => p.lines).sort((a, b) => a[0]! - b[0]!);
    expect(sorted).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('two columns: the block receives the reading order and column of the left column position', () => {
    const left = column(50, 150, [words(9), words(9), 'end.', 'Edited one.', 'Edited two.']);
    const right = column(320, 150, [words(9), words(9), 'final line.']);
    const model = buildModel({ lines: [...left, ...right] });
    const layout = reconstructPage(model, { fixedGroups: [[3, 4]] });
    checkInvariants(model, layout);
    const block = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(block.lines).toEqual([3, 4]);
    const first = layout.paragraphs.find((p) => p.lines.includes(0))!;
    const rightP = layout.paragraphs.find((p) => p.lines.includes(5))!;
    expect(block.column).toBe(first.column);
    expect(rightP.column).not.toBe(block.column);
    const order = layout.readingOrder.map((r) => r.id);
    expect(order.indexOf(first.id)).toBeLessThan(order.indexOf(block.id));
    expect(order.indexOf(block.id)).toBeLessThan(order.indexOf(rightP.id));
  });

  it('invalid indices, empty groups and overlapping groups are ignored (earlier group wins); two groups give two paragraphs', () => {
    const model = buildModel({ lines: blockLines() });
    const layout = reconstructPage(model, {
      fixedGroups: [[], [0, 1, 99, -1], [1, 2, 3, 4]],
    });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
  });

  it('without hints, or with an empty array, the result equals M2', () => {
    const model = buildModel({ lines: blockLines() });
    const strip = (l: PageLayout) => ({ ...l, reconMs: 0 });
    expect(strip(reconstructPage(model, { fixedGroups: [] }))).toEqual(
      strip(reconstructPage(model)),
    );
  });
});

describe('fixedGroups cell edit blocks (M4 4.1, V4)', () => {
  /** Shape of one table (row/column counts, strategy) and the number of paragraphs per cell. */
  const shape = (l: PageLayout) =>
    l.tables.map((t) => ({
      strategy: t.strategy,
      rows: t.rows,
      cols: t.cols,
      paragraphs: t.cells.map((c) => c.paragraphs.length),
    }));
  /** Paragraphs of the (row, column) cell. */
  const cellParas = (l: PageLayout, row: number, col: number) => {
    const c = l.tables[0]!.cells.find((x) => x.row === row && x.col === col)!;
    return c.paragraphs.map((id) => l.paragraphs[id]!);
  };

  // Ruled 3×3 table (row height 30). After editing, cell (1,1) is a two-line block.
  const xs = [100, 200, 300, 400];
  const ys = [100, 130, 160, 190];
  const gridSpec = (edited: boolean): ModelSpec => {
    const lines: LineSpec[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        if (edited && r === 1 && c === 1) continue;
        lines.push({ x: xs[c]! + 5, y: ys[r]! + 14, text: `R${r}C${c}` });
      }
    if (edited) {
      lines.push({ x: 205, y: 142, text: 'Edited' }, { x: 205, y: 154, text: 'cell' });
    }
    return { lines, paths: gridPaths(xs, ys) };
  };

  it('ruled table: table detection holds after committing a cell block, and that cell paragraph = one block (table set)', () => {
    const before = reconstructPage(buildModel(gridSpec(false)));
    const model = buildModel(gridSpec(true));
    const block = [8, 9];
    const layout = reconstructPage(model, { fixedGroups: [block] });
    checkInvariants(model, layout);
    expect(shape(layout)).toEqual(shape(before));
    const [p, ...rest] = cellParas(layout, 1, 1);
    expect(rest).toEqual([]);
    expect(p!.lines).toEqual(block);
    expect(p!.table).toBe(0);
    expect(p!.column).toBe(-1);
    expect(p!.text).toBe('Edited cell');
    // Paragraphs inside tables are not in the top-level reading order.
    expect(layout.readingOrder).toEqual([{ kind: 'table', id: 0 }]);
  });

  it('ruled table: when the result is the same without block groups, the hint does not change the cell paragraph (single-line cell)', () => {
    const model = buildModel(gridSpec(false));
    const plain = reconstructPage(model);
    const hinted = reconstructPage(model, { fixedGroups: [[4]] });
    checkInvariants(model, hinted);
    expect(shape(hinted)).toEqual(shape(plain));
    expect(cellParas(hinted, 1, 1).map((p) => p.lines)).toEqual([[4]]);
  });

  // Alignment-strategy table with 3 rows (header + 3 rows, 2 right-aligned numeric columns).
  const right = (r: number, y: number, text: string): LineSpec => ({
    x: r - Array.from(text).length * 5,
    y,
    text,
  });
  const alignedSpec = (cash: string): ModelSpec => ({
    lines: [
      right(400, 100, '2025'),
      right(500, 100, '2024'),
      { x: 82, y: 114, text: 'Cash and equivalents' },
      right(400, 114, cash),
      right(500, 114, '1,100'),
      { x: 82, y: 128, text: 'Receivables' },
      right(400, 128, '567'),
      right(500, 128, '45,600'),
      { x: 82, y: 142, text: 'Inventory' },
      right(400, 142, '89'),
      right(500, 142, '12'),
    ],
  });

  it('alignment-strategy 3-row table: table detection holds after committing a numeric cell block', () => {
    const before = reconstructPage(buildModel(alignedSpec('1,234')));
    expect(shape(before)).toEqual([
      { strategy: 'text', rows: 4, cols: 3, paragraphs: expect.any(Array) },
    ]);
    const model = buildModel(alignedSpec('12,345'));
    const layout = reconstructPage(model, { fixedGroups: [[3]] });
    checkInvariants(model, layout);
    expect(shape(layout)).toEqual(shape(before));
    const [p, ...rest] = cellParas(layout, 1, 1);
    expect(rest).toEqual([]);
    expect(p!.lines).toEqual([3]);
    expect(p!.table).toBe(0);
    expect(p!.text).toBe('12,345');
  });

  it('a group spanning several cells is a flow paragraph, and table detection equals the result without those lines', () => {
    const model = buildModel(gridSpec(false));
    const layout = reconstructPage(model, { fixedGroups: [[3, 4]] });
    checkInvariants(model, layout);
    const block = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(block.lines).toEqual([3, 4]);
    expect(block.table).toBeNull();
    for (const t of layout.tables)
      for (const c of t.cells) expect(c.lines.some((li) => li === 3 || li === 4)).toBe(false);
  });
});
