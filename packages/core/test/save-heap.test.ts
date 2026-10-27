// M5 S1 save heap model (docs/m5-heap.md): document statistics, journal retention estimate, planSave input.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PdfSession, wasmHeapBytes } from '../src/index.js';
import { computeDocumentStats, objectStreamNumbers, openPdf } from '../src/open.js';
import * as mupdf from 'mupdf';
import { buildPdf } from './pdf-fixtures.js';
import { editParagraph, harness } from './edit-harness.js';

/** A PDF saved with 2 image streams (known original lengths) and an object stream structure. */
function statsPdf(objstms: boolean): { bytes: Uint8Array; streamBytes: number[] } {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const a = new Uint8Array(1000).fill(7);
  const b = new Uint8Array(333).fill(9);
  doc.addStream(a, {});
  doc.addStream(b, {});
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 200, 100], 0, { Font: { F1: font } }, 'BT /F1 12 Tf 10 50 Td (s) Tj ET'),
  );
  const buffer = doc.saveToBuffer(objstms ? 'objstms' : '');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return { bytes, streamBytes: [a.length, b.length] };
}

describe('computeDocumentStats(D5)', () => {
  it('counts the object count, stream count and the sum of original stream /Length exhaustively (no decoding)', () => {
    const { bytes } = statsPdf(false);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const stats = computeDocumentStats(doc);
    let streams = 0;
    let length = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const o = doc.newIndirect(n);
      if (o.isStream()) {
        streams++;
        length += o.get('Length').asNumber();
      }
    }
    expect(stats).toEqual({
      objectCount: doc.countObjects(),
      streamCount: streams,
      rawStreamBytes: length,
      objectStreamBytes: 0,
      approximate: false,
    });
    expect(streams).toBeGreaterThanOrEqual(3);
    expect(length).toBeGreaterThanOrEqual(1333);
    doc.destroy();
  });

  it('object streams add their decoded size to objectStreamBytes', () => {
    const doc = openPdf(statsPdf(true).bytes, { inputMode: 'stream' });
    const stats = computeDocumentStats(doc);
    let decoded = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const o = doc.newIndirect(n);
      if (o.isStream() && o.get('Type').asName() === 'ObjStm')
        decoded += o.readStream().getLength();
    }
    expect(decoded).toBeGreaterThan(0);
    expect(stats.objectStreamBytes).toBe(decoded);
    doc.destroy();
  });

  it('when the expected time seen from the trial sample exceeds the budget, it is extrapolated from a stratified sample (approximate)', () => {
    const pages = Array.from({ length: 600 }, (_, i) => `BT /F1 9 Tf 10 50 Td (p${i}) Tj ET`);
    const bytes = buildPdf(pages);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const exact = computeDocumentStats(doc);
    // A clock that advances 1 ms per call: the per-object time of the trial sample (interval 64) is large, so the exhaustive estimate exceeds the budget.
    let t = 0;
    const approx = computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1), bytes });
    expect(approx.approximate).toBe(true);
    expect(approx.objectCount).toBe(exact.objectCount);
    // Sample value × interval: the last sample counts only the remainder, so the stream count never exceeds the object count.
    expect(approx.streamCount).toBeLessThanOrEqual(exact.objectCount);
    expect(approx.streamCount).toBeGreaterThan(0);
    // Even in a document where the same layout (page, content) repeats for every page, a whole kind is not missed (picking only the first object of each interval would miss it).
    // The byte sum is far off if a few large streams (here, font files) are missed (a limit of sampling, docs/m5-heap.md 2.4).
    expect(Math.abs(approx.streamCount - exact.streamCount) / exact.streamCount).toBeLessThan(0.35);
    // With a generous budget, exhaustive.
    expect(computeDocumentStats(doc, { budgetMs: 1e9 })).toEqual(exact);
    // Without the original bytes the object stream numbers are unknown, so exhaustive even over budget (M1).
    t = 0;
    expect(computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1) })).toEqual(exact);
    doc.destroy();
  });

  it('even when sampled, the decoded object stream size is the exhaustive value of the object streams found in the xref (M1)', () => {
    // Save objects worth 600 pages as object streams: most objects are compressed and object streams are rare.
    const src = openPdf(
      buildPdf(Array.from({ length: 600 }, (_, i) => `BT /F1 9 Tf 10 50 Td (p${i}) Tj ET`)),
      { inputMode: 'buffer' },
    );
    const saved = src.saveToBuffer('objstms');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    src.destroy();
    const doc = openPdf(bytes, { inputMode: 'stream' });
    const exact = computeDocumentStats(doc);
    expect(exact.objectStreamBytes).toBeGreaterThan(0);
    const numbers = objectStreamNumbers(doc, bytes);
    expect(numbers?.size).toBeGreaterThan(0);
    let t = 0;
    const approx = computeDocumentStats(doc, { budgetMs: 0.5, now: () => (t += 1), bytes });
    expect(approx.approximate).toBe(true);
    expect(approx.objectStreamBytes).toBe(exact.objectStreamBytes);
    doc.destroy();
  });

  it('when the xref cannot be read the object stream numbers are null, and an empty set when there is only a traditional table', () => {
    const bytes = buildPdf(['BT /F1 9 Tf 10 50 Td (a) Tj ET']);
    const doc = openPdf(bytes, { inputMode: 'stream' });
    expect(objectStreamNumbers(doc, bytes)).toEqual(new Set());
    expect(objectStreamNumbers(doc, new Uint8Array(10))).toBeNull();
    const shifted = new Uint8Array(bytes.length + 7);
    shifted.set(new TextEncoder().encode('garbage'), 0);
    shifted.set(bytes, 7);
    expect(objectStreamNumbers(doc, shifted)).toBeNull();
    doc.destroy();
  });
});

describe('PdfSession save heap input', () => {
  afterEach(() => vi.useRealTimers());

  it('schedules the statistics computation once after the first full page render, and cancels it on close', () => {
    vi.useFakeTimers();
    const s = new PdfSession();
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    expect(vi.getTimerCount()).toBe(0);
    s.renderPage({ pageIndex: 0, scale: 1 });
    s.renderPage({ pageIndex: 0, scale: 1 });
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    const stats = s.documentStats();
    expect(s.documentStats()).toBe(stats);
    s.renderPage({ pageIndex: 0, scale: 1 });
    expect(vi.getTimerCount()).toBe(0);
    s.close();
    const t = new PdfSession();
    t.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    t.renderPage({ pageIndex: 0, scale: 1 });
    t.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('journal retention estimate: adds the page content /Length on each commit, keeps it on undo, and subtracts that amount for a new edit that discards redo', async () => {
    const { s } = harness();
    expect(s.planSave({ changes: [] }).heap.journalBytes).toBe(0);
    await editParagraph(s, 1, 'first edit');
    const one = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(one).toBeGreaterThan(0);
    await editParagraph(s, 1, 'second edit');
    const two = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(two).toBeGreaterThan(one);
    await s.undo();
    expect(s.planSave({ changes: [] }).heap.journalBytes).toBe(two);
    // New edit after undo: the redo step (the second edit) disappears.
    await editParagraph(s, 1, 'third edit');
    const three = s.planSave({ changes: [] }).heap.journalBytes!;
    expect(three).toBeLessThan(two + (two - one));
    expect(s.journalAdvice()).toMatchObject({ advised: false, journalBytes: three });
    s.close();
  });

  it('the post-save check does not count the heap released after saving as in use (H1)', () => {
    const s = new PdfSession();
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (a) Tj ET']));
    const first = s.planSave({ changes: ['content-stream'] }).heap;
    expect(first.priorSavePeakBytes).toBeUndefined();
    expect(first.usedHeapBytes).toBe(wasmHeapBytes());
    const saved = s.save({ changes: ['content-stream'] });
    const second = s.planSave({ changes: ['content-stream'] }).heap;
    expect(second.priorSavePeakBytes).toBe(saved.wasmHeapBytes);
    // If the heap did not grow after saving, the in-use estimate stays at the value from the first save.
    const grown = Math.max(0, wasmHeapBytes()! - saved.wasmHeapBytes!);
    expect(second.usedHeapBytes).toBe(first.usedHeapBytes! + grown);
    // Reopening clears the record.
    s.open(buildPdf(['BT /F1 12 Tf 10 50 Td (b) Tj ET']));
    expect(s.planSave({ changes: [] }).heap.priorSavePeakBytes).toBeUndefined();
    s.close();
  });
});
