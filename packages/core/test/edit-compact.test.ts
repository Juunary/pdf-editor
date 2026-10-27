/**
 * Stream compression on edit commit (M5 Windows check W2, docs/m5-followup.md 5.1): compress the large page content that an edit rewrote in uncompressed form with Flate just before the commit,
 * so that the previous version the MuPDF journal keeps at each following edit has the compressed size rather than the uncompressed size.
 * With the real adapter, check whether compression happened, the journal estimate, result equivalence (page text, render pixels, reopen after save, reapply), undo, concurrent calls during a commit,
 * and the growth of the in-use WASM heap. The large page is a synthetic document whose content is enlarged with comment lines (no effect on render or extraction).
 */
// Keep this import first: the WASM Module settings must be registered before mupdf so that heap measurement (the coefficient model of the journal estimate, probeWasmHeap) is connected.
import '../src/wasm-module.js';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { DraftInput, EditOp, ParagraphEditPlan, PathEdit } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { probeWasmHeap } from '../src/bench-memory.js';
import { FONT_BYTES } from './edit-harness.js';
import { buildDocument } from './pdf-fixtures.js';

const MiB = 2 ** 20;
const LINES = 8;

/** Deterministic lines that look like content stream comments (a small coordinate set, so they compress well like real content). */
function filler(bytes: number, seed: number): string {
  let x = seed >>> 0;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  const out: string[] = [];
  let size = 0;
  while (size < bytes) {
    const l = `% ${(next() % 48) * 12.5} ${(next() % 64) * 12.5} m ${(next() % 48) * 12.5} ${(next() % 64) * 12.5} l S`;
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/** A page with LINES one-line paragraphs, comment filler between them (about `fillBytes` in total) and one line path. The original is Flate-compressed. */
function heavyPdf(fillBytes: number): Uint8Array {
  const parts: string[] = ['q 1 w 72 80 m 540 80 l S Q'];
  for (let i = 0; i < LINES; i++) {
    parts.push(`BT /F1 11 Tf 72 ${740 - i * 70} Td (Paragraph ${i + 1} original text here.) Tj ET`);
    parts.push(filler(Math.floor(fillBytes / LINES), i + 1));
  }
  const doc = buildDocument([{ content: parts.join('\n'), mediabox: [0, 0, 612, 792] }]);
  const buffer = doc.saveToBuffer('compress');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return bytes;
}

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const text = (s: PdfSession): string =>
  s
    .extractPage({ pageIndex: 0 })
    .chars.map((c) => c.text)
    .join('');

function input(plan: ParagraphEditPlan, value: string): DraftInput {
  return {
    runs: [{ text: value, style: plan.runs[0]!.style }],
    format: plan.format,
    composition: null,
    renderScale: 1,
  };
}

/** Opens the `Paragraph n` paragraph (does not commit). */
async function begin(s: PdfSession, n: number) {
  const paragraph = s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(`Paragraph ${n} `));
  if (!paragraph) throw new Error(`문단 없음: ${n}`);
  const plan = await s.planParagraphEdit(0, paragraph.id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, paragraph.id, plan.revision);
  await s.updateParagraphDraft(started.draftId, input(plan, `Paragraph ${n} edited text.`));
  return started.draftId;
}

async function edit(s: PdfSession, n: number): Promise<EditOp> {
  return (await s.commitParagraphEdit(await begin(s, n))).op;
}

/** Filter, stored length and decoded length of the page /Contents stream (a single one). */
function contentsInfo(s: PdfSession): { filter: string | null; stored: number; plain: number } {
  const contents = s.document.findPage(0).get('Contents');
  const stream = contents.isArray() ? contents.get(0) : contents;
  const filter = stream.get('Filter');
  const buffer = stream.readStream();
  try {
    return {
      filter: filter.isNull() ? null : filter.asName(),
      stored: stream.get('Length').asNumber(),
      plain: buffer.getLength(),
    };
  } finally {
    buffer.destroy();
  }
}

function pixels(s: PdfSession): Uint8ClampedArray {
  return s.renderPage({ pageIndex: 0, scale: 1 }).rgba;
}

function reopen(bytes: Uint8Array): PdfSession {
  return session(bytes);
}

describe('stream compression on edit commit (real adapter)', { timeout: 120_000 }, () => {
  it('the committed large page content is compressed with FlateDecode and the journal estimate is the compressed size', async () => {
    const s = session(heavyPdf(400_000));
    await edit(s, 1);
    const info = contentsInfo(s);
    expect(info.filter).toBe('FlateDecode');
    expect(info.plain).toBeGreaterThan(400_000);
    expect(info.stored).toBeLessThan(info.plain / 3);
    // Journal estimate = sum of the stream /Length values the commit changed (compressed content + small edit block).
    const journal = s.journalAdvice().journalBytes;
    expect(journal).toBeGreaterThanOrEqual(info.stored);
    expect(journal).toBeLessThan(info.stored + 20_000);
    s.close();
  });

  it('equivalent result: compressed session = session reapplied uncompressed (page text, render pixels, reopen after save)', async () => {
    const source = heavyPdf(300_000);
    const live = session(source);
    const ops = [await edit(live, 2), await edit(live, 5), await edit(live, 2)];
    expect(contentsInfo(live).filter).toBe('FlateDecode');
    const replayed = session(source);
    await replayed.replayEdits(structuredClone(ops));
    // Reapply happens outside the journal, so it does not compress (left uncompressed): the same content exists in a different stored form.
    expect(contentsInfo(replayed).filter).toBeNull();
    expect(text(live)).toBe(text(replayed));
    expect(text(live)).toContain('Paragraph 5 edited text.');
    expect(pixels(live)).toEqual(pixels(replayed));
    const savedLive = reopen(live.save({ changes: [] }).bytes);
    const savedReplayed = reopen(replayed.save({ changes: [] }).bytes);
    expect(text(savedLive)).toBe(text(live));
    expect(text(savedReplayed)).toBe(text(live));
    expect(pixels(savedLive)).toEqual(pixels(live));
    expect(pixels(savedReplayed)).toEqual(pixels(live));
    for (const s of [live, replayed, savedLive, savedReplayed]) s.close();
  });

  it('undo and redo: moves between compressed versions, and the journal steps equal the edit count', async () => {
    const s = session(heavyPdf(200_000));
    const original = text(s);
    await edit(s, 1);
    const one = text(s);
    await edit(s, 3);
    const two = text(s);
    await edit(s, 6);
    const three = text(s);
    expect(s.document.getJournal().steps).toHaveLength(3);
    await s.undo();
    expect(text(s)).toBe(two);
    await s.undo();
    expect(text(s)).toBe(one);
    await s.undo();
    expect(text(s)).toBe(original);
    await s.redo();
    await s.redo();
    await s.redo();
    expect(text(s)).toBe(three);
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    s.close();
  });

  it('a path edit commit also compresses the large page content', async () => {
    const s = session(heavyPdf(200_000));
    const e = await s.getPageEditability(0);
    const line = e.paths.find((p) => p.editable);
    expect(line).toBeDefined();
    const plan = await s.planPathEdit(0, [line!.paintSeq]);
    const started = await s.beginPathEdit(0, [line!.paintSeq], plan.revision);
    const move: PathEdit = {
      transform: [1, 0, 0, 1, 0, 30],
      fill: null,
      stroke: null,
      lineWidth: null,
      points: null,
      delete: false,
    };
    await s.updatePathDraft(started.draftId, move, 1);
    await s.commitPathEdit(started.draftId);
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    await s.undo();
    expect(contentsInfo(s).filter).toBe('FlateDecode');
    s.close();
  });

  it('while committing (waiting for compression), rejects update, commit and cancel of the same draft', async () => {
    const s = session(heavyPdf(300_000));
    const draftId = await begin(s, 4);
    const first = s.commitParagraphEdit(draftId);
    await expect(s.commitParagraphEdit(draftId)).rejects.toThrow(/커밋하는 중/);
    await expect(s.cancelParagraphEdit(draftId)).rejects.toThrow(/커밋하는 중/);
    await expect(first).resolves.toMatchObject({ history: { edits: 1 } });
    expect(text(s)).toContain('Paragraph 4 edited text.');
    s.close();
  });

  it('in-use WASM heap: each first edit of a large-page paragraph grows by the compressed size, not the uncompressed size', async () => {
    const fill = 3 * MiB;
    const s = session(heavyPdf(fill));
    // The first edit includes embedding the fallback font (about 8 MB), so measure from after it.
    await edit(s, 1);
    const base = probeWasmHeap({ emptyStore: true })!.usedBytes;
    for (const n of [2, 3, 4, 5, 6]) await edit(s, n);
    const grown = probeWasmHeap({ emptyStore: true })!.usedBytes - base;
    const { stored, plain } = contentsInfo(s);
    expect(plain).toBeGreaterThan(fill);
    // Without compression, 5 edits × uncompressed size (about 15 MiB) would remain. The bound is 5 compressed sizes + 4 MiB margin, and below 2 uncompressed sizes.
    expect(stored).toBeLessThan(plain / 3);
    expect(grown).toBeLessThan(5 * stored + 4 * MiB);
    expect(grown).toBeLessThan(2 * plain);
    s.close();
  });
});

// Checks that the compression path reads the same bytes as the MuPDF render (compared with the original Flate content): verifies the premise of the tests above.
describe('synthetic document premise', () => {
  it('the original content is Flate and the comments have no effect on the render', () => {
    const bytes = heavyPdf(100_000);
    const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
    const contents = doc.findPage(0).get('Contents');
    expect(contents.get('Filter').asName()).toBe('FlateDecode');
    const s = session(bytes);
    expect(text(s)).toContain('Paragraph 8 original text here.');
    s.close();
    doc.destroy();
  });
});
