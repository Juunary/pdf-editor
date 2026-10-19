import { describe, expect, it } from 'vitest';
// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(src/wasm-module.ts).
import { PdfSession } from '../src/index.js';
import * as mupdf from 'mupdf';
import { buildPdf } from './pdf-fixtures.js';

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
    expect(full.heap?.inputBytes).toBe(s.originalBytes.byteLength);
  });

  it('열기 결과의 입력 방식, 페이지 정보', () => {
    const s = new PdfSession();
    expect(s.open(bluePdf()).inputMode).toBe('stream');
    expect(s.getPageInfo(0)).toEqual({
      pageIndex: 0,
      bounds: [0, 0, 200, 100],
      size: { width: 200, height: 100 },
      rotation: 0,
    });
    s.close();
  });

  it('저장 전 판정은 저장하지 않고 방식·예상 피크 힙을 돌려준다', () => {
    const s = new PdfSession();
    s.open(bluePdf());
    const plan = s.planSave({ changes: ['content-stream'] });
    expect(plan.method).toBe('full');
    expect(plan.heap.level).toBe('ok');
    // pdf-ops 는 예상 피크를 정수 바이트로 반올림한다.
    expect(
      Math.abs(plan.heap.estimatedPeakBytes - plan.heap.inputBytes * plan.heap.ratio),
    ).toBeLessThanOrEqual(1);
    expect(s.planSave({ changes: [] }).method).toBe('incremental');
    s.close();
  });

  it('추출·검색 RPC 구현이 세션에 연결되어 있다', () => {
    const s = new PdfSession();
    s.open(
      buildPdf(['BT /F1 12 Tf 10 150 Td (find me) Tj ET', 'BT /F1 12 Tf 10 150 Td (other) Tj ET']),
    );
    expect(
      s
        .extractPage({ pageIndex: 0 })
        .chars.map((c) => c.text)
        .join(''),
    ).toBe('find me');
    expect(s.searchText({ query: 'other' }).hits.map((h) => h.pageIndex)).toEqual([1]);
    s.close();
  });

  it('쪽 SourceMap 을 캐시해 linkPage 의 unmatched 표시가 getSourceMap 결과에 남는다', () => {
    const s = new PdfSession();
    // core 알려진 한계(같은 자리 Tr 0 뒤 다른 BT 의 Tr 7)로 SourceMap 이 글리프 2개를 더 센다 → 짝 없는 연산.
    const show = (tr: number, body: string) => `BT /F1 12 Tf ${tr} Tr 10 150 Td ${body} ET`;
    s.open(
      buildPdf([
        `${show(0, '(AB) Tj')} 0 0 5 5 re f ${show(7, '(AB) Tj')}`,
        'BT /F1 12 Tf 10 150 Td (other) Tj ET',
      ]),
    );
    const before = s.getSourceMap(0);
    expect(s.getSourceMap(0)).toBe(before);
    const link = s.linkPage(0);
    expect(link.stats.glyphCountDelta).toBe(-2);
    const after = s.getSourceMap(0);
    expect(after).toBe(before);
    const unmatched = after.ops.filter((o) => o.limits.includes('unmatched'));
    expect(unmatched.map((o) => o.op)).toEqual(['Tj']);
    // 다시 매칭해도 표시는 한 번만.
    s.linkPage(0);
    expect(unmatched[0]!.limits.filter((r) => r === 'unmatched')).toHaveLength(1);

    // 쪽 캐시 무효화: 그 쪽만 다시 만든다.
    const other = s.getSourceMap(1);
    s.invalidatePageCache(0);
    expect(s.getSourceMap(0)).not.toBe(before);
    expect(s.getSourceMap(1)).toBe(other);
    s.invalidatePageCache();
    expect(s.getSourceMap(1)).not.toBe(other);
    s.close();
  });
});
