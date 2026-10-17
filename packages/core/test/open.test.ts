import { describe, expect, it } from 'vitest';
import { openPdf, wasmHeapBytes } from '../src/index.js';
import * as mupdf from 'mupdf';

function onePagePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, '0 0 1 rg 10 10 50 50 re f'));
  return doc.saveToBuffer('').asUint8Array().slice();
}

describe('openPdf', () => {
  it('MuPDF WASM 을 로드하고 PDF 를 연다', () => {
    const doc = openPdf(onePagePdf());
    expect(doc.countPages()).toBe(1);
    expect(doc.loadPage(0).getBounds()).toEqual([0, 0, 200, 100]);
    expect(wasmHeapBytes()).toBeGreaterThan(0);
  });

  it('PDF 가 아닌 입력은 예외', () => {
    expect(() => openPdf(new TextEncoder().encode('not a pdf'))).toThrow();
  });
});
