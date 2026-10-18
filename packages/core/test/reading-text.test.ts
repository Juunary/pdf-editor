import { describe, expect, it } from 'vitest';
import { PdfSession, assembleReadingText, foldWhitespace } from '../src/index.js';
import type { PageModel } from '@pdf-editor/shared-types';
import { buildPdf, hexGlyphs } from './pdf-fixtures.js';

/** 쪽 0 의 추출 모델과 MuPDF 구조화 텍스트 asText() 를 함께 돌려준다. */
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

describe('LineInfo.spaceAfter: 합성 공백 위치(계약 수정 5)', () => {
  it('TJ 간격으로만 단어를 나눈 줄: 공백 글리프가 없어도 조립 텍스트에 공백이 들어간다', () => {
    const { model, asText } = read(
      'BT /F1 12 Tf 10 150 Td [(Hello) -300 (world) -300 (again)] TJ ET',
    );
    expect(model.chars.map((c) => c.text).join('')).toBe('Helloworldagain');
    expect(model.lines).toHaveLength(1);
    // 'o'(4)와 'd'(9) 뒤에 합성 공백
    expect(model.lines[0]!.spaceAfter).toEqual([4, 9]);
    expect(assembleReadingText(model)).toBe('Hello world again');
    expectSameReadingText(model, asText);
  });

  it('실제 공백 글리프가 있는 문서: spaceAfter 는 비고 공백은 chars 에 있다', () => {
    const { model, asText } = read('BT /F1 12 Tf 10 150 Td (Hello world again) Tj ET');
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[]]);
    expect(model.chars.map((c) => c.text).join('')).toBe('Hello world again');
    expect(assembleReadingText(model)).toBe('Hello world again');
    expectSameReadingText(model, asText);
  });

  it('한글·영문 혼합 CID 폰트: 합성 공백과 줄·블록 구분이 구조화 텍스트와 공백 접기 기준으로 같다', () => {
    const { model, asText } = read(
      [
        `BT /F2 14 Tf 10 150 Td [${hexGlyphs('한글')} -300 ${hexGlyphs('ab')} -300 ${hexGlyphs('cd')}] TJ ET`,
        `BT /F1 12 Tf 10 100 Td [(second) -300 (line)] TJ ET`,
      ].join('\n'),
    );
    expect(model.blocks).toHaveLength(2);
    // CJK 와 영문 사이는 MuPDF 가 공백을 합성하지 않고, 영문 단어 사이만 합성한다.
    expect(model.lines[0]!.spaceAfter).toEqual([3]);
    expect(model.lines[1]!.spaceAfter).toEqual([5]);
    expect(assembleReadingText(model)).toBe('한글ab cd\n\nsecond line');
    expectSameReadingText(model, asText);
  });

  it('CJK 글자 사이의 간격은 공백이 아니다(MuPDF 가 합성하지 않으므로 spaceAfter 도 비다)', () => {
    const { model, asText } = read(
      `BT /F2 14 Tf 10 150 Td [${hexGlyphs('안녕')} -500 ${hexGlyphs('하세요')}] TJ ET`,
    );
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[]]);
    expectSameReadingText(model, asText);
  });

  it('큰 간격은 줄을 나누므로 공백이 아니라 줄바꿈', () => {
    const { model, asText } = read('BT /F1 12 Tf 10 150 Td [(A) -1000 (B)] TJ ET');
    expect(model.lines.map((l) => l.spaceAfter)).toEqual([[], []]);
    expectSameReadingText(model, asText);
  });

  it('줄 처음·끝의 합성 공백은 담지 않는다. 값은 오름차순이고 줄 안(마지막 글자 앞)에 있다', () => {
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

  it('Tr 4 의 구조화 텍스트 중복 줄은 조립 텍스트에 한 번만', () => {
    const { model } = read('BT /F1 12 Tf 4 Tr 10 150 Td [(Hel) -300 (lo)] TJ ET');
    expect(assembleReadingText(model)).toBe('Hel lo');
  });
});

describe('assembleReadingText', () => {
  it('줄 사이 "\\n", 블록 사이 "\\n\\n", spaceAfter 위치에 공백', () => {
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

  it('foldWhitespace: 연속 공백류를 하나로, 앞뒤 제거', () => {
    expect(foldWhitespace('  a \n\n b\t c  ')).toBe('a b c');
  });
});
