import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { countRedactAnnots, redactRegions, TEXT_REPLACE_REDACTION } from '../src/index.js';

/** 200x100pt: 파란 배경, 가로선(y=30, "DROP" 을 가로지름), "KEEP"(위) / "DROP"(아래) 텍스트. */
function samplePage(withDrop = true): { doc: mupdf.PDFDocument; page: mupdf.PDFPage } {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const content = [
    '0.8 0.9 1 rg 0 0 200 100 re f',
    '0 0 0 RG 1 w 0 30 m 200 30 l S',
    'BT /F1 12 Tf 0 0 0 rg 10 70 Td (KEEP) Tj ET',
    withDrop ? 'BT /F1 12 Tf 0 0 0 rg 10 25 Td (DROP) Tj ET' : '',
  ].join('\n');
  doc.insertPage(-1, doc.addPage([0, 0, 200, 100], 0, { Font: { F1: font } }, content));
  return { doc, page: doc.loadPage(0) };
}

const text = (page: mupdf.PDFPage) => page.toStructuredText('').asText();

describe('redactRegions', () => {
  it('기본 옵션은 텍스트 제거·선화/이미지 보존·검은 상자 없음', () => {
    expect(TEXT_REPLACE_REDACTION).toEqual({
      blackBoxes: false,
      imageMethod: mupdf.PDFPage.REDACT_IMAGE_NONE,
      lineArtMethod: mupdf.PDFPage.REDACT_LINE_ART_NONE,
      textMethod: mupdf.PDFPage.REDACT_TEXT_REMOVE,
    });
  });

  it('영역 안 텍스트만 지우고 선·배경은 남긴다(기대 페이지와 픽셀 일치)', () => {
    const { doc, page } = samplePage();
    // MuPDF 좌표: y 아래 방향. "DROP" 기준선 y=25 → 페이지 좌표 y≈75.
    redactRegions(page, [[0, 60, 200, 80]]);
    const after = doc.loadPage(0);
    expect(text(after)).toContain('KEEP');
    expect(text(after)).not.toContain('DROP');
    const render = (p: mupdf.Page) =>
      p.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false).getPixels();
    expect(render(after)).toEqual(render(samplePage(false).page));
  });

  it('원래 있던 Redact 주석은 적용하지 않는다', () => {
    const { doc, page } = samplePage();
    const existing = page.createAnnotation('Redact');
    existing.setRect([0, 20, 200, 40]); // "KEEP" 영역
    const r = redactRegions(page, [[0, 60, 200, 80]]);
    expect(r.preexistingRedactAnnots).toBe(1);
    const after = doc.loadPage(0);
    expect(text(after)).toContain('KEEP');
    expect(countRedactAnnots(after)).toBe(1);
  });
});
