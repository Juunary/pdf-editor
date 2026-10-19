import { describe, expect, it } from 'vitest';
import {
  endsUndoUnit,
  graphemeBoundaries,
  nextBoundary,
  nextWordStart,
  normalizeInput,
  prevBoundary,
  prevWordStart,
  snapBoundary,
  wordRangeAt,
} from '../src/edit-text.js';

describe('normalizeInput', () => {
  it('NFD 한글 자모를 NFC 음절로 합친다', () => {
    const nfd = '한'; // ᄒ + ᅡ + ᆫ
    expect(normalizeInput(nfd)).toBe('한');
    expect(normalizeInput('é')).toBe('é');
  });

  it('U+00A0(NBSP)은 공백(U+0020)으로 바꾼다(계약 수정 2)', () => {
    expect(normalizeInput('a\u00a0b')).toBe('a b');
    expect(normalizeInput('\u00a0\u00a0')).toBe('  ');
    // 다른 공백류(전각 공백·가는 공백 등)는 그대로 둔다
    expect(normalizeInput('a\u3000b\u2009c')).toBe('a\u3000b\u2009c');
  });

  it('줄바꿈은 \\n 으로, 탭은 공백으로, 그 밖 제어 문자는 제거한다', () => {
    expect(normalizeInput('a\r\nb\rc d e')).toBe('a\nb\nc\nd\ne');
    expect(normalizeInput('a\tb')).toBe('a b');
    expect(normalizeInput('a\u0000b\u0007c\u007fd')).toBe('abcd');
  });
});

describe('자소 경계', () => {
  it('결합 문자·이모지·자모 시퀀스를 한 자소로 본다', () => {
    const text = 'aéb한👍🏽';
    const bounds = graphemeBoundaries(text);
    expect(bounds[0]).toBe(0);
    expect(bounds.at(-1)).toBe(text.length);
    // 'a', 'é'(2 코드유닛), 'b', '한', '👍🏽'(4 코드유닛)
    expect(bounds).toEqual([0, 1, 3, 4, 5, 9]);
  });

  it('prev·next·snap', () => {
    const text = 'aéb';
    expect(nextBoundary(text, 1)).toBe(3);
    expect(prevBoundary(text, 3)).toBe(1);
    expect(snapBoundary(text, 2)).toBe(1);
    expect(prevBoundary(text, 0)).toBe(0);
    expect(nextBoundary(text, text.length)).toBe(text.length);
  });
});

describe('단어 이동·선택', () => {
  const text = 'Hello big  world';
  it('Ctrl+→ 는 다음 단어 시작, Ctrl+← 는 이전 단어 시작', () => {
    expect(nextWordStart(text, 0)).toBe(6);
    expect(nextWordStart(text, 6)).toBe(11);
    expect(nextWordStart(text, 11)).toBe(text.length);
    expect(prevWordStart(text, 16)).toBe(11);
    expect(prevWordStart(text, 11)).toBe(6);
    expect(prevWordStart(text, 3)).toBe(0);
  });

  it('더블클릭 단어 구간', () => {
    expect(wordRangeAt(text, 7)).toEqual([6, 9]);
    expect(wordRangeAt('', 0)).toEqual([0, 0]);
  });
});

describe('되돌리기 단위를 닫는 글자', () => {
  it('공백·문장부호는 닫고 글자·숫자는 닫지 않는다', () => {
    expect(endsUndoUnit(' ')).toBe(true);
    expect(endsUndoUnit('a.')).toBe(true);
    expect(endsUndoUnit('안녕,')).toBe(true);
    expect(endsUndoUnit('a')).toBe(false);
    expect(endsUndoUnit('한')).toBe(false);
    expect(endsUndoUnit('')).toBe(false);
  });
});
