import { describe, expect, it } from 'vitest';
import { KINSOKU_HEAD, KINSOKU_TAIL, layoutParagraph } from '../src/index.js';
import { classifyCluster, normalBreakBefore } from '../src/text.js';
import { input, lineTexts } from './helpers.js';

// Test font size 10: Latin letter 5pt, space 2.5pt, Hangul/CJK 10pt.
const lines = (text: string, width: number, extra = {}) =>
  lineTexts(layoutParagraph(input(text, { area: [0, 0, width, 1000], ...extra })), text);

describe('line-break opportunities', () => {
  it('breaks after whitespace, and trailing whitespace stays on that line', () => {
    expect(lines('aaa bbb ccc', 35)).toEqual(['aaa bbb ', 'ccc']);
  });

  it('trailing whitespace is not counted in the width', () => {
    // "aaa bbb" = 32.5pt. It fits on the same line even with three trailing spaces.
    expect(lines('aaa bbb   ccc', 32.5)).toEqual(['aaa bbb   ', 'ccc']);
    const r = layoutParagraph(input('aaa bbb   ccc', { area: [0, 0, 32.5, 1000] }));
    expect(r.summary.lines[0]?.x1).toBeCloseTo(32.5, 9);
    // Trailing whitespace glyphs remain in the write list (word separation on extraction).
    expect(r.lines[0]?.map((g) => g.gid)).toEqual([97, 97, 97, 32, 98, 98, 98, 32, 32, 32]);
  });

  it('breaks after hyphens and dashes', () => {
    expect(lines('well-known', 30)).toEqual(['well-', 'known']);
    expect(lines('a—b', 16)).toEqual(['a—', 'b']);
  });

  it('does not make an ordinary break before a digit after a hyphen, or after a hyphen that follows whitespace', () => {
    const cls = [...'1-2'].map(classifyCluster);
    expect(normalBreakBefore(cls, 2)).toBe(false);
    const cls2 = [...' -x'].map(classifyCluster);
    expect(normalBreakBefore(cls2, 2)).toBe(false);
    const cls3 = [...'a-x'].map(classifyCluster);
    expect(normalBreakBefore(cls3, 2)).toBe(true);
  });

  it('breaks between CJK ideographs', () => {
    expect(lines('日本語の文章です', 35)).toEqual(['日本語', 'の文章', 'です']);
  });

  it('Hangul breaks per word unit (whitespace)', () => {
    expect(lines('가나 다라 마바', 50)).toEqual(['가나 다라 ', '마바']);
  });

  it('if a word is longer than the line width, it moves to the next line and then breaks per syllable', () => {
    expect(lines('가나다 라마바사아자차', 45)).toEqual(['가나다 ', '라마바사', '아자차']);
  });

  it('if a Latin word is longer than the line width, it breaks per character', () => {
    expect(lines('abcdefghij', 22)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('a character wider than the line width is still placed one per line (no infinite loop)', () => {
    expect(lines('가나', 5)).toEqual(['가', '나']);
    expect(lines('ab', 0)).toEqual(['a', 'b']);
  });

  it('forced line break', () => {
    expect(lines('ab\ncd', 100)).toEqual(['ab\n', 'cd']);
    expect(lines('ab\n', 100)).toEqual(['ab\n', '']);
    expect(lines('\n\n', 100)).toEqual(['\n', '\n', '']);
    expect(lines('ab\r\ncd', 100)).toEqual(['ab\r\n', 'cd']);
    const r = layoutParagraph(input('ab\ncd', {}));
    expect(r.summary.lines.map((l) => l.hardBreak)).toEqual([true, false]);
  });

  it('whitespace and forced line breaks right after an automatic line end attach to that line (no empty line is created)', () => {
    expect(lines('aaaa bbbb\ncc', 20)).toEqual(['aaaa ', 'bbbb\n', 'cc']);
    expect(lines('aaaa  \ncc', 20)).toEqual(['aaaa  \n', 'cc']);
    const r = layoutParagraph(input('aaaa  \ncc', { area: [0, 0, 20, 1000] }));
    expect(r.summary.lines[0]?.hardBreak).toBe(true);
  });
});

describe('kinsoku', () => {
  it('does not break before line-start-prohibited characters', () => {
    const out = lines('日本語。です', 30);
    expect(out[0]).toBe('日本');
    expect(out.some((l) => l.startsWith('。'))).toBe(false);
    expect(lines('word, next', 25)).toEqual(['word, ', 'next']);
    // Even after whitespace, a line does not start with a closing mark.
    expect(lines('aaa )', 15).some((l) => l.startsWith(')'))).toBe(false);
  });

  it('does not break after line-end-prohibited characters', () => {
    const out = lines('日本「語」です', 30);
    expect(out.some((l) => l.endsWith('「'))).toBe(false);
    expect(out.join('')).toBe('日本「語」です');
    // No break after an opening bracket + whitespace either (UAX #14 OP SP* ×).
    expect(lines('aa ( bb', 22).some((l) => l.endsWith('( '))).toBe(false);
  });

  it('emergency breaks also avoid kinsoku positions (when possible)', () => {
    // "abcd." at width 22 (4 characters): break into "abc" / "d." instead of "abcd" / ".".
    expect(lines('abcd.', 22)).toEqual(['abc', 'd.']);
  });

  it('the kinsoku table includes the characters of contract 5.4', () => {
    for (const ch of '.,:;!?)]}」』〉》’”%…·）') expect(KINSOKU_HEAD).toContain(ch);
    for (const ch of '([{「『〈《‘“（') expect(KINSOKU_TAIL).toContain(ch);
  });
});
