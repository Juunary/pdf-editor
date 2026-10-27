import { describe, expect, it } from 'vitest';
import type { PageModel } from '@pdf-editor/shared-types';
import {
  ALONG_LINE_WEIGHT,
  assembleText,
  buildReadingOrder,
  caretAt,
  itemAtPoint,
  lineRange,
  locatePoint,
  wordRange,
} from '../src/reading-order.js';
import { makePageModel } from './fixtures.js';

/** Center point of character k (from 0). Grid: x = 20 + 10k, line y = 20 + 20·line. */
function center(line: number, col: number, x0 = 20): [number, number] {
  return [x0 + col * 10 + 5, 20 + line * 20 + 7];
}

describe('buildReadingOrder', () => {
  it('the order of the lines array is the reading order (even if it differs from glyph order)', () => {
    const model = makePageModel(['AB', 'CD']);
    model.lines.reverse(); // reverse the line order: reading order CD → AB
    const order = buildReadingOrder(model);
    expect(order.items.map((it) => model.chars[it.charIndex]!.text).join('')).toBe('CDAB');
    expect(order.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('characters that do not belong to a line are grouped separately into a line afterwards', () => {
    const model = makePageModel(['AB'], { orphanText: 'xyz' });
    const order = buildReadingOrder(model);
    expect(order.orphanChars).toBe(3);
    expect(order.lines.map((l) => l.orphan)).toEqual([false, true]);
    expect(assembleText(model, order, 0, order.items.length)).toBe('AB\n\nxyz');
  });

  it('characters not referenced by a line are orphans regardless of the line value, and invalid indices and duplicates are ignored', () => {
    const model = makePageModel(['AB']);
    model.lines[0]!.chars = [0, 0, 99, -1, 1];
    model.chars[1]!.line = 0;
    const order = buildReadingOrder(model);
    expect(order.items.map((it) => it.charIndex)).toEqual([0, 1]);
    expect(order.orphanChars).toBe(0);
  });

  it('an orphan character starts a new line if the baseline changes a lot', () => {
    const model = makePageModel(['A'], { orphanText: 'bc' });
    const far = structuredClone(model.chars[model.chars.length - 1]!);
    far.text = 'd';
    far.glyphSeq = model.chars.length;
    far.origin = [30, far.origin[1] + 100];
    far.quad = far.quad.map((v, i) => (i % 2 === 1 ? v + 100 : v)) as typeof far.quad;
    model.chars.push(far);
    const order = buildReadingOrder(model);
    expect(order.lines.filter((l) => l.orphan).length).toBe(2);
  });

  it('skips empty lines', () => {
    const model = makePageModel(['AB', 'C']);
    model.lines.splice(1, 0, { ...model.lines[0]!, chars: [] });
    expect(buildReadingOrder(model).lines.length).toBe(2);
  });
});

describe('assembleText', () => {
  const model = makePageModel([
    { text: '첫째 줄', block: 1 },
    { text: '둘째 줄', block: 1 },
    { text: '다른 문단', block: 2 },
  ]);
  const order = buildReadingOrder(model);
  const n = order.items.length;

  it('whole: \\n between lines of the same block, a blank line between blocks', () => {
    expect(assembleText(model, order, 0, n)).toBe('첫째 줄\n둘째 줄\n\n다른 문단');
  });

  it('from the middle of a line to the middle of the next line', () => {
    // From index 1 of '첫째 줄' (4 characters), up to 2 characters before '둘째 줄'
    expect(assembleText(model, order, 1, 4 + 2)).toBe('째 줄\n둘째');
  });

  it('there is no separator within a line range', () => {
    expect(assembleText(model, order, 0, 2)).toBe('첫째');
  });

  it('a reversed range or one past the bounds is corrected', () => {
    expect(assembleText(model, order, 2, 0)).toBe('첫째');
    expect(assembleText(model, order, -5, 1)).toBe('첫');
    expect(assembleText(model, order, n - 1, n + 10)).toBe('단');
    expect(assembleText(model, order, 3, 3)).toBe('');
  });

  it('separator options', () => {
    expect(assembleText(model, order, 0, n, { lineSeparator: ' ', blockSeparator: ' / ' })).toBe(
      '첫째 줄 둘째 줄 / 다른 문단',
    );
  });

  it('a ligature stays as multiple code points within one character', () => {
    const lig = makePageModel(['ab']);
    lig.chars[0]!.text = 'ﬃ'.normalize('NFKC'); // "ffi"
    expect(assembleText(lig, buildReadingOrder(lig), 0, 2)).toBe('ffib');
  });
});

describe('locatePoint · caretAt', () => {
  const model = makePageModel(['ABCD', 'EFGH']);
  const order = buildReadingOrder(model);

  it('inside a character: the front half is before the character, the back half is after it', () => {
    const [cx, cy] = center(0, 1); // center x of 'B' = 35
    expect(caretAt(model, order, [cx - 2, cy])).toMatchObject({ caret: 1, item: 1, distance: 0 });
    expect(caretAt(model, order, [cx + 2, cy])).toMatchObject({ caret: 2, item: 1, distance: 0 });
  });

  it('outside to the right of a line end is after the last character of the line', () => {
    expect(caretAt(model, order, [500, 27])?.caret).toBe(4);
    expect(caretAt(model, order, [500, 47])?.caret).toBe(8);
  });

  it('outside to the left of a line start is before the first character', () => {
    expect(caretAt(model, order, [2, 27])?.caret).toBe(0);
    expect(caretAt(model, order, [2, 47])?.caret).toBe(4);
  });

  it('a gap between lines goes to the nearer line', () => {
    // Line 0: y 20–34, line 1: y 40–54. 36 between them is on the line 0 side, 38 on the line 1 side.
    expect(caretAt(model, order, [35, 36])?.item).toBe(1);
    expect(caretAt(model, order, [35, 38])?.item).toBe(5);
  });

  it('outside above/below the text', () => {
    expect(caretAt(model, order, [35, 0])?.item).toBe(1);
    expect(caretAt(model, order, [35, 700])?.item).toBe(5);
  });

  it('far below the text is decided by the vertically nearest last line, not by the end character of a long preceding line', () => {
    const m = makePageModel(['AAAAAAAAAAAAAAAA', 'B']);
    const o = buildReadingOrder(m);
    // The end character of the preceding line (x 170–180) is closer horizontally, but the last line is 20pt closer vertically.
    expect(caretAt(m, o, [300, 700])).toMatchObject({ item: 16, caret: 17 });
  });

  it('null if there are no characters', () => {
    const empty = makePageModel([]);
    expect(caretAt(empty, buildReadingOrder(empty), [10, 10])).toBeNull();
  });

  it('for overlapping quads, the character earlier in reading order wins', () => {
    const m = makePageModel(['AB']);
    m.chars[1]!.quad = [...m.chars[0]!.quad]; // same spot
    expect(caretAt(m, buildReadingOrder(m), [25, 27])?.item).toBe(0);
  });

  it('vertical writing is classified with top-to-bottom progression', () => {
    const m = makePageModel(['A']);
    const c = m.chars[0]!;
    c.wmode = 1;
    c.quad = [100, 100, 114, 100, 100, 124, 114, 124]; // width 14, height 24
    const order1 = buildReadingOrder(m);
    expect(caretAt(m, order1, [107, 105])?.caret).toBe(0); // upper half
    expect(caretAt(m, order1, [107, 120])?.caret).toBe(1); // lower half
    expect(locatePoint(c, [107, 105]).progress).toBeCloseTo(5 / 24);
  });

  it('a 90-degree rotated character is also classified by the quad axes', () => {
    const m = makePageModel(['A']);
    // u = down (0,+20), v = left (-10,0): ul=(100,100)
    m.chars[0]!.quad = [100, 100, 100, 120, 90, 100, 90, 120];
    const o = buildReadingOrder(m);
    expect(locatePoint(m.chars[0]!, [95, 104])).toMatchObject({ distance: 0 });
    expect(locatePoint(m.chars[0]!, [95, 104]).progress).toBeCloseTo(0.2);
    expect(caretAt(m, o, [95, 116])?.caret).toBe(1);
    expect(locatePoint(m.chars[0]!, [105, 104]).distance).toBeCloseTo(5); // 5pt in the between-lines direction
  });

  it('a zero-width quad (whitespace etc.) is also handled as a point distance', () => {
    const m = makePageModel(['A']);
    m.chars[0]!.quad = [50, 50, 50, 50, 50, 64, 50, 64]; // width 0, height 14
    // 3pt away in the line progression direction → weighting applied
    expect(locatePoint(m.chars[0]!, [53, 57]).distance).toBeCloseTo(3 * ALONG_LINE_WEIGHT);
    m.chars[0]!.quad = [50, 50, 50, 50, 50, 50, 50, 50]; // point
    expect(locatePoint(m.chars[0]!, [53, 54]).distance).toBeCloseTo(
      Math.hypot(3 * ALONG_LINE_WEIGHT, 4),
    );
  });
});

describe('itemAtPoint · double-click · triple-click', () => {
  const model: PageModel = makePageModel(['ab cd', 'ef']);
  const order = buildReadingOrder(model);

  it('itemAtPoint: inside only, -1 if none', () => {
    expect(itemAtPoint(model, order, center(0, 3))).toBe(3);
    expect(itemAtPoint(model, order, [500, 500])).toBe(-1);
  });

  it('wordRange: a word separated by whitespace; over whitespace, the whitespace range', () => {
    expect(wordRange(model, order, 1)).toEqual([0, 2]); // 'ab'
    expect(wordRange(model, order, 4)).toEqual([3, 5]); // 'cd'
    expect(wordRange(model, order, 2)).toEqual([2, 3]); // ' '
  });

  it('wordRange does not cross line boundaries', () => {
    expect(wordRange(model, order, 5)).toEqual([5, 7]); // 'ef' on the second line
    expect(wordRange(model, order, 99)).toEqual([0, 0]);
  });

  it('lineRange', () => {
    expect(lineRange(order, 2)).toEqual([0, 5]);
    expect(lineRange(order, 6)).toEqual([5, 7]);
    expect(lineRange(order, -1)).toEqual([0, 0]);
  });
});

describe('synthetic whitespace (LineInfo.spaceAfter)', () => {
  // 'abcdef': synthetic whitespace after b and after d → "ab cd ef"
  const model = makePageModel([{ text: 'abcdef', spaceAfter: [1, 3] }]);
  const order = buildReadingOrder(model);

  it('marks the character at the spaceAfter position and does not mark the rest', () => {
    expect(order.items.map((it) => it.spaceAfter)).toEqual([
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  it('full assembly: one space at the synthetic whitespace position', () => {
    expect(assembleText(model, order, 0, 6)).toBe('ab cd ef');
  });

  it('a space is inserted only when both neighboring characters are in the range (no leading/trailing space at the boundary)', () => {
    expect(assembleText(model, order, 0, 2)).toBe('ab'); // the space after 'b' is outside the range
    expect(assembleText(model, order, 2, 6)).toBe('cd ef'); // the space before 'c' is outside the range
    expect(assembleText(model, order, 1, 3)).toBe('b c');
    expect(assembleText(model, order, 1, 2)).toBe('b');
    expect(assembleText(model, order, 3, 5)).toBe('d e');
  });

  it('ignores trailing-line whitespace, out-of-range, fractional and duplicate positions', () => {
    const odd = makePageModel([{ text: 'abc', spaceAfter: [2, -1, 99, 0.5, 0, 0] }]);
    const o = buildReadingOrder(odd);
    expect(o.items.map((it) => it.spaceAfter)).toEqual([true, false, false]);
    expect(assembleText(odd, o, 0, 3)).toBe('a bc');
  });

  it('even with filtered-out (invalid index) characters, spaceAfter positions are based on the original chars array', () => {
    const m = makePageModel([{ text: 'abc', spaceAfter: [2] }]);
    m.lines[0]!.chars = [0, 99, 1, 2]; // position 1 is an invalid index, position 2 = character 1 ('b')
    const o = buildReadingOrder(m);
    expect(o.items.map((it) => [it.charIndex, it.spaceAfter])).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    expect(assembleText(m, o, 0, 3)).toBe('ab c');
  });

  it('assembles together with line and block separators', () => {
    const m = makePageModel([
      { text: 'abc', block: 1, spaceAfter: [0] },
      { text: 'def', block: 1, spaceAfter: [1] },
      { text: 'ghi', block: 2, spaceAfter: [2] },
    ]);
    const o = buildReadingOrder(m);
    expect(assembleText(m, o, 0, o.items.length)).toBe('a bc\nde f\n\nghi');
  });

  it('characters outside lines (orphans) have no synthetic whitespace', () => {
    const m = makePageModel(['ab'], { orphanText: 'xy' });
    const o = buildReadingOrder(m);
    expect(o.items.filter((it) => it.spaceAfter)).toEqual([]);
  });

  it('the double-click word range breaks at synthetic whitespace', () => {
    expect(wordRange(model, order, 0)).toEqual([0, 2]); // ab
    expect(wordRange(model, order, 3)).toEqual([2, 4]); // cd
    expect(wordRange(model, order, 5)).toEqual([4, 6]); // ef
  });

  it('the word range is correct even when synthetic and real whitespace characters are both present', () => {
    // 'ab', real whitespace (index 2), 'cd' (synthetic whitespace after d), 'ef'
    const m = makePageModel([{ text: 'ab cdef', spaceAfter: [4] }]);
    const o = buildReadingOrder(m);
    expect(wordRange(m, o, 0)).toEqual([0, 2]);
    expect(wordRange(m, o, 2)).toEqual([2, 3]);
    expect(wordRange(m, o, 3)).toEqual([3, 5]);
    expect(wordRange(m, o, 6)).toEqual([5, 7]);
    expect(assembleText(m, o, 0, 7)).toBe('ab cd ef');
  });
});
