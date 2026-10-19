import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { embedFont, glyphHex, subsetFontBytes } from '../src/index.js';

/** A7-1: 폴백 폰트만 서브셋한다. 편집 중인 문서에서는 subsetFonts() 를 부르지 않는다. */
const FONT_PATH = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);
const FONT = new Uint8Array(readFileSync(FONT_PATH));
const TEXT = '한글 폴백 폰트 Hello';

function gidsFor(text: string): number[] {
  const font = new mupdf.Font('NotoSansKR', FONT);
  return [...text].filter((c) => c !== ' ').map((c) => font.encodeCharacter(c.codePointAt(0)!));
}

function renderWith(bytes: Uint8Array, gids: number[]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const ref = doc.addFont(new mupdf.Font('NotoSansKR', bytes));
  doc.insertPage(
    -1,
    doc.addPage(
      [0, 0, 300, 60],
      0,
      { Font: { F: ref } },
      `BT /F 24 Tf 10 20 Td <${glyphHex(gids)}> Tj ET`,
    ),
  );
  const reopened = mupdf.Document.openDocument(
    doc.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  );
  const pix = reopened
    .loadPage(0)
    .toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  return pix.getPixels().slice();
}

describe('subsetFontBytes(A7-1)', () => {
  it('쓰는 글리프만 남겨 크게 줄이고, glyph id 를 유지해 렌더가 원래 폰트와 같다', () => {
    const gids = gidsFor(TEXT);
    expect(gids.every((g) => g > 0)).toBe(true);
    const subset = subsetFontBytes('NotoSansKR', FONT, gids);
    expect(subset.byteLength).toBeLessThan(FONT.byteLength / 10);
    const full = new mupdf.Font('NotoSansKR', FONT);
    const small = new mupdf.Font('NotoSansKR', subset);
    for (const g of gids) expect(small.advanceGlyph(g)).toBeCloseTo(full.advanceGlyph(g), 6);
    const a = renderWith(FONT, gids);
    const b = renderWith(subset, gids);
    expect(b.length).toBe(a.length);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });
});

describe('embedFont(subsetGids) 는 문서의 다른 폰트를 바꾸지 않는다(C1)', () => {
  /** 임베드된 단순 TrueType 폰트(소수 /Widths 포함)를 쓰는 1쪽 문서. */
  function docWithSimpleFont(): { doc: mupdf.PDFDocument; widths: string; fileLength: number } {
    const doc = new mupdf.PDFDocument();
    const simple = doc.addSimpleFont(new mupdf.Font('NotoSansKR', FONT), 'Latin');
    const w = simple.get('Widths');
    for (let i = 0; i < Math.min(w.length, 10); i++) w.put(i, w.get(i).asNumber() + 0.3);
    doc.insertPage(
      -1,
      doc.addPage([0, 0, 300, 60], 0, { Font: { F1: simple } }, 'BT /F1 12 Tf 10 20 Td (AB) Tj ET'),
    );
    return {
      doc,
      widths: simple.get('Widths').toString(),
      fileLength: simple.get('FontDescriptor').get('FontFile2').readStream().getLength(),
    };
  }
  const simpleOf = (doc: mupdf.PDFDocument) =>
    doc.findPage(0).get('Resources').get('Font').get('F1');

  it('폴백 서브셋 임베드 후 저장해도 원본 단순 폰트의 /Widths·FontFile2 가 그대로다', () => {
    const { doc, widths, fileLength } = docWithSimpleFont();
    embedFont(doc, 'NotoSansKR', FONT, { subsetGids: gidsFor('한글') });
    const re = mupdf.Document.openDocument(
      doc.saveToBuffer('garbage=yes,compress').asUint8Array().slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    const f1 = simpleOf(re);
    expect(f1.get('Widths').toString()).toBe(widths);
    expect(f1.get('FontDescriptor').get('FontFile2').readStream().getLength()).toBe(fileLength);
  });

  it('대조: 편집 문서에서 subsetFonts() 를 부르면 원본 단순 폰트도 다시 쓴다', () => {
    const { doc, widths, fileLength } = docWithSimpleFont();
    doc.subsetFonts();
    const f1 = simpleOf(doc);
    const changed =
      f1.get('Widths').toString() !== widths ||
      f1.get('FontDescriptor').get('FontFile2').readStream().getLength() !== fileLength;
    // 이 단언이 실패하면 MuPDF 동작이 바뀐 것이다 → A7-1 재평가.
    expect(changed).toBe(true);
  });
});
