import { describe, expect, it } from 'vitest';
import { KINSOKU_HEAD, KINSOKU_TAIL, layoutParagraph } from '../src/index.js';
import { classifyCluster, normalBreakBefore } from '../src/text.js';
import { input, lineTexts } from './helpers.js';

// 시험 폰트 크기 10: 라틴 글자 5pt, 공백 2.5pt, 한글·CJK 10pt.
const lines = (text: string, width: number, extra = {}) =>
  lineTexts(layoutParagraph(input(text, { area: [0, 0, width, 1000], ...extra })), text);

describe('줄 나눔 기회', () => {
  it('공백 뒤에서 나누고 줄 끝 공백은 그 줄에 남는다', () => {
    expect(lines('aaa bbb ccc', 35)).toEqual(['aaa bbb ', 'ccc']);
  });

  it('줄 끝 공백은 폭에 넣지 않는다', () => {
    // "aaa bbb" = 32.5pt. 뒤 공백 세 개가 있어도 같은 줄에 들어간다.
    expect(lines('aaa bbb   ccc', 32.5)).toEqual(['aaa bbb   ', 'ccc']);
    const r = layoutParagraph(input('aaa bbb   ccc', { area: [0, 0, 32.5, 1000] }));
    expect(r.summary.lines[0]?.x1).toBeCloseTo(32.5, 9);
    // 줄 끝 공백 글리프는 쓰기 목록에 남는다(추출 시 단어 분리).
    expect(r.lines[0]?.map((g) => g.gid)).toEqual([97, 97, 97, 32, 98, 98, 98, 32, 32, 32]);
  });

  it('하이픈·대시 뒤에서 나눈다', () => {
    expect(lines('well-known', 30)).toEqual(['well-', 'known']);
    expect(lines('a—b', 16)).toEqual(['a—', 'b']);
  });

  it('숫자 앞 하이픈, 공백 뒤 하이픈 뒤에서는 일반 나눔을 하지 않는다', () => {
    const cls = [...'1-2'].map(classifyCluster);
    expect(normalBreakBefore(cls, 2)).toBe(false);
    const cls2 = [...' -x'].map(classifyCluster);
    expect(normalBreakBefore(cls2, 2)).toBe(false);
    const cls3 = [...'a-x'].map(classifyCluster);
    expect(normalBreakBefore(cls3, 2)).toBe(true);
  });

  it('CJK 표의문자 사이에서 나눈다', () => {
    expect(lines('日本語の文章です', 35)).toEqual(['日本語', 'の文章', 'です']);
  });

  it('한글은 어절(공백) 단위로 나눈다', () => {
    expect(lines('가나 다라 마바', 50)).toEqual(['가나 다라 ', '마바']);
  });

  it('어절이 줄 폭보다 길면 다음 줄로 넘긴 뒤 음절 단위로 나눈다', () => {
    expect(lines('가나다 라마바사아자차', 45)).toEqual(['가나다 ', '라마바사', '아자차']);
  });

  it('라틴 단어가 줄 폭보다 길면 글자 단위로 나눈다', () => {
    expect(lines('abcdefghij', 22)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('줄 폭보다 넓은 글자도 한 줄에 하나씩 놓는다(무한 반복 없음)', () => {
    expect(lines('가나', 5)).toEqual(['가', '나']);
    expect(lines('ab', 0)).toEqual(['a', 'b']);
  });

  it('강제 줄바꿈', () => {
    expect(lines('ab\ncd', 100)).toEqual(['ab\n', 'cd']);
    expect(lines('ab\n', 100)).toEqual(['ab\n', '']);
    expect(lines('\n\n', 100)).toEqual(['\n', '\n', '']);
    expect(lines('ab\r\ncd', 100)).toEqual(['ab\r\n', 'cd']);
    const r = layoutParagraph(input('ab\ncd', {}));
    expect(r.summary.lines.map((l) => l.hardBreak)).toEqual([true, false]);
  });

  it('자동 줄 끝 바로 뒤의 공백·강제 줄바꿈은 그 줄에 붙는다(빈 줄을 만들지 않는다)', () => {
    expect(lines('aaaa bbbb\ncc', 20)).toEqual(['aaaa ', 'bbbb\n', 'cc']);
    expect(lines('aaaa  \ncc', 20)).toEqual(['aaaa  \n', 'cc']);
    const r = layoutParagraph(input('aaaa  \ncc', { area: [0, 0, 20, 1000] }));
    expect(r.summary.lines[0]?.hardBreak).toBe(true);
  });
});

describe('금칙', () => {
  it('줄 머리 금지 문자 앞에서 나누지 않는다', () => {
    const out = lines('日本語。です', 30);
    expect(out[0]).toBe('日本');
    expect(out.some((l) => l.startsWith('。'))).toBe(false);
    expect(lines('word, next', 25)).toEqual(['word, ', 'next']);
    // 공백 뒤라도 닫는 부호로 줄을 시작하지 않는다.
    expect(lines('aaa )', 15).some((l) => l.startsWith(')'))).toBe(false);
  });

  it('줄 끝 금지 문자 뒤에서 나누지 않는다', () => {
    const out = lines('日本「語」です', 30);
    expect(out.some((l) => l.endsWith('「'))).toBe(false);
    expect(out.join('')).toBe('日本「語」です');
    // 여는 괄호 + 공백 뒤도 나누지 않는다(UAX #14 OP SP* ×).
    expect(lines('aa ( bb', 22).some((l) => l.endsWith('( '))).toBe(false);
  });

  it('비상 나눔도 금칙 위치를 피한다(가능하면)', () => {
    // "abcd." 를 폭 22(4글자)로: "abcd" / "." 대신 "abc" / "d." 로 나눈다.
    expect(lines('abcd.', 22)).toEqual(['abc', 'd.']);
  });

  it('금칙 표는 계약 5.4 의 글자를 포함한다', () => {
    for (const ch of '.,:;!?)]}」』〉》’”%…·）') expect(KINSOKU_HEAD).toContain(ch);
    for (const ch of '([{「『〈《‘“（') expect(KINSOKU_TAIL).toContain(ch);
  });
});
