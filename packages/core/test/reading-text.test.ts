import { describe, expect, it } from 'vitest';
import { PdfSession, assembleReadingText, foldWhitespace } from '../src/index.js';
import type { PageModel } from '@pdf-editor/shared-types';
import { buildPdf, hexGlyphs } from './pdf-fixtures.js';

/** Returns the extraction model of page 0 together with the MuPDF structured text asText(). */
function read(content: string): { model: PageModel; asText: string } {
  const s = new PdfSession();
  s.open(buildPdf([content]));
  const model = s.extractPage({ pageIndex: 0 });
  const page = s.document.loadPage(0);
  const st = page.toStructuredText('');
  const asText = st.asText();
  st.destroy();
  page.destroy();
  s.close();
  return { model, asText };
}

function expectSameReadingText(model: PageModel, asText: string): void {
  expect(foldWhitespace(assembleReadingText(model))).toBe(foldWhitespace(asText));
}

describe('LineInfo.spaceAfter: synthetic space positions (contract amendment 5)', () => {
  it('a line split into words only by TJ gaps: spaces appear in the assembled text even without space glyphs', () => {
    const { model, asText } = read(
      'BT /F1 12 Tf 10 150 Td [(Hello) -300 (world) -300 (again)] TJ ET',
    );
    expect(model.chars.map((c) => c.text).join('')).toBe('Helloworldagain');
    expect(model.lines).toHaveLength(1);
    // synthetic space after 'o'(4) and 'd'(9)
    expect(model.lines[0]!.spaceAfter).toEqual([4, 9]);
    expect(assembleReadingText(model)).toBe('Hello world again');
    expectSameReadingText(model, asText);
  });

  it('a document with real space glyphs: spaceAfter is empty and the spaces are in chars', () => {
    const { model, asText } = read('BT /F1 12 Tf 10 150 Td (Hello world again) Tj ET');
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[]]);
    expect(model.chars.map((c) => c.text).join('')).toBe('Hello world again');
    expect(assembleReadingText(model)).toBe('Hello world again');
    expectSameReadingText(model, asText);
  });

  it('mixed Hangul/English CID font: synthetic spaces and line/block breaks match the structured text under whitespace folding', () => {
    const { model, asText } = read(
      [
        `BT /F2 14 Tf 10 150 Td [${hexGlyphs('한글')} -300 ${hexGlyphs('ab')} -300 ${hexGlyphs('cd')}] TJ ET`,
        `BT /F1 12 Tf 10 100 Td [(second) -300 (line)] TJ ET`,
      ].join('\n'),
    );
    expect(model.blocks).toHaveLength(2);
    // MuPDF does not synthesize a space between CJK and English, only between English words.
    expect(model.lines[0]!.spaceAfter).toEqual([3]);
    expect(model.lines[1]!.spaceAfter).toEqual([5]);
    expect(assembleReadingText(model)).toBe('한글ab cd\n\nsecond line');
    expectSameReadingText(model, asText);
  });

  it('gaps between CJK characters are not spaces (MuPDF does not synthesize them, so spaceAfter is empty too)', () => {
    const { model, asText } = read(
      `BT /F2 14 Tf 10 150 Td [${hexGlyphs('안녕')} -500 ${hexGlyphs('하세요')}] TJ ET`,
    );
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[]]);
    expectSameReadingText(model, asText);
  });

  it('a large gap splits the line, so it is a line break, not a space', () => {
    const { model, asText } = read('BT /F1 12 Tf 10 150 Td [(A) -1000 (B)] TJ ET');
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[], []]);
    expectSameReadingText(model, asText);
  });

  it('synthetic spaces at the start/end of a line are not included. Values are ascending and inside the line (before the last character)', () => {
    const { model } = read(
      'BT /F1 12 Tf 10 150 Td [(a) -250 (b) -250 (c) -250 (d) -250 (e)] TJ ET BT /F1 12 Tf 10 100 Td [(x) -300 (y)] TJ ET',
    );
    for (const line of model.lines) {
      expect(line.spaceAfter).toEqual([...new Set(line.spaceAfter)].sort((a, b) => a - b));
      for (const k of line.spaceAfter) {
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(line.chars.length - 1);
      }
    }
    expect(model.lines[0]!.spaceAfter).toEqual([0, 1, 2, 3]);
  });

  it('a duplicate structured-text line from Tr 4 appears only once in the assembled text', () => {
    const { model } = read('BT /F1 12 Tf 4 Tr 10 150 Td [(Hel) -300 (lo)] TJ ET');
    expect(assembleReadingText(model)).toBe('Hel lo');
  });
});

describe('assembleReadingText', () => {
  it('"\\n" between lines, "\\n\\n" between blocks, a space at spaceAfter positions', () => {
    const char = (text: string) => ({ text }) as PageModel['chars'][number];
    const line = (chars: number[], spaceAfter: number[], block: number) =>
      ({ chars, spaceAfter, block }) as PageModel['lines'][number];
    const model = {
      chars: ['a', 'b', 'c', 'd', 'e'].map(char),
      lines: [line([0, 1], [0], 0), line([2], [], 0), line([3, 4], [], 1)],
      blocks: [{ lines: [0, 1] }, { lines: [2] }],
    } as PageModel;
    expect(assembleReadingText(model)).toBe('a b\nc\n\nde');
  });

  it('foldWhitespace: collapses consecutive whitespace into one and trims both ends', () => {
    expect(foldWhitespace('  a \n\n b\t c  ')).toBe('a b c');
  });
});
