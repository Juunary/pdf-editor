import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  formatNumber,
  glyphHex,
  serializeTextBlock,
} from '../src/index.js';

describe('serializeTextBlock', () => {
  it('Identity-H 2-byte hex, Tm per line, no clip operators', () => {
    const s = serializeTextBlock({
      fontResource: 'FE0',
      fontSize: 11,
      color: [0, 0, 0],
      lines: [
        { x: 56, y: 700.5, gids: [1, 0x1234] },
        { x: 56, y: 685.1, gids: [] },
      ],
    });
    expect(s).toBe('q\nBT\n/FE0 11 Tf\n0 0 0 rg\n1 0 0 1 56 700.5 Tm\n<00011234> Tj\nET\nQ\n');
    expect(s).not.toMatch(/\bW\b/);
  });

  it('number and glyph id format', () => {
    expect(formatNumber(1 / 3)).toBe('0.333');
    expect(formatNumber(-0.0001)).toBe('0');
    expect(glyphHex([0xffff])).toBe('ffff');
    expect(() => glyphHex([0x10000])).toThrow();
  });
});

describe('appendPageContent / addPageFontResource', () => {
  it('wraps the original content in q/Q and appends a new stream after it', () => {
    const doc = new mupdf.PDFDocument();
    // The original content changes the CTM and ends without a Q.
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, '2 0 0 2 0 0 cm'));
    const page = doc.loadPage(0);
    appendPageContent(doc, page, '0 0 1 rg 0 0 10 10 re f\n');
    const contents = page.getObject().get('Contents');
    expect(contents.isArray()).toBe(true);
    expect(contents.length).toBe(3);
    expect(contents.get(0).readStream().asString()).toBe('q\n');
    expect(contents.get(2).readStream().asString()).toMatch(/^Q\n0 0 1 rg/);
    // Check that the 2x CTM was not applied to the new rectangle: (15,95) must be white.
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (x: number, y: number) => pix.getPixels()[(y * pix.getWidth() + x) * 3 + 2];
    expect(at(5, 95)).toBe(255);
    expect(pix.getPixels()[(95 * pix.getWidth() + 15) * 3]).toBe(255);
  });

  it('copies inherited Resources and uses non-colliding names', () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(
      -1,
      doc.addPage([0, 0, 100, 100], 0, { Font: { FE0: doc.addObject({ Type: 'Font' }) } }, ''),
    );
    const page = doc.loadPage(0);
    const ref = doc.addObject({ Type: 'Font' });
    expect(addPageFontResource(doc, page, ref)).toBe('FE1');
    expect(addPageFontResource(doc, page, ref)).toBe('FE2');
  });

  it('Resources shared by several pages (indirect object, direct sub-dictionary) are copied rather than modified', () => {
    const doc = new mupdf.PDFDocument();
    const shared = doc.addObject({ Font: { F1: doc.addObject({ Type: 'Font' }) } });
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, shared, ''));
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, shared, ''));
    const before = shared.resolve().toString();
    expect(addPageFontResource(doc, doc.loadPage(0), doc.addObject({ Type: 'Font' }))).toBe('FE0');
    expect(shared.resolve().toString()).toBe(before);
    expect(doc.findPage(1).get('Resources').asIndirect()).toBe(shared.asIndirect());
    expect(doc.findPage(0).get('Resources').get('Font').get('FE0').isNull()).toBe(false);
    expect(doc.findPage(0).get('Resources').get('Font').get('F1').isNull()).toBe(false);
  });
});
