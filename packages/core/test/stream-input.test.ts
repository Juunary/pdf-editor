import { describe, expect, it } from 'vitest';
// core must be imported before mupdf so that the WASM heap probe object is attached (src/wasm-module.ts).
import { PdfSession, openPdf, renderPageRgba } from '../src/index.js';
import * as mupdf from 'mupdf';
import { buildPdf } from './pdf-fixtures.js';

function threePagePdf(): Uint8Array {
  return buildPdf([
    'BT /F1 12 Tf 10 150 Td (page one) Tj ET',
    'BT /F1 12 Tf 10 150 Td (page two) Tj ET',
    'BT /F1 12 Tf 10 150 Td (page three) Tj ET',
  ]);
}

/** A large PDF with many uncompressed noise streams not linked to the page tree (open and page-1 render must not read most of it). */
function largePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 200, 100], 0, { Font: { F1: font } }, 'BT /F1 12 Tf 10 50 Td (big) Tj ET'),
  );
  const noise = new Uint8Array(256 * 1024);
  let x = 12345;
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < noise.length; j++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      noise[j] = x >>> 24;
    }
    doc.addStream(noise, {});
  }
  return doc.saveToBuffer('').asUint8Array().slice();
}

describe('Stream input (A3-1)', () => {
  it('the session opens with Stream input by default, and buffer can be selected', () => {
    const s = new PdfSession();
    expect(s.open(threePagePdf()).inputMode).toBe('stream');
    expect(s.open(threePagePdf(), 'buffer').inputMode).toBe('buffer');
    s.close();
  });

  it('full save output is byte-identical to Buffer input (including edits)', () => {
    const bytes = threePagePdf();
    const save = (mode: 'buffer' | 'stream') => {
      const s = new PdfSession();
      s.open(bytes, mode);
      s.document.deletePage(1);
      const result = s.save({ changes: ['content-stream'] });
      s.close();
      return result;
    };
    const buffer = save('buffer');
    const stream = save('stream');
    expect(stream.method).toBe('full');
    expect(Buffer.from(stream.bytes).equals(Buffer.from(buffer.bytes))).toBe(true);
    // Reopen the saved result and check the page count.
    const reopened = openPdf(stream.bytes);
    expect(reopened.countPages()).toBe(2);
  });

  it('incremental save output without changes is also byte-identical to Buffer input', () => {
    const bytes = threePagePdf();
    const save = (mode: 'buffer' | 'stream') => {
      const s = new PdfSession();
      s.open(bytes, mode);
      const result = s.save({ changes: [] });
      s.close();
      return result;
    };
    const buffer = save('buffer');
    const stream = save('stream');
    expect(stream.method).toBe('incremental');
    expect(Buffer.from(stream.bytes).equals(Buffer.from(buffer.bytes))).toBe(true);
  });

  it('open and page-1 render read less than 1/4 of the file', () => {
    const bytes = largePdf();
    expect(bytes.byteLength).toBeGreaterThan(4 * 1024 * 1024);
    let read = 0;
    const doc = openPdf(bytes, { inputMode: 'stream', onRead: (n) => (read += n) });
    expect(doc.countPages()).toBe(1);
    const page = doc.loadPage(0);
    renderPageRgba(page, 1);
    page.destroy();
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(bytes.byteLength / 4);
    doc.destroy();
  });

  it('the document can still be rendered and saved after the JS wrapper is released', () => {
    const s = new PdfSession();
    s.open(threePagePdf());
    expect(s.renderPage({ pageIndex: 2, scale: 1 }).width).toBe(300);
    expect(s.save({ changes: ['content-stream'] }).bytes.byteLength).toBeGreaterThan(0);
    s.close();
  });

  it('the pre-save check uses the coefficient model for Stream input (M5 D5), and the scale model 4.48·3.98 for buffer', () => {
    const s = new PdfSession();
    s.open(threePagePdf());
    const stats = s.documentStats();
    const full = s.planSave({ changes: ['content-stream'] }).heap;
    expect(full).toMatchObject({
      model: 'step-v2',
      objectCount: stats.objectCount,
      rawStreamBytes: stats.rawStreamBytes,
      journalBytes: 0,
      level: 'ok',
    });
    expect(s.planSave({ changes: [] }).heap.model).toBe('step-v2');
    s.open(threePagePdf(), 'buffer');
    expect(s.planSave({ changes: ['content-stream'] }).heap.model).toBe('ratio-v0');
    expect(s.planSave({ changes: ['content-stream'] }).heap.ratio).toBe(4.48);
    expect(s.planSave({ changes: [] }).heap.ratio).toBe(3.98);
    s.close();
  });
});
