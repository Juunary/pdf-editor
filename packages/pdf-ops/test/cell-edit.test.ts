/**
 * M4 table cell editing (docs/m4-contract.md 4.1, D1, D5, V4): cell target, start style, region limit, classification list; after a real reflow commit,
 * position preservation and layout restoration (fixedGroups cell paragraphs).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as mupdf from 'mupdf';
import type { PlacedGlyph } from '@pdf-editor/shared-types';
import { layoutParagraph } from '@pdf-editor/reflow';
import {
  FontManager,
  planPageEditability,
  planParagraphEdit,
  prepareParagraphEdit,
  writeEditBlock,
  type ParagraphEditContext,
} from '../src/index.js';
import { cellTarget } from '../src/cell-edit.js';
import { fallbackFor, newEditId } from './helpers/edit-driver.js';
import { loadModules, pageContext } from './helpers/edit-context.js';
import {
  bytesOf,
  expectNoChangeOutside,
  gridTable,
  makeDoc,
  paragraphOf,
} from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const ROWS = [100, 130, 160, 190];
const ctxOf = (doc: mupdf.PDFDocument) =>
  pageContext(doc, 0, { segments: true, fixedGroups: true });
const gridDoc = (text?: Parameters<typeof gridTable>[1]) =>
  makeDoc([{ content: gridTable(ROWS, text), mediabox: [0, 0, 500, 300] }]);

/** First paragraph id of the (row, column) cell. */
function cellParagraph(ctx: ParagraphEditContext, row: number, col: number): number {
  const c = ctx.layout.tables[0]!.cells.find((x) => x.row === row && x.col === col)!;
  return c.paragraphs[0]!;
}

/** Commits a cell (paragraph) edit with a real reflow. Without text, the start text is used as is. */
function commit(ctx: ParagraphEditContext, paragraphId: number, text?: string) {
  const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
  const plan = planParagraphEdit(ctx, fm, paragraphId);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prepared = prepareParagraphEdit(ctx, plan, newEditId());
  const runs = text === undefined ? plan.runs : [{ text, style: plan.runs[0]!.style }];
  const all = runs.map((r) => r.text).join('');
  const { segments } = fm.assign(ctx, all, runs);
  const result = layoutParagraph({
    text: all,
    segments,
    format: plan.format,
    areaLimit: plan.areaLimit,
  });
  writeEditBlock(ctx, prepared, runs, plan.format, result, fm);
  return { plan, result };
}

/** Origins of the visible characters inside the cell box (in character order). */
function originsIn(ctx: ParagraphEditContext, box: readonly number[]) {
  return ctx.model.chars
    .filter((c) => c.text.trim() !== '')
    .filter(
      (c) =>
        c.origin[0] >= box[0]! &&
        c.origin[0] <= box[2]! &&
        c.origin[1] >= box[1]! &&
        c.origin[1] <= box[3]!,
    )
    .map((c) => ({ t: c.text, x: c.origin[0], y: c.origin[1] }));
}

/** Alignment-strategy table (header + 3 rows, 2 right-aligned numeric columns, no rule lines). */
function alignedDoc(cash = '1,234'): mupdf.PDFDocument {
  const right = (x: number, y: number, s: string) =>
    `BT /F1 10 Tf ${x - s.length * 5.56} ${300 - y} Td (${s}) Tj ET`;
  const rows = [
    ['Item', '2025', '2024'],
    ['Cash and equivalents', cash, '1,100'],
    ['Receivables', '567', '45,600'],
    ['Inventory', '89', '12'],
  ];
  const parts: string[] = [];
  rows.forEach((r, i) => {
    const y = 100 + 14 * i;
    parts.push(`BT /F1 10 Tf 82 ${300 - y} Td (${r[0]}) Tj ET`);
    parts.push(right(400, y, r[1]!), right(480, y, r[2]!));
  });
  return makeDoc([{ content: parts.join(' '), mediabox: [0, 0, 500, 300] }]);
}

describe('cell target (4.1, D1)', () => {
  it('a cell paragraph is editable (not not-flow-paragraph), target.cell, region, limit', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    expect(ctx.layout.tables.map((t) => t.strategy)).toEqual(['lines']);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, cellParagraph(ctx, 1, 1));
    expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
    expect(plan.target.cell).toEqual({ table: 0, row: 1, col: 1 });
    expect(plan.runs.map((r) => r.text).join('')).toBe('R1C1');
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const text = plan.target.bbox;
    // Limit = cell - margin (min(gap, 2pt) per side).
    expect(plan.areaLimit[0]).toBeCloseTo(cell.bbox[0] + 2, 6);
    expect(plan.areaLimit[2]).toBeCloseTo(cell.bbox[2] - 2, 6);
    expect(plan.areaLimit[1]).toBeCloseTo(cell.bbox[1] + Math.min(2, text[1] - cell.bbox[1]), 6);
    expect(plan.areaLimit[3]).toBeCloseTo(cell.bbox[3] - Math.min(2, cell.bbox[3] - text[3]), 6);
    // Start region: left-aligned, left edge at the original character, right edge at the limit, vertically the character box.
    expect(plan.format.align).toBe('left');
    expect(plan.format.area[0]).toBeCloseTo(text[0], 6);
    expect(plan.format.area[2]).toBeCloseTo(plan.areaLimit[2], 6);
    expect([plan.format.area[1], plan.format.area[3]]).toEqual([text[1], text[3]]);
    expect(plan.format.firstLineIndent).toBe(0);
  });

  it('classification list: one entry per cell (box = cell box, cell set)', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const pe = planPageEditability(ctx, new FontManager(doc, fallbackFor(doc)));
    // Path classifications are in the same list (8 rule lines).
    expect(pe.paths.map((p) => p.editable)).toEqual(new Array(8).fill(true));
    const list = pe.paragraphs;
    const cells = list.filter((p) => p.cell !== null);
    expect(cells).toHaveLength(9);
    const t = ctx.layout.tables[0]!;
    for (const e of cells) {
      const c = t.cells.find((x) => x.row === e.cell!.row && x.col === e.cell!.col)!;
      expect(e.bbox).toEqual(c.bbox);
      expect(e.editable).toBe(true);
      expect(e.reasons).toEqual([]);
    }
  });

  it('several paragraphs in a cell form one target: a full line + equal line spacing gives a space, otherwise \\n', () => {
    const doc = gridDoc((r, c) => (r === 1 && c === 1 ? ['Alpha', 'Beta'] : `R${r}C${c}`));
    const ctx0 = ctxOf(doc);
    // Layout with cell (1,1) split into one paragraph per line (imitates the unstable paragraph splitting inside a cell).
    const t = ctx0.layout.tables[0]!;
    const cell = t.cells.find((c) => c.row === 1 && c.col === 1)!;
    const chars = cell.paragraphs.flatMap((id) => ctx0.layout.paragraphs[id]!.chars);
    const line0 = ctx0.model.chars[chars[0]!]!.line;
    const alpha = chars.filter((ci) => ctx0.model.chars[ci]!.line === line0);
    const beta = chars.filter((ci) => ctx0.model.chars[ci]!.line !== line0);
    // Even if the layout groups them into one paragraph (two lines), the short line stays as a forced line break (per-line classification).
    expect(cell.paragraphs).toHaveLength(1);
    expect(cellTarget(ctx0.model, ctx0.layout, cell.paragraphs[0]!)!.paragraph.text).toBe(
      'Alpha\nBeta',
    );
    const base = ctx0.layout.paragraphs.length;
    const variant = (alphaLineHeight: number | null, cellRight: number) => {
      const pa = {
        ...paragraphOf(ctx0, alpha, base),
        table: 0,
        column: -1,
        lineHeight: alphaLineHeight,
      };
      const pb = { ...paragraphOf(ctx0, beta, base + 1), table: 0, column: -1 };
      const c2 = {
        ...cell,
        paragraphs: [pa.id, pb.id],
        bbox: [cell.bbox[0], cell.bbox[1], cellRight, cell.bbox[3]] as typeof cell.bbox,
      };
      const paragraphs = ctx0.layout.paragraphs.filter((p) => !cell.paragraphs.includes(p.id));
      const layout = {
        ...ctx0.layout,
        paragraphs: [...paragraphs, pa, pb],
        tables: [{ ...t, cells: t.cells.map((c) => (c === cell ? c2 : c)) }],
      };
      return { ctx: { ...ctx0, layout }, pa, pb };
    };
    // The line is far from the inner right edge of the cell -> "\n".
    const v1 = variant(null, cell.bbox[2]);
    const t1 = cellTarget(v1.ctx.model, v1.ctx.layout, v1.pb.id)!;
    expect(t1.paragraph.text).toBe('Alpha\nBeta');
    expect([...t1.members]).toEqual([v1.pa.id, v1.pb.id]);
    expect(t1.lineHeight).toBeCloseTo(12, 6);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p1 = planParagraphEdit(v1.ctx, fm, v1.pa.id);
    const p2 = planParagraphEdit(v1.ctx, fm, v1.pb.id);
    expect(p2.target.glyphSeqs).toEqual(p1.target.glyphSeqs);
    expect(p1.runs.map((r) => r.text).join('')).toBe('Alpha\nBeta');
    expect(p1.format.lineHeight).toBeCloseTo(12, 6);
    expect(p1.charIndexOfOffset[5]).toBe(-1);
    // The first line fills up to within 1em of the inner right edge and the line spacing is equal -> space.
    const right = ctx0.model.lines[line0]!.bbox[2] + 4;
    const v2 = variant(12, right);
    expect(cellTarget(v2.ctx.model, v2.ctx.layout, v2.pa.id)!.paragraph.text).toBe('Alpha Beta');
    // If the line spacing differs (previous paragraph line spacing 20), "\n" even when the line is full.
    const v3 = variant(20, right);
    expect(cellTarget(v3.ctx.model, v3.ctx.layout, v3.pa.id)!.paragraph.text).toBe('Alpha\nBeta');
  });

  it('alignment-strategy table: right-aligned numeric columns are right, cell boxes widen the outer columns', () => {
    const doc = alignedDoc();
    const ctx = ctxOf(doc);
    const t = ctx.layout.tables[0];
    expect(t?.strategy).toBe('text');
    const num = t!.cells.find((c) => c.row === 2 && c.col === 2)!;
    const target = cellTarget(ctx.model, ctx.layout, num.paragraphs[0]!)!;
    expect(target.align).toBe('right');
    expect(target.box[2]).toBeGreaterThan(num.bbox[2]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, num.paragraphs[0]!);
    expect(plan.format.align).toBe('right');
    expect(plan.format.area[2]).toBeCloseTo(plan.target.bbox[2], 6);
  });
});

describe('cell commit (real reflow), V4', () => {
  it('same-text commit: glyph origin shift <= 0.5pt, render outside the cell unchanged (three engines)', async () => {
    const doc = gridDoc();
    const before = bytesOf(doc);
    const ctx = ctxOf(doc);
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const orig = originsIn(ctx, cell.bbox);
    const { result } = commit(ctx, cell.paragraphs[0]!);
    expect(result.summary.overflow).toBe(false);
    const after = originsIn(ctxOf(doc), cell.bbox);
    expect(after.map((o) => o.t)).toEqual(orig.map((o) => o.t));
    const shift = Math.max(...after.map((o, i) => Math.hypot(o.x - orig[i]!.x, o.y - orig[i]!.y)));
    expect(shift).toBeLessThanOrEqual(0.5);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [cell.bbox]);
  });

  it('V4 ruled table: table detection persists after commit, its cell paragraph = one block (table set), editing again hits the same cell', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const shape = (c: ParagraphEditContext) =>
      c.layout.tables.map((t) => [t.strategy, t.rows, t.cols, t.cells.length]);
    const before = shape(ctx);
    commit(ctx, cellParagraph(ctx, 1, 1), 'Edited cell text');
    const after = ctxOf(doc);
    expect(after.editBlocks).toHaveLength(1);
    expect(shape(after)).toEqual(before);
    const cell = after.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    expect(cell.paragraphs).toHaveLength(1);
    const p = after.layout.paragraphs[cell.paragraphs[0]!]!;
    expect(p.table).toBe(0);
    expect(p.text.replace(/\s+/g, ' ')).toBe('Edited cell text');
    const fm = new FontManager(doc, fallbackFor(doc));
    const again = planParagraphEdit(after, fm, p.id);
    expect(again.editable).toBe(true);
    expect(again.insertion?.mode).toBe('rewrite-block');
    expect(again.target.cell).toEqual({ table: 0, row: 1, col: 1 });
    const list = planPageEditability(after, fm).paragraphs.filter((e) => e.cell !== null);
    expect(list).toHaveLength(9);
  });

  it('V4 alignment-strategy table: table detection persists after committing a numeric cell, its cell paragraph = one block, right edge preserved', () => {
    const doc = alignedDoc();
    const ctx = ctxOf(doc);
    const shape = (c: ParagraphEditContext) =>
      c.layout.tables.map((t) => [t.strategy, t.rows, t.cols]);
    const before = shape(ctx);
    expect(before).toEqual([['text', 4, 3]]);
    const cell = ctx.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    const oldRight = ctx.layout.paragraphs[cell.paragraphs[0]!]!.bbox[2];
    commit(ctx, cell.paragraphs[0]!, '12,345');
    const after = ctxOf(doc);
    expect(shape(after)).toEqual(before);
    const c2 = after.layout.tables[0]!.cells.find((c) => c.row === 1 && c.col === 1)!;
    expect(c2.paragraphs).toHaveLength(1);
    const p = after.layout.paragraphs[c2.paragraphs[0]!]!;
    expect(p.table).toBe(0);
    expect(p.text).toBe('12,345');
    expect(Math.abs(p.bbox[2] - oldRight)).toBeLessThanOrEqual(0.5);
  });

  it('R-L4: a sourceChar missing from the start state is also used via classification-time resolution (the changed stream is not re-read)', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td 1 0 0 rg (Red ) Tj 0 0 1 rg (bluewords) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const plan = planParagraphEdit(ctx, fm, ctx.layout.paragraphs[0]!.id);
    const prepared = prepareParagraphEdit(ctx, plan, newEditId());
    // A character in the middle of the blue span (not at the start of the run).
    const mid = ctx.layout.paragraphs[0]!.chars.find((c) => ctx.model.chars[c]!.text === 'w')!;
    expect(plan.runs.some((r) => r.style.sourceChar === mid)).toBe(false);
    const runs = [{ text: 'Xyz', style: { ...plan.runs[0]!.style, sourceChar: mid } }];
    const { segments } = fm.assign(ctx, 'Xyz', runs);
    const result = layoutParagraph({
      text: 'Xyz',
      segments,
      format: plan.format,
      areaLimit: plan.areaLimit,
    });
    writeEditBlock(ctx, prepared, runs, plan.format, result, fm);
    const again = pageContext(doc, 0);
    const colors = again.model.chars.filter((c) => 'Xyz'.includes(c.text)).map((c) => c.color);
    expect(colors).toEqual([
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ]);
  });

  it('long text: auto-expansion stops at the lower bound of the cell (limit) and flags overflow', () => {
    const doc = gridDoc();
    const ctx = ctxOf(doc);
    const { plan, result } = commit(
      ctx,
      cellParagraph(ctx, 0, 2),
      'A much longer cell text that wraps over many lines inside the narrow cell box',
    );
    expect(result.summary.overflow).toBe(true);
    expect(result.summary.area[3]).toBeLessThanOrEqual(plan.areaLimit[3] + 1e-6);
    const glyphs: PlacedGlyph[] = result.summary.glyphs;
    expect(Math.max(...glyphs.map((g) => g.x + g.advance))).toBeLessThanOrEqual(
      plan.areaLimit[2] + 0.5,
    );
  });
});
