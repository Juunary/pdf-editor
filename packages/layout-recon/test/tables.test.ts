import { describe, expect, it } from 'vitest';
import { lineFeatures } from '../src/features.js';
import { summarizePaths } from '../src/paths.js';
import { detectTables, type DetectedTable } from '../src/tables.js';
import {
  buildModel,
  gridPaths,
  lineSegments,
  rectSegments,
  type LineSpec,
  type ModelSpec,
  type PathSpec,
} from './helpers/model-builder.js';

function detect(spec: ModelSpec): DetectedTable[] {
  const model = buildModel(spec);
  const lines = lineFeatures(model).filter((l) => l.horizontal);
  return detectTables(model, lines, summarizePaths(model));
}

const dims = (t: DetectedTable): [number, number] => [
  t.rowBounds.length - 1,
  t.colBounds.length - 1,
];

/** Line text of the (row, column) cell. */
function cellText(t: DetectedTable, spec: ModelSpec, row: number, col: number): string[] {
  const c = t.cells.find((x) => x.row === row && x.col === col);
  return (c?.lines ?? []).map((k) => spec.lines![k]!.text);
}

/** Common invariants: cells cover the grid without overlap, and each line appears only once in the whole table. */
function expectInvariants(tables: DetectedTable[]): void {
  const seen = new Set<number>();
  for (const t of tables) {
    const [nr, nc] = dims(t);
    const own = new Array<number>(nr * nc).fill(0);
    for (const c of t.cells) {
      for (let r = c.row; r < c.row + c.rowSpan; r++)
        for (let k = c.col; k < c.col + c.colSpan; k++) own[r * nc + k]! += 1;
      for (const l of c.lines) {
        expect(seen.has(l)).toBe(false);
        seen.add(l);
      }
    }
    expect(own.every((n) => n === 1)).toBe(true);
    expect(t.bbox).toEqual([
      t.colBounds[0],
      t.rowBounds[0],
      t.colBounds.at(-1),
      t.rowBounds.at(-1),
    ]);
  }
}

/** A line with its right end aligned to right (character width = size × 0.5). */
const rightAt = (right: number, y: number, text: string, size = 10): LineSpec => ({
  x: right - Array.from(text).length * size * 0.5,
  y,
  text,
  size,
});

const PROSE =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip';

/** A prose line cut at word boundaries (at most n characters). */
function proseLines(
  x: number,
  y0: number,
  count: number,
  maxChars: number,
  pitch = 12,
): LineSpec[] {
  const words = PROSE.split(' ');
  const out: LineSpec[] = [];
  let w = 0;
  for (let i = 0; i < count; i++) {
    let text = '';
    while ((text + ' ' + words[w % words.length]).trim().length <= maxChars) {
      text = (text + ' ' + words[w % words.length]).trim();
      w++;
    }
    out.push({ x, y: y0 + i * pitch, text });
  }
  return out;
}

describe('detectTables: ruling-line strategy', () => {
  it('3×3 grid table: row/column boundaries and one line per cell', () => {
    const xs = [100, 200, 300, 400];
    const ys = [100, 120, 140, 160];
    const lines: LineSpec[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) lines.push({ x: xs[c]! + 5, y: ys[r]! + 14, text: `R${r}C${c}` });
    const spec: ModelSpec = { lines, paths: gridPaths(xs, ys) };
    const tables = detect(spec);
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.strategy).toBe('lines');
    expect(dims(t)).toEqual([3, 3]);
    t.rowBounds.forEach((y, i) => expect(y).toBeCloseTo(ys[i]!, 0));
    t.colBounds.forEach((x, i) => expect(x).toBeCloseTo(xs[i]!, 0));
    expect(t.cells).toHaveLength(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) expect(cellText(t, spec, r, c)).toEqual([`R${r}C${c}`]);
    expect(t.paths).toHaveLength(8);
    expectInvariants(tables);
  });

  it('merged header cell: a header cell without a vertical line has colSpan 2', () => {
    const paths: PathSpec[] = [
      ...[100, 120, 140, 160].map((y) => ({
        op: 'stroke' as const,
        segments: lineSegments([100, y], [400, y]),
        lineWidth: 0.5,
      })),
      ...[100, 300, 400].map((x) => ({
        op: 'stroke' as const,
        segments: lineSegments([x, 100], [x, 160]),
        lineWidth: 0.5,
      })),
      { op: 'stroke', segments: lineSegments([200, 120], [200, 160]), lineWidth: 0.5 },
    ];
    const spec: ModelSpec = {
      lines: [
        { x: 105, y: 114, text: 'Group' },
        { x: 305, y: 114, text: 'Total' },
        { x: 105, y: 134, text: 'a1' },
        { x: 205, y: 134, text: 'b1' },
        { x: 305, y: 134, text: '9' },
        { x: 105, y: 154, text: 'a2' },
        { x: 205, y: 154, text: 'b2' },
        { x: 305, y: 154, text: '12' },
      ],
      paths,
    };
    const tables = detect(spec);
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(dims(t)).toEqual([3, 3]);
    const head = t.cells.find((c) => c.row === 0 && c.col === 0)!;
    expect(head.colSpan).toBe(2);
    expect(head.rowSpan).toBe(1);
    expect(cellText(t, spec, 0, 0)).toEqual(['Group']);
    expect(cellText(t, spec, 0, 2)).toEqual(['Total']);
    expect(cellText(t, spec, 2, 1)).toEqual(['b2']);
    expect(t.cells).toHaveLength(8);
    expectInvariants(tables);
  });

  it('striped table (fill rectangles only): one table including header and end rows without stripes', () => {
    const rows = [
      ['Item', 'Q1', 'Q2'],
      ['Alpha', '1,234', '5,678'],
      ['Beta', '567', '45,600'],
      ['Gamma', '89', '12'],
      ['Delta', '2,000', '1,900'],
      ['Total', '3,890', '53,190'],
    ];
    const lines: LineSpec[] = [];
    rows.forEach((r, i) => {
      const y = 100 + 20 * i + 14;
      lines.push({ x: 105, y, text: r[0]! }, rightAt(290, y, r[1]!), rightAt(390, y, r[2]!));
    });
    const stripes: PathSpec[] = [1, 3].map((i) => ({
      op: 'fill',
      segments: rectSegments([100, 100 + 20 * i, 400, 120 + 20 * i]),
      color: [0.85, 0.85, 0.85],
    }));
    const spec: ModelSpec = { lines, paths: stripes };
    const tables = detect(spec);
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.strategy).toBe('lines');
    expect(dims(t)).toEqual([6, 3]);
    expect(cellText(t, spec, 0, 0)).toEqual(['Item']);
    expect(cellText(t, spec, 2, 2)).toEqual(['45,600']);
    expect(cellText(t, spec, 5, 1)).toEqual(['3,890']);
    expect(t.paths.sort()).toEqual([0, 1]);
    expectInvariants(tables);
  });

  it('booktabs table (horizontal lines only): columns by text alignment, rows by baseline', () => {
    const body = [
      ['Base', '71.3', '68.0'],
      ['Ours', '81.2', '77.0'],
      ['Ours+', '83.9', '79.4'],
      ['Oracle', '90.1', '88.8'],
    ];
    const lines: LineSpec[] = [
      { x: 105, y: 112, text: 'Method' },
      { x: 220, y: 112, text: 'Acc' },
      { x: 320, y: 112, text: 'F1' },
    ];
    body.forEach((r, i) => {
      const y = 132 + 14 * i;
      lines.push(
        { x: 105, y, text: r[0]! },
        { x: 220, y, text: r[1]! },
        { x: 320, y, text: r[2]! },
      );
    });
    const rule = (y: number, w: number): PathSpec => ({
      op: 'stroke',
      segments: lineSegments([100, y], [400, y]),
      lineWidth: w,
    });
    const spec: ModelSpec = {
      lines: [{ x: 100, y: 90, text: 'Table 1: Results on the benchmark.' }, ...lines],
      paths: [rule(100, 1), rule(118, 0.5), rule(190, 1)],
    };
    const tables = detect(spec);
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.strategy).toBe('lines');
    expect(dims(t)).toEqual([5, 3]);
    expect(t.rowBounds[0]).toBeCloseTo(100, 0);
    expect(t.rowBounds.at(-1)).toBeCloseTo(190, 0);
    expect(cellText(t, spec, 0, 1)).toEqual(['Acc']);
    expect(cellText(t, spec, 3, 0)).toEqual(['Ours+']);
    expect(cellText(t, spec, 4, 2)).toEqual(['88.8']);
    // The table title is outside the table.
    expect(t.cells.some((c) => c.lines.includes(0))).toBe(false);
    expectInvariants(tables);
  });
});

describe('detectTables: alignment strategy', () => {
  it('right-aligned numeric financial table: 3 columns including section rows', () => {
    const spec: ModelSpec = {
      lines: [
        { x: 72, y: 60, text: 'Statement of financial position' },
        rightAt(400, 100, '2025'),
        rightAt(500, 100, '2024'),
        { x: 72, y: 114, text: 'Assets' },
        { x: 82, y: 128, text: 'Cash and equivalents' },
        rightAt(400, 128, '1,234'),
        rightAt(500, 128, '1,100'),
        { x: 82, y: 142, text: 'Receivables' },
        rightAt(400, 142, '567'),
        rightAt(500, 142, '45,600'),
        { x: 82, y: 156, text: 'Inventory' },
        rightAt(400, 156, '89'),
        rightAt(500, 156, '12'),
        { x: 72, y: 170, text: 'Liabilities' },
        { x: 82, y: 184, text: 'Payables' },
        rightAt(400, 184, '2,000'),
        rightAt(500, 184, '1,900'),
        { x: 72, y: 198, text: 'Total' },
        rightAt(400, 198, '3,890'),
        rightAt(500, 198, '48,612'),
        ...proseLines(72, 240, 4, 90),
      ],
    };
    const tables = detect(spec);
    expect(tables).toHaveLength(1);
    const t = tables[0]!;
    expect(t.strategy).toBe('text');
    expect(dims(t)).toEqual([8, 3]);
    expect(t.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1)).toBe(true);
    expect(cellText(t, spec, 0, 1)).toEqual(['2025']);
    expect(cellText(t, spec, 1, 0)).toEqual(['Assets']);
    expect(cellText(t, spec, 3, 2)).toEqual(['45,600']);
    expect(cellText(t, spec, 7, 0)).toEqual(['Total']);
    expect(t.bbox[1]).toBeGreaterThan(65);
    expect(t.bbox[3]).toBeLessThan(220);
    expectInvariants(tables);
  });
});

describe('detectTables: non-tables', () => {
  it('two-column body text', () => {
    const spec: ModelSpec = {
      lines: [...proseLines(72, 100, 30, 45), ...proseLines(320, 100, 30, 45)],
    };
    expect(detect(spec)).toEqual([]);
  });

  it('two-column schedule list (short lines)', () => {
    const entries = [
      ['May 14–16, 2024', 'CERES Science Team Meeting', 'Hampton, VA'],
      ['June 3–6, 2024', 'OMI–TROPOMI Science Team Meeting', 'Boulder, CO'],
      ['April 14–19, 2024', 'European Geosciences Union', 'Vienna, Austria'],
      ['May 17–22, 2024', 'American Thoracic Society', 'San Diego, CA'],
      ['May 26–31, 2024', 'Japan Geoscience Union', 'Chiba, Japan'],
    ];
    const col = (x: number): LineSpec[] =>
      entries.flatMap((e, i) =>
        e.map((text, k) => ({ x, y: 100 + i * 50 + k * 12, text, bold: k === 0 })),
      );
    expect(detect({ lines: [...col(72), ...col(320)] })).toEqual([]);
  });

  it('chart with grid lines and tick labels', () => {
    const xs = [100, 150, 200, 250, 300, 350, 400, 450, 500];
    const ys = [100, 150, 200, 250, 300, 350, 400];
    const lines: LineSpec[] = [
      ...ys.map((y, i) => rightAt(92, y + 3, String(60 - i * 10), 8)),
      ...xs.map((x, i) => ({ x: x - 8, y: 415, text: String(2017 + i), size: 8 })),
      { x: 250, y: 85, text: 'Receipts by year' },
    ];
    const series: PathSpec = {
      op: 'stroke',
      segments: [
        { type: 'M', p: [100, 380] },
        { type: 'L', p: [150, 330] },
        { type: 'L', p: [200, 350] },
        { type: 'L', p: [250, 260] },
        { type: 'L', p: [300, 220] },
        { type: 'L', p: [350, 240] },
        { type: 'L', p: [400, 160] },
        { type: 'L', p: [450, 170] },
        { type: 'L', p: [500, 120] },
      ],
      lineWidth: 1.5,
    };
    expect(detect({ lines, paths: [...gridPaths(xs, ys, 0.3), series] })).toEqual([]);
  });

  it('a single bordered text box', () => {
    const spec: ModelSpec = {
      lines: [{ x: 100, y: 110, text: 'Note', bold: true }, ...proseLines(100, 124, 5, 58)],
      paths: [{ op: 'stroke', segments: rectSegments([90, 95, 400, 200]), lineWidth: 1 }],
    };
    expect(detect(spec)).toEqual([]);
  });

  it('page border rectangle', () => {
    const spec: ModelSpec = {
      lines: [
        { x: 72, y: 80, text: 'Chapter 3', size: 16, bold: true },
        ...proseLines(72, 110, 40, 90),
        { x: 300, y: 760, text: '12' },
      ],
      paths: [{ op: 'stroke', segments: rectSegments([20, 20, 592, 772]), lineWidth: 1 }],
    };
    expect(detect(spec)).toEqual([]);
  });
});

describe('detectTables: processing time', () => {
  it('processes a page with about 1,000 rules and 500 lines within 100 ms', () => {
    // A 25×10 grid with four edges drawn separately per cell (1,000 rules) + 250 cell text lines + 250 body lines.
    const paths: PathSpec[] = [];
    const lines: LineSpec[] = [];
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 25; c++) {
        const x0 = 20 + c * 22;
        const y0 = 40 + r * 16;
        paths.push(
          { op: 'stroke', segments: lineSegments([x0, y0], [x0 + 22, y0]), lineWidth: 0.5 },
          {
            op: 'stroke',
            segments: lineSegments([x0, y0 + 16], [x0 + 22, y0 + 16]),
            lineWidth: 0.5,
          },
          { op: 'stroke', segments: lineSegments([x0, y0], [x0, y0 + 16]), lineWidth: 0.5 },
          {
            op: 'stroke',
            segments: lineSegments([x0 + 22, y0], [x0 + 22, y0 + 16]),
            lineWidth: 0.5,
          },
        );
        lines.push({ x: x0 + 2, y: y0 + 12, text: String(r * 25 + c), size: 7 });
      }
    lines.push(...proseLines(30, 230, 250, 100));
    const model = buildModel({ lines, paths, height: 3300 });
    const feats = lineFeatures(model).filter((l) => l.horizontal);
    const ps = summarizePaths(model);
    expect(ps.rules.length).toBe(1000);
    const t0 = performance.now();
    const tables = detectTables(model, feats, ps);
    const ms = performance.now() - t0;
    expect(tables.length).toBeGreaterThanOrEqual(1);
    expect(dims(tables[0]!)).toEqual([10, 25]);
    expect(ms).toBeLessThan(100);
  });
});
