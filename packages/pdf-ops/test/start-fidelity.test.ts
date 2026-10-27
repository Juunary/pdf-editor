/**
 * Start-state fidelity (docs/m3-integration.md 10.4 proposals 1 and 2, docs/m4-pdf-ops.md section 6 #7): carries the original character spacing Tc as RunStyle.charSpacing,
 * and if the natural width of the original line exceeds the region (TJ kerning), widens the start region so that a same-text edit does not wrap the line earlier.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type * as mupdf from 'mupdf';
import { layoutParagraph } from '@pdf-editor/reflow';
import {
  FontManager,
  planParagraphEdit,
  prepareParagraphEdit,
  writeEditBlock,
  type ParagraphEditContext,
} from '../src/index.js';
import { fallbackFor, newEditId } from './helpers/edit-driver.js';
import { findParagraph, loadModules, pageContext } from './helpers/edit-context.js';
import { makeDoc } from './helpers/fixtures-m3.js';

beforeAll(async () => {
  await loadModules();
});

const ctxOf = (doc: mupdf.PDFDocument) =>
  pageContext(doc, 0, { segments: true, fixedGroups: true });

/** Page state and layout result after committing with the same text and re-reading. */
function sameTextCommit(ctx: ParagraphEditContext, paragraphId: number) {
  const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
  const plan = planParagraphEdit(ctx, fm, paragraphId);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const prepared = prepareParagraphEdit(ctx, plan, newEditId());
  const text = plan.runs.map((r) => r.text).join('');
  const { segments } = fm.assign(ctx, text, plan.runs);
  const result = layoutParagraph({
    text,
    segments,
    format: plan.format,
    areaLimit: plan.areaLimit,
  });
  writeEditBlock(ctx, prepared, plan.runs, plan.format, result, fm);
  return { plan, result, after: ctxOf(ctx.doc) };
}

/** Origins of the visible characters (page order). */
const origins = (ctx: ParagraphEditContext) =>
  ctx.model.chars.filter((c) => c.text.trim() !== '').map((c) => c.origin);

function maxShift(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): number {
  expect(b).toHaveLength(a.length);
  return Math.max(...a.map((p, i) => Math.hypot(p[0]! - b[i]![0]!, p[1]! - b[i]![1]!)));
}

const LINES = ['The quick brown fox jumps over the lazy', 'dog.'];

describe('character spacing Tc (proposal 1)', () => {
  it('carries Tc as RunStyle.charSpacing (pt) and a same-text commit preserves character positions', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf -0.4 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const doc = makeDoc([{ content }]);
    const ctx = ctxOf(doc);
    const p = findParagraph(ctx, 'quick brown');
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.every((r) => r.style.charSpacing === -0.4)).toBe(true);
    expect(result.summary.lines).toHaveLength(p.lines.length);
    expect(plan.format.align).toBe('left');
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
  });

  it('wide letter spacing for which extraction inserted synthetic spaces (letter-spaced words) does not carry the spacing (the gap is not added twice)', () => {
    const content = 'BT /F1 10 Tf 4 Tc 1 0 0 1 72 250 Tm (DEPARTMENT OF THE TREASURY) Tj ET';
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = ctx.layout.paragraphs[0]!;
    expect(p.text).toMatch(/D E P/);
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.some((r) => r.style.charSpacing)).toBe(false);
    expect(result.summary.lines).toHaveLength(1);
    expect(origins(after)).toHaveLength(before.length);
  });

  it('carries the horizontal scale Tz as RunStyle.horizontalScale and writes it as Tz in the edit block so a same-text commit preserves character positions', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf 85 Tz -0.2 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const before = origins(ctx);
    const { plan, result, after } = sameTextCommit(ctx, p.id);
    expect(plan.runs.every((r) => r.style.horizontalScale === 0.85)).toBe(true);
    expect(plan.runs.every((r) => r.style.charSpacing === -0.17)).toBe(true);
    expect(result.summary.lines).toHaveLength(p.lines.length);
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
    const block = after.editBlocks[0]!;
    const stream = after.doc.newIndirect(block.objectNumber).readStream().asString();
    expect(stream).toContain('85 Tz');
  });

  it('multiplies the Tm scale and Tz to convert to page-space values', () => {
    // Tf 5 x Tm 2 = font size 10pt, Tc 0.1 x scale 2 x Tz 0.5 = 0.1pt.
    const content = `BT /F1 5 Tf 0.1 Tc 50 Tz 2 0 0 2 72 250 Tm (${LINES[0]}) Tj ET`;
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.runs[0]!.style.charSpacing).toBeCloseTo(0.1, 6);
  });

  it('characters narrowed horizontally by Tm count as horizontalScale, slanted ones as 1', () => {
    const plan = (tm: string) => {
      const ctx = ctxOf(makeDoc([{ content: `BT /F1 10 Tf ${tm} Tm (${LINES[0]}) Tj ET` }]));
      const p = findParagraph(ctx, 'quick brown');
      return planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    };
    expect(plan('0.9 0 0 1 72 250').runs[0]!.style.horizontalScale).toBeCloseTo(0.9, 6);
    expect('horizontalScale' in plan('1 0 0.2 1 72 250').runs[0]!.style).toBe(false);
  });

  it('charSpacing is not set when Tc is 0 (same shape as the previous log)', () => {
    const content = `BT /F1 10 Tf 72 250 Td (${LINES[0]}) Tj ET`;
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect('charSpacing' in plan.runs[0]!.style).toBe(false);
  });

  it('even when re-editing a committed block, the letter spacing is restored from /PdfEditorFormat', () => {
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf -0.4 Tc 1 0 0 1 72 ${250 - 12 * i} Tm (${t}) Tj ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const { after } = sameTextCommit(ctx, findParagraph(ctx, 'quick brown').id);
    const p = findParagraph(after, 'quick brown');
    const plan = planParagraphEdit(after, new FontManager(after.doc, fallbackFor(after.doc)), p.id);
    expect(plan.target.editedBlock).not.toBeNull();
    expect(plan.runs.every((r) => r.style.charSpacing === -0.4)).toBe(true);
  });
});

describe('region horizontal adjustment (proposal 2)', () => {
  it('a line narrowed by TJ widens the start region to the natural width so the same text does not wrap earlier', () => {
    // Narrow the gaps between words of each line with TJ (placed narrower than the shaper width).
    const tj = (t: string) =>
      `[${t
        .split(' ')
        .map((w) => `(${w} )`)
        .join(' 120 ')}] TJ`;
    const content = LINES.map(
      (t, i) => `BT /F1 10 Tf 1 0 0 1 72 ${250 - 12 * i} Tm ${tj(t)} ET`,
    ).join(' ');
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
    const plan = planParagraphEdit(ctx, fm, p.id);
    expect(plan.format.area[2] - plan.format.area[0]).toBeGreaterThan(p.bbox[2] - p.bbox[0] + 1);
    expect(plan.format.area[0]).toBe(p.bbox[0]);
    expect(plan.format.area[2]).toBeLessThanOrEqual(plan.areaLimit[2]);
    const { result } = sameTextCommit(ctx, p.id);
    expect(result.summary.lines).toHaveLength(p.lines.length);
  });

  it('if there is neighboring content on the widening side, stops before it', () => {
    const tj = (t: string) =>
      `[${t
        .split(' ')
        .map((w) => `(${w} )`)
        .join(' 120 ')}] TJ`;
    const text = LINES.map((t, i) => `BT /F1 10 Tf 1 0 0 1 72 ${250 - 12 * i} Tm ${tj(t)} ET`);
    const base = ctxOf(makeDoc([{ content: text.join(' ') }]));
    const right = findParagraph(base, 'quick brown').bbox[2];
    // A vertical bar (neighboring content) 2pt to the right of the original line.
    const bar = `0 0 1 rg ${right + 2} 200 3 60 re f`;
    const ctx = ctxOf(makeDoc([{ content: `${text.join(' ')} ${bar}` }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.format.area[2]).toBeGreaterThan(p.bbox[2]);
    expect(plan.format.area[2]).toBeLessThanOrEqual(right + 1.5 + 1e-6);
  });

  it('if the original line fits in the region, the region is not changed', () => {
    const content = LINES.map((t, i) => `BT /F1 10 Tf 72 ${250 - 12 * i} Td (${t}) Tj ET`).join(
      ' ',
    );
    const ctx = ctxOf(makeDoc([{ content }]));
    const p = findParagraph(ctx, 'quick brown');
    const plan = planParagraphEdit(ctx, new FontManager(ctx.doc, fallbackFor(ctx.doc)), p.id);
    expect(plan.format.area).toEqual(p.bbox);
  });
});

describe('cell alignment reference (mismatch #7)', () => {
  it('even a cell centered including the trailing space does not move characters on a same-text commit', () => {
    const xs = [100, 200, 300, 400];
    const rows = [100, 130, 160, 190];
    const H = 300;
    const rules: string[] = [];
    for (const y of rows) rules.push(`${xs[0]} ${H - y} m ${xs[3]} ${H - y} l S`);
    for (const x of xs) rules.push(`${x} ${H - rows[0]!} m ${x} ${H - rows[3]!} l S`);
    // Width of "Total " (Helvetica 10) = 25.01pt: centered in the cell (150), including the trailing space.
    const cells: string[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const centered = r === 1 && c === 1;
        const x = centered ? xs[c]! + 50 - 25.01 / 2 : xs[c]! + 5;
        const t = centered ? 'Total ' : `R${r}C${c}`;
        cells.push(`BT /F1 10 Tf ${x} ${H - (rows[r]! + 14)} Td (${t}) Tj ET`);
      }
    const doc = makeDoc([
      { content: `0.5 w ${rules.join(' ')} ${cells.join(' ')}`, mediabox: [0, 0, 500, 300] },
    ]);
    const ctx = ctxOf(doc);
    const table = ctx.layout.tables[0]!;
    const cell = table.cells.find((c) => c.row === 1 && c.col === 1)!;
    const before = origins(ctx);
    const { plan, after } = sameTextCommit(ctx, cell.paragraphs[0]!);
    expect(plan.format.align).toBe('center');
    expect(maxShift(before, origins(after))).toBeLessThanOrEqual(0.05);
  });
});
