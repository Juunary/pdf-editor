import { describe, expect, it } from 'vitest';
import { isOverflowClipped, layoutParagraph, type ReflowInput } from '../src/index.js';
import { format, input, lineTexts, pdfFace, seg, stable } from './helpers.js';

// Test font size 10: Latin letter 5pt, space 2.5pt, Hangul/CJK 10pt, ascent 8pt, descent -2pt.

describe('alignment', () => {
  it('left·right·center', () => {
    const at = (align: 'left' | 'right' | 'center') =>
      layoutParagraph(input('ab', { align })).summary.lines[0];
    expect(at('left')).toMatchObject({ x0: 0, x1: 10 });
    expect(at('right')).toMatchObject({ x0: 90, x1: 100 });
    expect(at('center')).toMatchObject({ x0: 45, x1: 55 });
  });

  it('justify distributes the extra width among whitespace within the line to fill the line width, and does not stretch the last line', () => {
    const text = 'aa bb cc dd';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 40, 1000] }));
    expect(lineTexts(r, text)).toEqual(['aa bb cc ', 'dd']);
    const [l1, l2] = r.summary.lines;
    expect(l1?.x1).toBeCloseTo(40, 9);
    expect(l2).toMatchObject({ x0: 0, x1: 10 });
    // Natural width 35; the remaining 5pt goes 2.5pt to each of the two spaces.
    const c = r.summary.glyphs.find((g) => g.offset === 6);
    expect(c?.x).toBeCloseTo(30, 9);
    const space = r.summary.glyphs.find((g) => g.offset === 2);
    expect(space?.advance).toBeCloseTo(5, 9);
    // Write coordinates are at the same positions (the write step shifts them with TJ adjustments).
    expect(r.lines[0]?.find((g) => g.offset === 6)?.x).toBeCloseTo(30, 9);
    // Trailing whitespace on the line is not stretched.
    expect(r.summary.glyphs.find((g) => g.offset === 8)?.advance).toBeCloseTo(2.5, 9);
  });

  it('a line without whitespace (CJK) distributes evenly between clusters', () => {
    const text = '日本語の文章';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 35, 1000] }));
    expect(lineTexts(r, text)).toEqual(['日本語', 'の文章']);
    const xs = r.summary.glyphs.slice(0, 3).map((g) => g.x);
    expect(xs[1]).toBeCloseTo(12.5, 9);
    expect(xs[2]).toBeCloseTo(25, 9);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(35, 9);
    expect(r.summary.lines[1]?.x1).toBeCloseTo(30, 9);
  });

  it('a Latin-word line without whitespace is left-aligned without spreading letters (prevents spaces between letters on extraction)', () => {
    const text = 'aaaaaaaa bb';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 45, 1000] }));
    expect(lineTexts(r, text)).toEqual(['aaaaaaaa ', 'bb']);
    const xs = r.summary.glyphs.slice(0, 8).map((g) => g.x);
    expect(xs).toEqual([0, 5, 10, 15, 20, 25, 30, 35]);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(40, 9);
  });

  it('a Hangul syllable line without whitespace distributes between syllables', () => {
    const text = '가나다라마바';
    const r = layoutParagraph(input(text, { align: 'justify', area: [0, 0, 35, 1000] }));
    expect(lineTexts(r, text)).toEqual(['가나다', '라마바']);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(35, 9);
  });

  it('a line before a forced line break is not stretched', () => {
    const r = layoutParagraph(input('aa bb\ncc', { align: 'justify' }));
    expect(r.summary.lines[0]?.x1).toBeCloseTo(22.5, 9);
  });
});

describe('region, indent, baseline', () => {
  it('first-line indent reduces the first-line width', () => {
    const text = 'aaaa bbbb cccc';
    const r = layoutParagraph(input(text, { area: [0, 0, 40, 1000], firstLineIndent: 10 }));
    expect(lineTexts(r, text)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
    expect(r.summary.lines.map((l) => l.x0)).toEqual([10, 0, 0]);
  });

  it('negative indent (hanging indent) reduces the remaining lines', () => {
    const text = 'aaaa bbbb cccc';
    const r = layoutParagraph(input(text, { area: [0, 0, 40, 1000], firstLineIndent: -10 }));
    expect(r.summary.lines.map((l) => l.x0)).toEqual([0, 10, 10]);
    expect(lineTexts(r, text)).toEqual(['aaaa ', 'bbbb ', 'cccc']);
  });

  it('first baseline = region top + firstBaselineOffset, line spacing = lineHeight', () => {
    const r = layoutParagraph(input('a\nb\nc', { area: [5, 100, 105, 1000] }));
    expect(r.summary.lines.map((l) => l.baseline)).toEqual([108, 120, 132]);
    expect(r.summary.glyphs[0]).toMatchObject({ x: 5, y: 108 });
    expect(r.summary.lines[0]).toMatchObject({ ascent: 8, descent: -2 });
  });

  it('if the region exceeds the limit, it is clipped to the limit', () => {
    const r = layoutParagraph(
      input('ab', { area: [-10, -10, 200, 50], align: 'right' }, pdfFace(), [0, 0, 100, 40]),
    );
    expect(r.summary.area).toEqual([0, 0, 100, 40]);
    expect(r.summary.lines[0]?.x1).toBe(100);
  });

  it('contentBox is the union of the line glyph boxes (excluding trailing whitespace)', () => {
    const r = layoutParagraph(input('aa \nbbbb', {}));
    expect(r.summary.contentBox).toEqual([0, 0, 20, 22]);
  });
});

describe('line height', () => {
  // If the original font has no space glyph (TeX fonts etc.), only the spaces go to the fallback. If the fallback height (1160, -288) enlarged the line box,
  // even a same-text replacement would auto-extend beyond the original bbox (M3 corpus arxiv-2609.10511 page 1 #1 etc., docs/m3-integration.md section 10).
  const tall = { ...pdfFace('tall'), ascent: 1160, descent: -288 };
  const spaced = (text: string, area: [number, number, number, number]): ReflowInput => {
    const segments = [];
    let start = 0;
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || (text[i] === ' ') !== (text[start] === ' ')) {
        segments.push(seg(text[start] === ' ' ? tall : pdfFace(), start, i));
        start = i;
      }
    }
    return { text, segments, format: format({ area }), areaLimit: [0, 0, 1000, 1000] };
  };

  it('the font of a whitespace cluster is not included in the ascent/descent of a line that has letters', () => {
    const r = layoutParagraph(spaced('ab cd', [0, 0, 100, 10]));
    expect(r.summary.lines[0]).toMatchObject({ ascent: 8, descent: -2 });
    expect(r.summary.contentBox).toEqual([0, 0, 22.5, 10]);
    expect(r.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 10] });
  });

  it('a whitespace-only line uses the ascent/descent of the whitespace font', () => {
    const r = layoutParagraph(spaced('ab\n ', [0, 0, 100, 1000]));
    expect(r.summary.lines[1]).toMatchObject({ ascent: 11.6, descent: -2.88 });
  });
});

describe('overflow and auto-extend (2026-10-20 user decision)', () => {
  // One line: baseline 8, bottom = 10.
  it('if the bottom of the last line exceeds region bottom + 0.5pt, the bottom edge is lowered by that amount', () => {
    const fits = layoutParagraph(input('a', { area: [0, 0, 100, 9.5] }));
    expect(fits.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 9.5] });
    const grown = layoutParagraph(input('a', { area: [0, 0, 100, 9.4] }));
    expect(grown.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 10] });
    expect(grown.summary).not.toHaveProperty('fontScale');
    // Font size is unchanged (no shrinking).
    expect(grown.summary.glyphs[0]?.size).toBe(10);
  });

  it('lowers the bottom edge as much as needed and stops at the limit; if blocked, the overflow is kept', () => {
    const text = 'a\nb\nc'; // bottom = 8 + 24 + 2 = 34
    const ok = layoutParagraph(input(text, { area: [0, 0, 100, 20] }));
    expect(ok.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 34] });
    const blocked = layoutParagraph(
      input(text, { area: [0, 0, 100, 20] }, pdfFace(), [0, 0, 100, 30]),
    );
    expect(blocked.summary).toMatchObject({ overflow: true, area: [0, 0, 100, 30] });
    // Overflowing lines are placed as they are (no automatic clipping). The part that went past the limit is judged as overflow-clipped.
    expect(blocked.lines.flat()).toHaveLength(3);
    expect(blocked.summary.contentBox[3]).toBe(34);
    expect(isOverflowClipped(blocked.summary, [0, 0, 100, 30])).toBe(true);
    expect(isOverflowClipped(ok.summary, [0, 0, 1000, 1000])).toBe(false);
  });

  it('does not change the region if there is no overflow (a region the user widened is not shrunk)', () => {
    const fits = layoutParagraph(input('a', { area: [0, 0, 100, 50] }));
    expect(fits.summary.area).toEqual([0, 0, 100, 50]);
  });

  it('even if the user shrinks the region below the text height, it grows back to the text height (line width unchanged)', () => {
    const text = 'aaaa bbbb cccc';
    const full = layoutParagraph(input(text, { area: [0, 0, 50, 100] }));
    const small = layoutParagraph(input(text, { area: [0, 0, 50, 5] }));
    expect(lineTexts(small, text)).toEqual(lineTexts(full, text));
    expect(small.summary.area[3]).toBe(full.summary.contentBox[3]);
    expect(small.summary.overflow).toBe(false);
  });

  it('ignores the overflow and fontScale fields left from a previous build even if they remain in the format (no shrinking)', () => {
    const text = 'a\nb\nc';
    const legacy = {
      area: [0, 0, 100, 20],
      overflow: 'shrink',
      fontScale: 0.85,
    } as unknown as Parameters<typeof input>[1];
    const r = layoutParagraph(input(text, legacy));
    expect(r.summary).toMatchObject({ overflow: false, area: [0, 0, 100, 34] });
    expect(r.summary.glyphs.every((g) => g.size === 10)).toBe(true);
    expect(stable(r)).toEqual(stable(layoutParagraph(input(text, { area: [0, 0, 100, 20] }))));
  });
});

describe('empty text and glyph-missing', () => {
  it('empty text also gets one line for the caret', () => {
    const r = layoutParagraph(input('', {}));
    expect(r.summary.lines).toEqual([
      { baseline: 8, x0: 0, x1: 0, ascent: 8, descent: -2, start: 0, end: 0, hardBreak: false },
    ]);
    expect(r.summary.glyphs).toEqual([]);
    expect(r.lines).toEqual([[]]);
    expect(r.summary.contentBox).toEqual([0, 0, 0, 10]);
  });

  it('the caret height of empty text follows the font and size of the zero-length segment', () => {
    const r = layoutParagraph({
      text: '',
      segments: [seg(pdfFace(), 0, 0, { size: 20 })],
      format: format({ align: 'right' }),
      areaLimit: [0, 0, 1000, 1000],
    });
    expect(r.summary.lines[0]).toMatchObject({ ascent: 16, descent: -4, x0: 100, x1: 100 });
  });

  it('a segment whose face is null is not laid out (width 0, not written)', () => {
    const face = pdfFace();
    const r = layoutParagraph({
      text: 'abXcd',
      segments: [seg(face, 0, 2), seg(null, 2, 3), seg(face, 3, 5)],
      format: format(),
      areaLimit: [0, 0, 1000, 1000],
    });
    const missing = r.summary.glyphs.find((g) => g.offset === 2);
    expect(missing).toMatchObject({ font: { kind: 'missing' }, advance: 0, x: 10 });
    expect(r.summary.glyphs.find((g) => g.offset === 3)?.x).toBe(10);
    expect(r.lines[0]?.map((g) => g.offset)).toEqual([0, 1, 3, 4]);
    expect(r.summary.lines[0]?.x1).toBe(20);
  });

  it('a cluster the original font cannot write (encode null) is also treated as missing', () => {
    const face = pdfFace('o', (ch) => (ch === 'X' ? null : 500));
    const r = layoutParagraph(input('aXb', {}, face));
    expect(r.summary.glyphs.map((g) => g.font.kind)).toEqual(['original', 'missing', 'original']);
    expect(r.lines[0]?.map((g) => g.offset)).toEqual([0, 2]);
  });
});

describe('clusters and write glyphs', () => {
  it('encodes and breaks lines per extended grapheme cluster', () => {
    const calls: string[] = [];
    const face = pdfFace('o', () => 500, calls);
    const text = 'e\u0301x👨\u200D👩\u200D👧';
    const r = layoutParagraph(input(text, {}, face));
    expect(calls).toEqual(['e\u0301', 'x', '👨\u200D👩\u200D👧']);
    expect(r.summary.glyphs.map((g) => [g.offset, g.length])).toEqual([
      [0, 2],
      [2, 1],
      [3, 8],
    ]);
    // Glyphs within a cluster share the same offset and length and are placed one after another by the preceding glyph width.
    const first = r.lines[0]?.filter((g) => g.offset === 0) ?? [];
    expect(first.map((g) => g.x)).toEqual([0, 5]);
    expect(r.summary.glyphs[0]?.advance).toBe(10);
  });

  it('splits clusters at segment boundaries and carries the segment properties on write glyphs', () => {
    const a = pdfFace('a');
    const b = pdfFace('b');
    const r = layoutParagraph({
      text: 'abcd',
      segments: [
        seg(a, 0, 2, { runIndex: 0 }),
        seg(b, 2, 4, { runIndex: 1, size: 20, syntheticBold: true, syntheticItalic: true }),
      ],
      format: format(),
      areaLimit: [0, 0, 1000, 1000],
    });
    const w = r.lines[0] ?? [];
    expect(w.map((g) => [g.faceKey, g.runIndex, g.size, g.x])).toEqual([
      ['a', 0, 10, 0],
      ['a', 0, 10, 5],
      ['b', 1, 20, 10],
      ['b', 1, 20, 20],
    ]);
    expect(w[2]).toMatchObject({
      syntheticBold: true,
      syntheticItalic: true,
      pdfWidth: 500,
      gid: 99,
    });
    expect([...(w[2]?.code ?? [])]).toEqual([99]);
    // Line height follows the larger characters.
    expect(r.summary.lines[0]).toMatchObject({ ascent: 16, descent: -4 });
  });

  it('line positions cover the text with no gaps', () => {
    const text = '가나다 라마바사아자차\n\nabc';
    const r = layoutParagraph(input(text, { area: [0, 0, 45, 1000] }));
    let pos = 0;
    for (const l of r.summary.lines) {
      expect(l.start).toBe(pos);
      pos = l.end;
    }
    expect(pos).toBe(text.length);
  });
});

describe('input validation and determinism', () => {
  it('throws if segments does not cover the text', () => {
    const base: ReflowInput = input('abcd', {});
    expect(() => layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 2)] })).toThrow('끝');
    expect(() =>
      layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 2), seg(pdfFace(), 3, 4)] }),
    ).toThrow('빈틈');
    expect(() =>
      layoutParagraph({ ...base, segments: [seg(pdfFace(), 0, 4, { size: 0 })] }),
    ).toThrow('글자 크기');
  });

  it('same input gives the same result', () => {
    const text = '가나다 라마바사아자차 well-known 日本語。です\n끝 (괄호) aaaa';
    for (const area of [
      [0, 0, 60, 30],
      [0, 0, 60, 300],
    ] as const) {
      const make = () => layoutParagraph(input(text, { area: [...area], align: 'justify' }));
      expect(stable(make())).toEqual(stable(make()));
    }
  });
});

describe('letter spacing (FontSegment.charSpacing)', () => {
  it('adds to the advance per glyph, and the spacing after the last glyph of a line is not counted in the line width', () => {
    const text = 'ab cd';
    const base = input(text);
    const r = layoutParagraph({
      ...base,
      segments: [seg(pdfFace(), 0, text.length, { charSpacing: -0.5 })],
    });
    // Natural width 5+5+2.5+5+5 = 22.5; of the 5 glyphs × -0.5, excluding the spacing after the last one → 22.5 − 2.
    expect(r.summary.lines[0]).toMatchObject({ x0: 0 });
    expect(r.summary.lines[0]?.x1).toBeCloseTo(20.5, 9);
    expect(r.summary.glyphs.map((g) => g.x)).toEqual([0, 4.5, 9, 11, 15.5]);
    expect(r.lines[0]?.map((g) => g.x)).toEqual([0, 4.5, 9, 11, 15.5]);
  });

  it('a line narrowed by letter spacing fits more characters in the same width', () => {
    const text = 'aaaa aaaa';
    const fmt = { area: [0, 0, 42, 1000] as [number, number, number, number] };
    // Natural width 42.5 > 42: it breaks.
    expect(lineTexts(layoutParagraph(input(text, fmt)), text)).toEqual(['aaaa ', 'aaaa']);
    // Letter spacing −0.1 × 8 (excluding after the last glyph) → 41.7: one line.
    const tight = layoutParagraph({
      ...input(text, fmt),
      segments: [seg(pdfFace(), 0, text.length, { charSpacing: -0.1 })],
    });
    expect(lineTexts(tight, text)).toEqual(['aaaa aaaa']);
  });

  it('horizontal scale (horizontalScale) multiplies the glyph advance and is carried on write glyphs', () => {
    const text = 'ab';
    const r = layoutParagraph({
      ...input(text),
      segments: [seg(pdfFace(), 0, text.length, { horizontalScale: 0.8 })],
    });
    expect(r.summary.glyphs.map((g) => g.x)).toEqual([0, 4]);
    expect(r.summary.lines[0]?.x1).toBeCloseTo(8, 9);
    expect(r.lines[0]?.map((g) => g.horizontalScale)).toEqual([0.8, 0.8]);
    const plain = layoutParagraph(input(text));
    expect(plain.lines[0]?.every((g) => !('horizontalScale' in g))).toBe(true);
  });
});
