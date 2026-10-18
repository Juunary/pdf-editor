import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(src/wasm-module.ts).
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

/** 쪽 트리에 연결되지 않은 비압축 잡음 스트림을 많이 단 큰 PDF(열기·1쪽 렌더가 대부분을 읽지 않아야 한다). */
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

describe('Stream 입력(A3-1)', () => {
  it('세션은 기본으로 Stream 입력으로 열고, buffer 는 선택할 수 있다', () => {
    const s = new PdfSession();
    expect(s.open(threePagePdf()).inputMode).toBe('stream');
    expect(s.open(threePagePdf(), 'buffer').inputMode).toBe('buffer');
    s.close();
  });

  it('전체 저장 결과가 Buffer 입력과 바이트 동일(편집 포함)', () => {
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
    // 저장한 결과를 다시 열어 쪽 수를 확인한다.
    const reopened = openPdf(stream.bytes);
    expect(reopened.countPages()).toBe(2);
  });

  it('변경 없는 증분 저장 결과도 Buffer 입력과 바이트 동일', () => {
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

  it('열기와 1쪽 렌더가 읽는 양이 파일의 1/4 미만', () => {
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

  it('JS 래퍼를 놓은 뒤에도 문서를 렌더·저장할 수 있다', () => {
    const s = new PdfSession();
    s.open(threePagePdf());
    expect(s.renderPage({ pageIndex: 2, scale: 1 }).width).toBe(300);
    expect(s.save({ changes: ['content-stream'] }).bytes.byteLength).toBeGreaterThan(0);
    s.close();
  });

  it('저장 전 판정은 Stream 입력 배율(전체 3.48·증분 2.98), buffer 는 4.48·3.98', () => {
    const s = new PdfSession();
    s.open(threePagePdf());
    expect(s.planSave({ changes: ['content-stream'] }).heap.ratio).toBe(3.48);
    expect(s.planSave({ changes: [] }).heap.ratio).toBe(2.98);
    s.open(threePagePdf(), 'buffer');
    expect(s.planSave({ changes: ['content-stream'] }).heap.ratio).toBe(4.48);
    expect(s.planSave({ changes: [] }).heap.ratio).toBe(3.98);
    s.close();
  });
});
