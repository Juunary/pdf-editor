import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { countRedactAnnots, redactRegions, TEXT_REPLACE_REDACTION } from '../src/index.js';

/** 200x100pt: blue background, horizontal line (y=30, crossing "DROP"), "KEEP" (top) / "DROP" (bottom) text. */
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
  it('default options remove text, preserve line art/images, and draw no black box', () => {
    expect(TEXT_REPLACE_REDACTION).toEqual({
      blackBoxes: false,
      imageMethod: mupdf.PDFPage.REDACT_IMAGE_NONE,
      lineArtMethod: mupdf.PDFPage.REDACT_LINE_ART_NONE,
      textMethod: mupdf.PDFPage.REDACT_TEXT_REMOVE,
    });
  });

  it('erases only text inside the region and keeps lines and background (pixel-identical to the expected page)', () => {
    const { doc, page } = samplePage();
    // MuPDF coordinates: y points down. "DROP" baseline y=25 -> page coordinate y≈75.
    redactRegions(page, [[0, 60, 200, 80]]);
    const after = doc.loadPage(0);
    expect(text(after)).toContain('KEEP');
    expect(text(after)).not.toContain('DROP');
    const render = (p: mupdf.Page) =>
      p.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false).getPixels();
    expect(render(after)).toEqual(render(samplePage(false).page));
  });

  it('does not apply Redact annotations that were already present', () => {
    const { doc, page } = samplePage();
    const existing = page.createAnnotation('Redact');
    existing.setRect([0, 20, 200, 40]); // "KEEP" region
    const r = redactRegions(page, [[0, 60, 200, 80]]);
    expect(r.preexistingRedactAnnots).toBe(1);
    const after = doc.loadPage(0);
    expect(text(after)).toContain('KEEP');
    expect(countRedactAnnots(after)).toBe(1);
  });
});
