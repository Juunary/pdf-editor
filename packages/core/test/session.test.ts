import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(src/wasm-module.ts).
import { PdfSession } from '../src/index.js';
import * as mupdf from 'mupdf';

/** 200x100pt, 왼쪽 절반 파란 사각형. */
function bluePdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, {}, '0 0 1 rg 0 0 100 100 re f'));
  return doc.saveToBuffer('').asUint8Array().slice();
}

describe('PdfSession', () => {
  it('열기 → 1페이지 RGBA 렌더(불투명 흰 배경)', () => {
    const s = new PdfSession();
    const info = s.open(bluePdf());
    expect(info.pageCount).toBe(1);
    expect(info.firstPage).toEqual({ width: 200, height: 100 });

    const page = s.renderPage({ pageIndex: 0, scale: 2 });
    expect([page.width, page.height]).toEqual([400, 200]);
    expect(page.rgba.length).toBe(400 * 200 * 4);
    const px = (x: number, y: number) =>
      Array.from(page.rgba.subarray((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
    expect(px(50, 100)).toEqual([0, 0, 255, 255]);
    expect(px(350, 100)).toEqual([255, 255, 255, 255]);
    s.close();
  });

  it('변경 없는 저장은 증분, redaction 포함은 전체 저장', () => {
    const s = new PdfSession();
    s.open(bluePdf());
    const inc = s.save({ changes: [] });
    expect(inc.method).toBe('incremental');
    expect(inc.canBeSavedIncrementally).toBe(true);
    expect(new TextDecoder().decode(inc.bytes.subarray(0, 5))).toBe('%PDF-');

    const full = s.save({ changes: ['redaction'] });
    expect(full.method).toBe('full');
    expect(full.wasmHeapBytes).toBeGreaterThan(0);
  });
});
