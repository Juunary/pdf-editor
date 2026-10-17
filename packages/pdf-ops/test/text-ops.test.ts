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
  it('Identity-H 2바이트 hex, 줄마다 Tm, 클립 연산자 없음', () => {
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

  it('숫자·glyph id 형식', () => {
    expect(formatNumber(1 / 3)).toBe('0.333');
    expect(formatNumber(-0.0001)).toBe('0');
    expect(glyphHex([0xffff])).toBe('ffff');
    expect(() => glyphHex([0x10000])).toThrow();
  });
});

describe('appendPageContent / addPageFontResource', () => {
  it('원 콘텐츠를 q/Q 로 감싸고 새 스트림을 뒤에 붙인다', () => {
    const doc = new mupdf.PDFDocument();
    // 원 콘텐츠가 CTM 을 바꾸고 Q 없이 끝난다.
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, '2 0 0 2 0 0 cm'));
    const page = doc.loadPage(0);
    appendPageContent(doc, page, '0 0 1 rg 0 0 10 10 re f\n');
    const contents = page.getObject().get('Contents');
    expect(contents.isArray()).toBe(true);
    expect(contents.length).toBe(3);
    expect(contents.get(0).readStream().asString()).toBe('q\n');
    expect(contents.get(2).readStream().asString()).toMatch(/^Q\n0 0 1 rg/);
    // CTM 2배가 새 사각형에 적용되지 않았는지: (15,95) 는 흰색이어야 한다.
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (x: number, y: number) => pix.getPixels()[(y * pix.getWidth() + x) * 3 + 2];
    expect(at(5, 95)).toBe(255);
    expect(pix.getPixels()[(95 * pix.getWidth() + 15) * 3]).toBe(255);
  });

  it('상속 Resources 를 복사하고 겹치지 않는 이름을 쓴다', () => {
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
});
