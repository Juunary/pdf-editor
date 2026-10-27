/**
 * M4 integration (docs/m4-integration.md): runs table cell editing (D1, D5, V4) and path editing
 * (D2, D3, D4) through the core session flow (classification → begin → update → commit → undo/redo → save → reopen → reapply) with the real pdf-ops and reflow adapter (defaultEditAdapter).
 */
import { describe, expect, it } from 'vitest';
// Import core before mupdf (src/wasm-module.ts, WASM heap measurement).
import { PdfSession, wasmHeapBytes } from '../src/index.js';
import * as mupdf from 'mupdf';
import type {
  DraftInput,
  EditOp,
  EditPathOp,
  ParagraphEditPlan,
  PathEdit,
  PathInfo,
  TextRun,
} from '@pdf-editor/shared-types';
import { FONT_BYTES } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

const MEDIABOX: [number, number, number, number] = [0, 0, 612, 792];
const H = 792;

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const squash = (t: string): string => t.replace(/\s+/gu, '');

function input(plan: ParagraphEditPlan, text: string): DraftInput {
  const run: TextRun = { text, style: plan.runs[0]!.style };
  return { runs: [run], format: plan.format, composition: null, renderScale: 1 };
}

async function editParagraph(s: PdfSession, paragraphId: number, text?: string) {
  const plan = await s.planParagraphEdit(0, paragraphId);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, paragraphId, plan.revision);
  const draft =
    text === undefined
      ? { runs: plan.runs, format: plan.format, composition: null, renderScale: 1 }
      : input(plan, text);
  const update = await s.updateParagraphDraft(started.draftId, draft);
  const commit = await s.commitParagraphEdit(started.draftId);
  return { plan, update, commit };
}

/** Byte string concatenating the page content stream(s). */
function contents(s: PdfSession, pageIndex = 0): string {
  const page = s.document.findPage(pageIndex);
  const c = page.get('Contents');
  const read = (o: mupdf.PDFObject) => {
    const b = o.readStream();
    try {
      return b.asString();
    } finally {
      b.destroy();
    }
  };
  if (c.isArray()) {
    let out = '';
    for (let i = 0; i < c.length; i++) out += read(c.get(i));
    return out;
  }
  return read(c);
}

// ---------------------------------------------------------------- table cells

const XS = [100, 200, 300, 400];
const ROWS = [100, 130, 160, 190];

/** Ruled table (3×3, cell text R{r}C{c}). */
function gridContent(): string {
  const rules: string[] = [];
  for (const y of ROWS) rules.push(`${XS[0]} ${H - y} m ${XS[3]} ${H - y} l S`);
  for (const x of XS) rules.push(`${x} ${H - ROWS[0]!} m ${x} ${H - ROWS[3]!} l S`);
  const cells: string[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      cells.push(`BT /F1 10 Tf ${XS[c]! + 5} ${H - (ROWS[r]! + 18)} Td (R${r}C${c}) Tj ET`);
  return `0.5 w ${rules.join(' ')} ${cells.join(' ')}`;
}

/** Alignment-strategy table (no rules, header + 3 rows, 2 right-aligned number columns). */
function alignedContent(): string {
  const right = (x: number, y: number, s: string) =>
    `BT /F1 10 Tf ${x - s.length * 5.56} ${H - y} Td (${s}) Tj ET`;
  const rows = [
    ['Item', '2025', '2024'],
    ['Cash and equivalents', '1,234', '1,100'],
    ['Receivables', '567', '45,600'],
    ['Inventory', '89', '12'],
  ];
  const parts: string[] = [];
  rows.forEach((r, i) => {
    const y = 100 + 14 * i;
    parts.push(`BT /F1 10 Tf 82 ${H - y} Td (${r[0]}) Tj ET`);
    parts.push(right(400, y, r[1]!), right(480, y, r[2]!));
  });
  return parts.join('\n');
}

function cellParagraph(s: PdfSession, row: number, col: number) {
  const layout = s.getPageLayout(0);
  const table = layout.tables[0]!;
  const cell = table.cells.find((c) => c.row === row && c.col === col)!;
  const paragraphs = cell.paragraphs.map((id) => layout.paragraphs.find((p) => p.id === id)!);
  return { table, cell, paragraphs };
}

describe('table cell editing (real adapter, D1, D5, V4)', () => {
  it('edits one cell of a ruled table → table kept (V4) → undo/redo → save and reopen → re-edit', async () => {
    const s = session(buildPdf([{ content: gridContent(), mediabox: MEDIABOX }]));
    const before = cellParagraph(s, 1, 1);
    expect(before.table.strategy).toBe('lines');
    expect(before.table.paths.length).toBeGreaterThanOrEqual(8);
    const editability = await s.getPageEditability(0);
    const cellItems = editability.paragraphs.filter((p) => p.cell !== null);
    expect(cellItems).toHaveLength(9);

    const { plan, update, commit } = await editParagraph(s, before.paragraphs[0]!.id, 'R1C1 수정');
    expect(plan.target.cell).toEqual({ table: before.table.id, row: 1, col: 1 });
    expect(update.reflow.overflow).toBe(false);
    expect(commit.op.kind).toBe('replace-paragraph');

    const after = cellParagraph(s, 1, 1);
    expect(s.getPageLayout(0).tables).toHaveLength(1);
    expect([after.table.rows, after.table.cols]).toEqual([before.table.rows, before.table.cols]);
    expect(after.paragraphs).toHaveLength(1);
    expect(squash(after.paragraphs[0]!.text)).toBe('R1C1수정');
    expect(after.paragraphs[0]!.table).not.toBeNull();
    expect(squash(cellParagraph(s, 1, 2).paragraphs[0]!.text)).toBe('R1C2');

    await s.undo();
    expect(squash(cellParagraph(s, 1, 1).paragraphs[0]!.text)).toBe('R1C1');
    await s.redo();
    expect(squash(cellParagraph(s, 1, 1).paragraphs[0]!.text)).toBe('R1C1수정');

    const saved = s.save({ changes: [] }).bytes;
    s.close();
    const r = session(saved);
    const again = cellParagraph(r, 1, 1);
    expect(r.getPageLayout(0).tables).toHaveLength(1);
    expect(squash(again.paragraphs[0]!.text)).toBe('R1C1수정');
    const second = await editParagraph(r, again.paragraphs[0]!.id, 'R1C1 두 번째');
    expect(second.plan.target.editedBlock).not.toBeNull();
    expect(second.plan.target.cell).toEqual({ table: again.table.id, row: 1, col: 1 });
    expect(squash(cellParagraph(r, 1, 1).paragraphs[0]!.text)).toBe('R1C1두번째');
    expect(r.getPageLayout(0).tables[0]!.strategy).toBe('lines');
    r.close();
  });

  it('V4: the table is still detected after committing a cell of an alignment-strategy table (no rules), and the cell paragraph is one block', async () => {
    const s = session(buildPdf([{ content: alignedContent(), mediabox: MEDIABOX }]));
    const before = cellParagraph(s, 2, 1);
    expect(before.table.strategy).toBe('text');
    expect(squash(before.paragraphs[0]!.text)).toBe('567');
    await editParagraph(s, before.paragraphs[0]!.id, '5,678');
    const after = cellParagraph(s, 2, 1);
    expect(after.table.strategy).toBe('text');
    expect([after.table.rows, after.table.cols]).toEqual([before.table.rows, before.table.cols]);
    expect(after.paragraphs).toHaveLength(1);
    expect(squash(after.paragraphs[0]!.text)).toBe('5,678');
    s.close();
  });

  it('committing a cell with the same text keeps glyph origins within 0.5pt (contract 1.1 position preservation)', async () => {
    const s = session(buildPdf([{ content: alignedContent(), mediabox: MEDIABOX }]));
    const origins = () =>
      s
        .extractPage({ pageIndex: 0 })
        .chars.filter((c) => c.text.trim() !== '')
        .map((c) => c.origin);
    const before = origins();
    for (const [row, col] of [
      [0, 0],
      [1, 1],
      [2, 2],
    ] as const) {
      await editParagraph(s, cellParagraph(s, row, col).paragraphs[0]!.id);
    }
    const after = origins();
    expect(after).toHaveLength(before.length);
    const shift = Math.max(
      ...before.map((p, i) => Math.hypot(p[0] - after[i]![0], p[1] - after[i]![1])),
    );
    expect(shift).toBeLessThanOrEqual(0.5);
    s.close();
  });

  it('table-rule-removed: warns only when a table grid path is deleted (LayoutTable.paths)', async () => {
    const content = `${gridContent()} 1 0 0 rg 450 600 30 30 re f`;
    const s = session(buildPdf([{ content, mediabox: MEDIABOX }]));
    const table = s.getPageLayout(0).tables[0]!;
    const model = s.extractPage({ pageIndex: 0 });
    const rule = model.paths[table.paths[0]!]!;
    const other = model.paths.find((p) => p.op === 'fill')!;
    const del = async (paintSeq: number) => {
      const plan = await s.planPathEdit(0, [paintSeq]);
      const started = await s.beginPathEdit(0, [paintSeq], plan.revision);
      const u = await s.updatePathDraft(started.draftId, { ...NO_EDIT, delete: true }, 1);
      await s.cancelPathEdit(started.draftId);
      return u.warnings.map((w) => w.kind);
    };
    expect(await del(rule.paintSeq)).toContain('table-rule-removed');
    expect(await del(other.paintSeq)).not.toContain('table-rule-removed');
    s.close();
  });
});

// ---------------------------------------------------------------- paths

/** A text paragraph (at the start of the stream) + Gray-filled rectangle + RGB-filled rectangle + straight line + polyline. */
const PATH_CONTENT = [
  'BT /F1 12 Tf 100 720 Td (Paragraph above the vector paths on this page.) Tj ET',
  '0.5 g 100 600 80 40 re f',
  '1 0 0 rg 300 600 60 30 re f',
  '0 0 1 RG 2 w 100 500 m 300 500 l S',
  '0 0 0 RG 1 w 100 400 m 150 450 l 200 400 l S',
].join('\n');

const NO_EDIT: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};

const pathSource = () => buildPdf([{ content: PATH_CONTENT, mediabox: MEDIABOX }]);

function painted(s: PdfSession): PathInfo[] {
  return s.extractPage({ pageIndex: 0 }).paths.filter((p) => p.op === 'fill' || p.op === 'stroke');
}

/** Finds a path by its original position (page-space top-left x0, y0). */
function pathAt(s: PdfSession, x0: number, y0: number, tol = 3): PathInfo {
  const p = painted(s).find(
    (q) => Math.abs(q.bbox[0] - x0) < tol && Math.abs(q.bbox[1] - y0) < tol,
  );
  if (!p) throw new Error(`패스 없음: ${x0},${y0}`);
  return p;
}

const GRAY = [100, H - 640] as const;
const RED = [300, H - 630] as const;
const LINE = [99, H - 501] as const;
const POLY = [90, H - 460] as const; // the MuPDF box adds a join margin (line width × 10)

async function pathEdit(s: PdfSession, paintSeqs: number[], edit: PathEdit) {
  const plan = await s.planPathEdit(0, paintSeqs);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginPathEdit(0, paintSeqs, plan.revision);
  const update = await s.updatePathDraft(started.draftId, edit, 1);
  const committed = await s.commitPathEdit(started.draftId);
  return { plan, update, committed };
}

const near = (a: readonly number[], b: readonly number[], tol = 0.05) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('path editing (real adapter, D2, D3, D4)', () => {
  it('classification: the 4 painted paths are editable', async () => {
    const s = session(pathSource());
    const e = await s.getPageEditability(0);
    expect(e.paths.filter((p) => p.editable)).toHaveLength(4);
    s.close();
  });

  it('move and resize: rewriting the construction operation operands changes the box and the other paths stay unchanged', async () => {
    const s = session(pathSource());
    const red = pathAt(s, ...RED);
    const before = painted(s).filter((p) => p.paintSeq !== red.paintSeq);
    await pathEdit(s, [pathAt(s, ...GRAY).paintSeq], {
      ...NO_EDIT,
      transform: [1, 0, 0, 1, 10, -5],
    });
    const moved = pathAt(s, GRAY[0] + 10, GRAY[1] - 5);
    expect(near(moved.bbox, [110, H - 645, 190, H - 605])).toBe(true);
    // Resize (top-left fixed, ×2).
    await pathEdit(s, [red.paintSeq], {
      ...NO_EDIT,
      transform: [2, 0, 0, 2, -RED[0], -RED[1]],
    });
    const scaled = pathAt(s, ...RED);
    expect(near(scaled.bbox, [300, H - 630, 420, H - 570])).toBe(true);
    expect(contents(s)).toContain('re f');
    const others = painted(s).filter(
      (p) => p.paintSeq !== moved.paintSeq && p.paintSeq !== scaled.paintSeq,
    );
    expect(others.map((p) => p.bbox)).toEqual(
      before.filter((p) => p.op === 'stroke').map((p) => p.bbox),
    );
    s.close();
  });

  it('point editing: moves only the middle point of the polyline', async () => {
    const s = session(pathSource());
    const poly = pathAt(s, ...POLY);
    await pathEdit(s, [poly.paintSeq], { ...NO_EDIT, points: [{ index: 1, to: [150, H - 480] }] });
    const after = painted(s).find((p) => p.paintSeq === poly.paintSeq)!;
    // The middle point moves up 30pt, so the top edge of the box also moves up 30pt and the left, right and bottom edges stay as they are.
    expect(after.bbox[1]).toBeCloseTo(poly.bbox[1] - 30, 3);
    expect([after.bbox[0], after.bbox[2], after.bbox[3]]).toEqual([
      poly.bbox[0],
      poly.bbox[2],
      poly.bbox[3],
    ]);
    expect(contents(s)).toContain('150 480 l');
    s.close();
  });

  it('color: a saturated color on a DeviceGray path is written as DeviceRGB with a color-space-changed warning (pdf-ops warning merge)', async () => {
    const s = session(pathSource());
    const gray = pathAt(s, ...GRAY);
    const { update } = await pathEdit(s, [gray.paintSeq], { ...NO_EDIT, fill: [1, 0, 0] });
    expect(update.warnings.map((w) => w.kind)).toContain('color-space-changed');
    const after = pathAt(s, ...GRAY);
    expect(after.color?.space).toBe('DeviceRGB');
    expect(after.color?.rgb).toEqual([1, 0, 0]);
    // The stroke color of an RGB path is in the same space, so no warning.
    const line = pathAt(s, ...LINE);
    const second = await pathEdit(s, [line.paintSeq], { ...NO_EDIT, stroke: [0, 1, 0] });
    expect(second.update.warnings.map((w) => w.kind)).not.toContain('color-space-changed');
    expect(pathAt(s, ...LINE).color?.rgb).toEqual([0, 1, 0]);
    s.close();
  });

  it('line width and deletion: width is in page-space pt, the deleted path disappears and the rest stay unchanged', async () => {
    const s = session(pathSource());
    const line = pathAt(s, ...LINE);
    await pathEdit(s, [line.paintSeq], { ...NO_EDIT, lineWidth: 6 });
    expect(pathAt(s, 97, H - 503).lineWidth).toBeCloseTo(6, 6);
    const count = painted(s).length;
    await pathEdit(s, [pathAt(s, ...RED).paintSeq], { ...NO_EDIT, delete: true });
    expect(painted(s)).toHaveLength(count - 1);
    expect(() => pathAt(s, ...RED)).toThrow();
    // Deletion replaces construction through painting with spaces (no unpaired n, review L1).
    expect(contents(s)).not.toMatch(/(^|\s)n(\s|$)/);
    expect(contents(s)).not.toContain('300 600 60 30 re');
    s.close();
  });

  it('multi-selection: moves two paths in one edit and undo/redo reverts both together', async () => {
    const s = session(pathSource());
    const original = contents(s);
    const seqs = [pathAt(s, ...GRAY).paintSeq, pathAt(s, ...RED).paintSeq];
    const { committed } = await pathEdit(s, seqs, { ...NO_EDIT, transform: [1, 0, 0, 1, 0, 20] });
    expect((committed.op as EditPathOp).target.paintSeqs).toEqual(seqs);
    const moved = contents(s);
    pathAt(s, GRAY[0], GRAY[1] + 20);
    pathAt(s, RED[0], RED[1] + 20);
    await s.undo();
    expect(contents(s)).toBe(original);
    pathAt(s, ...GRAY);
    await s.redo();
    expect(contents(s)).toBe(moved);
    s.close();
  });

  it('reapply determinism: applying the same log to two new documents gives content bytes and paths identical to the original edit', async () => {
    const live = session(pathSource());
    const ops: EditOp[] = [];
    ops.push(
      (await pathEdit(live, [pathAt(live, ...GRAY).paintSeq], { ...NO_EDIT, fill: [0, 0, 1] }))
        .committed.op,
    );
    ops.push(
      (
        await pathEdit(live, [pathAt(live, ...POLY).paintSeq], {
          ...NO_EDIT,
          transform: [1, 0, 0, 1, 5, 5],
        })
      ).committed.op,
    );
    ops.push(
      (await pathEdit(live, [pathAt(live, ...RED).paintSeq], { ...NO_EDIT, delete: true }))
        .committed.op,
    );
    const expected = contents(live);
    const a = session(pathSource());
    const b = session(pathSource());
    await a.replayEdits(structuredClone(ops));
    await b.replayEdits(structuredClone(ops));
    expect(contents(a)).toBe(expected);
    expect(contents(b)).toBe(expected);
    expect(painted(a)).toEqual(painted(live));
    // If the fingerprint differs (a different path), it fails without editing.
    const bad = structuredClone(ops) as EditPathOp[];
    bad[0]!.target.fingerprints[0]!.constructHash = '0';
    const c = session(pathSource());
    await expect(c.replayEdits(bad)).rejects.toThrow(/재적용 대상 패스가 다름/);
    for (const x of [live, a, b, c]) x.close();
  });

  it('a path edit after a paragraph edit shifted the later path paintSeq also gives the same result under log-order reapply', async () => {
    const live = session(pathSource());
    const grayBefore = pathAt(live, ...GRAY).paintSeq;
    const para = live.getPageLayout(0).paragraphs.find((p) => p.text.startsWith('Paragraph'))!;
    const ops: EditOp[] = [(await editParagraph(live, para.id, 'Edited 문단')).commit.op];
    const grayAfter = pathAt(live, ...GRAY).paintSeq;
    expect(grayAfter).toBe(grayBefore + 1);
    ops.push(
      (await pathEdit(live, [grayAfter], { ...NO_EDIT, transform: [1, 0, 0, 1, 0, 30] })).committed
        .op,
    );
    const replayed = session(pathSource());
    await replayed.replayEdits(structuredClone(ops));
    expect(contents(replayed)).toBe(contents(live));
    expect(painted(replayed)).toEqual(painted(live));
    for (const x of [live, replayed]) x.close();
  });

  it('redo preservation (review M1): cancelling without changes keeps redo, and cancelling after an update loses redo', async () => {
    const s = session(pathSource());
    const gray = pathAt(s, ...GRAY).paintSeq;
    await pathEdit(s, [gray], { ...NO_EDIT, fill: [0, 1, 0] });
    expect((await s.undo()).canRedo).toBe(true);

    // Begin → cancel without update: preparation does not change the document, so redo stays as is.
    const p1 = await s.planPathEdit(0, [gray]);
    const b1 = await s.beginPathEdit(0, [gray], p1.revision);
    const c1 = await s.cancelPathEdit(b1.draftId);
    expect(c1.canRedo).toBe(true);
    expect(s.document.canRedo()).toBe(true);
    expect((await s.redo()).canUndo).toBe(true);
    expect(pathAt(s, ...GRAY).color?.rgb).toEqual([0, 1, 0]);

    // Begin → actual update → cancel: the write changes the document and MuPDF discards the redo steps (they do not come back after cancel; documented behavior).
    expect((await s.undo()).canRedo).toBe(true);
    const p2 = await s.planPathEdit(0, [gray]);
    const b2 = await s.beginPathEdit(0, [gray], p2.revision);
    await s.updatePathDraft(b2.draftId, { ...NO_EDIT, fill: [1, 0, 0] }, 1);
    const c2 = await s.cancelPathEdit(b2.draftId);
    expect(c2.canRedo).toBe(false);
    expect(pathAt(s, ...GRAY).color?.rgb).toEqual([0.5, 0.5, 0.5]);
    s.close();
  });

  it('path edits persist after save and reopen and can be edited again', async () => {
    const s = session(pathSource());
    await pathEdit(s, [pathAt(s, ...GRAY).paintSeq], { ...NO_EDIT, fill: [0, 1, 0] });
    const saved = s.save({ changes: [] }).bytes;
    s.close();
    const r = session(saved);
    expect(pathAt(r, ...GRAY).color?.rgb).toEqual([0, 1, 0]);
    await pathEdit(r, [pathAt(r, ...GRAY).paintSeq], { ...NO_EDIT, transform: [1, 0, 0, 1, 3, 0] });
    expect(pathAt(r, GRAY[0] + 3, GRAY[1]).color?.rgb).toEqual([0, 1, 0]);
    r.close();
  });
});

describe('R-L3 release (real adapter)', () => {
  it('repeating open → paragraph and path edit → save → close does not keep growing the WASM heap', async () => {
    const source = pathSource();
    const cycle = async () => {
      const s = session(source);
      const para = s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith('Paragraph'))!;
      await editParagraph(s, para.id, 'Edited 문단 한글');
      await pathEdit(s, [pathAt(s, ...RED).paintSeq], { ...NO_EDIT, fill: [0, 0, 1] });
      s.save({ changes: [] });
      s.close();
    };
    for (let i = 0; i < 3; i++) await cycle();
    const warm = wasmHeapBytes();
    for (let i = 0; i < 12; i++) await cycle();
    const end = wasmHeapBytes();
    expect(warm).not.toBeNull();
    // The WASM heap never shrinks, so look at the amount of growth. Leaving copies of the fallback font (about 4 MB) to the GC grew the heap by 4–13 MB per cycle
    // (179 MB over 12 cycles, docs/m4-integration.md).
    expect(end! - warm!).toBeLessThan(16 * 1024 * 1024);
  }, 120_000);
});
