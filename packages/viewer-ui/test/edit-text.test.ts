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
  it('combines NFD Hangul jamo into NFC syllables', () => {
    const nfd = '한'; // ᄒ + ᅡ + ᆫ
    expect(normalizeInput(nfd)).toBe('한');
    expect(normalizeInput('é')).toBe('é');
  });

  it('U+00A0 (NBSP) is replaced with a space (U+0020) (contract amendment 2)', () => {
    expect(normalizeInput('a\u00a0b')).toBe('a b');
    expect(normalizeInput('\u00a0\u00a0')).toBe('  ');
    // Other whitespace-like characters (ideographic space, thin space, etc.) are left as they are
    expect(normalizeInput('a\u3000b\u2009c')).toBe('a\u3000b\u2009c');
  });

  it('line breaks become \\n, tabs become spaces, and other control characters are removed', () => {
    expect(normalizeInput('a\r\nb\rc d e')).toBe('a\nb\nc\nd\ne');
    expect(normalizeInput('a\tb')).toBe('a b');
    expect(normalizeInput('a\u0000b\u0007c\u007fd')).toBe('abcd');
  });
});

describe('grapheme boundaries', () => {
  it('treats combining characters, emoji and jamo sequences as one grapheme', () => {
    const text = 'aéb한👍🏽';
    const bounds = graphemeBoundaries(text);
    expect(bounds[0]).toBe(0);
    expect(bounds.at(-1)).toBe(text.length);
    // 'a', 'é' (2 code units), 'b', '한', '👍🏽' (4 code units)
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

describe('word movement and selection', () => {
  const text = 'Hello big  world';
  it('Ctrl+→ goes to the next word start, Ctrl+← to the previous word start', () => {
    expect(nextWordStart(text, 0)).toBe(6);
    expect(nextWordStart(text, 6)).toBe(11);
    expect(nextWordStart(text, 11)).toBe(text.length);
    expect(prevWordStart(text, 16)).toBe(11);
    expect(prevWordStart(text, 11)).toBe(6);
    expect(prevWordStart(text, 3)).toBe(0);
  });

  it('double-click word range', () => {
    expect(wordRangeAt(text, 7)).toEqual([6, 9]);
    expect(wordRangeAt('', 0)).toEqual([0, 0]);
  });
});

describe('characters that close an undo unit', () => {
  it('whitespace and punctuation close it; letters and digits do not', () => {
    expect(endsUndoUnit(' ')).toBe(true);
    expect(endsUndoUnit('a.')).toBe(true);
    expect(endsUndoUnit('안녕,')).toBe(true);
    expect(endsUndoUnit('a')).toBe(false);
    expect(endsUndoUnit('한')).toBe(false);
    expect(endsUndoUnit('')).toBe(false);
  });
});
