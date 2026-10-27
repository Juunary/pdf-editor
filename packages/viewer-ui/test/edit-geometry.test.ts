import { describe, expect, it } from 'vitest';
import type { ParagraphFormat, RunStyle, TextRun } from '@pdf-editor/shared-types';
import {
  caretBox,
  compositionUnderlines,
  fallbackSegments,
  lineBoundary,
  lineIndexOf,
  missingMarks,
  moveVertical,
  offsetAtPagePoint,
  offsetAtPoint,
  offsetAtX,
  rangeRects,
} from '../src/edit-geometry.js';
import { DEFAULT_LAYOUT, fakeReflow } from './fake-edit-host.js';
import { makePageModel } from './fixtures.js';

const STYLE: RunStyle = {
  sourceChar: 0,
  fontId: 0,
  size: 12,
  bold: false,
  italic: false,
  color: null,
};
const format = (
  area: [number, number, number, number],
  extra: Partial<ParagraphFormat> = {},
): ParagraphFormat => ({
  area,
  align: 'left',
  firstLineIndent: 0,
  lineHeight: 20,
  firstBaselineOffset: 12,
  ...extra,
});
const reflow = (
  text: string,
  width: number,
  newlineInLine = true,
  extra: Partial<ParagraphFormat> = {},
) =>
  fakeReflow([{ text, style: STYLE }] as TextRun[], format([100, 50, 100 + width, 90], extra), {
    ...DEFAULT_LAYOUT,
    newlineInLine,
  });

describe.each([true, false])('caret and line geometry (newline in line=%s)', (newlineInLine) => {
  // Width 50 = 5 characters. "ab cd efgh" → "ab cd " / "efgh" (soft line break after the space)
  const text = 'ab cd efgh\nxy';
  const r = reflow(text, 50, newlineInLine);

  it('a line breaks after whitespace and a new line starts after a forced line break', () => {
    expect(r.lines.map((l) => [l.start, l.hardBreak])).toEqual(
      newlineInLine
        ? [
            [0, false],
            [6, true],
            [11, false],
          ]
        : [
            [0, false],
            [6, true],
            [11, false],
          ],
    );
  });

  it('caret x and box: glyph position, line end, soft line-break boundary affinity', () => {
    const c0 = caretBox(r, text, 0)!;
    expect(c0).toMatchObject({ x: 100, line: 0 });
    expect(c0.bottom - c0.top).toBe(DEFAULT_LAYOUT.ascent + DEFAULT_LAYOUT.descent);
    expect(caretBox(r, text, 3)!.x).toBe(130);
    // Offset 6 = soft line-break boundary (end of "ab cd " = start of "efgh")
    expect(caretBox(r, text, 6, 'downstream')).toMatchObject({ line: 1, x: 100 });
    expect(caretBox(r, text, 6, 'upstream')).toMatchObject({ line: 0 });
    // The trailing-space range of a line collapses to the right end of the line (x1): "ab cd" width 50
    expect(caretBox(r, text, 6, 'upstream')!.x).toBe(150);
    // The end of a forced-line-break line (offset 10 = position of '\n') is the end of that line; the next (11) is the start of the new line
    expect(caretBox(r, text, 10)).toMatchObject({ line: 1, x: 140 });
    expect(caretBox(r, text, 11)).toMatchObject({ line: 2, x: 100 });
    expect(caretBox(r, text, text.length)).toMatchObject({ line: 2, x: 120 });
  });

  it('point → position: nearest line and character boundary, right of the line end, above/below the outside', () => {
    // First line y = 62 baseline (50+12), box 51~65
    expect(offsetAtPoint(r, text, [104, 58])).toEqual({ offset: 0, affinity: 'downstream' });
    expect(offsetAtPoint(r, text, [106, 58]).offset).toBe(1);
    expect(offsetAtPoint(r, text, [400, 58]).offset).toBe(5); // end of "ab cd" (before the space)
    expect(offsetAtPoint(r, text, [400, 78]).offset).toBe(10); // end of the second line
    expect(offsetAtPoint(r, text, [0, -500]).offset).toBe(0);
    expect(offsetAtPoint(r, text, [400, 500]).offset).toBe(text.length);
  });

  it('up/down movement keeps the goal x; above the first line goes to the start, below the last line to the end', () => {
    const down = moveVertical(r, text, 3, 'downstream', 1, null);
    expect(down).toMatchObject({ offset: 9, goalX: 130 }); // the x=130 position of "efgh" (offset 6+3)
    const down2 = moveVertical(r, text, down.offset, down.affinity, 1, down.goalX);
    expect(down2.offset).toBe(13); // the last line "xy" is short, so it collapses to the line end
    expect(moveVertical(r, text, 13, 'downstream', 1, 130).offset).toBe(text.length);
    expect(moveVertical(r, text, 2, 'downstream', -1, null).offset).toBe(0);
  });

  it('Home/End are based on reflow lines', () => {
    expect(lineBoundary(r, text, 3, 'downstream', 'home')).toEqual({
      offset: 0,
      affinity: 'downstream',
    });
    // End of a soft-line-break line = line end (upstream)
    expect(lineBoundary(r, text, 3, 'downstream', 'end')).toEqual({
      offset: 6,
      affinity: 'upstream',
    });
    // End of a forced-line-break line = before '\n'
    expect(lineBoundary(r, text, 8, 'downstream', 'end')).toEqual({
      offset: 10,
      affinity: 'downstream',
    });
    expect(lineBoundary(r, text, 12, 'downstream', 'home').offset).toBe(11);
  });

  it('line number classification', () => {
    expect(lineIndexOf(r, text, 7)).toBe(1);
    expect(lineIndexOf(r, text, 6, 'upstream')).toBe(0);
    expect(lineIndexOf(r, text, 99)).toBe(2);
  });

  it('selection boxes: one per line; when crossing a line break, only the forced-line-break line gets a margin', () => {
    const rects = rangeRects(r, text, 1, 13);
    expect(rects.length).toBe(3);
    expect(rects[0]![0]).toBe(110);
    expect(rects[1]![2]).toBeGreaterThan(140); // includes the forced-line-break indicator margin
    expect(rangeRects(r, text, 4, 4)).toEqual([]);
  });

  it('the composition underline sits on the bottom edge of the selection box', () => {
    const lines = compositionUnderlines(r, text, [1, 3]);
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toBe(lines[0]![3]);
    expect(lines[0]![0]).toBe(110);
    expect(lines[0]![2]).toBe(130);
  });
});

describe('fallback and missing character indicators', () => {
  it('fallback characters are returned as contiguous ranges, missing characters as display positions', () => {
    const text = 'ab한글☃cd';
    const r = reflow(text, 400);
    const segs = fallbackSegments(r);
    expect(segs).toHaveLength(1);
    expect(segs[0]![0]).toBe(120);
    expect(segs[0]![2]).toBe(140);
    const marks = missingMarks(r);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ x: 140, offset: 4, length: 1 });
    // A missing character has width 0, so the next character starts at the same x
    expect(caretBox(r, text, 5)!.x).toBe(140);
  });
});

describe('empty paragraph', () => {
  it('the caret can be drawn with one line even if the text is empty', () => {
    const r = reflow('', 100);
    expect(r.lines).toHaveLength(1);
    expect(caretBox(r, '', 0)).toMatchObject({ x: 100, line: 0 });
    expect(offsetAtPoint(r, '', [500, 500]).offset).toBe(0);
    expect(offsetAtX(r, '', 0, 0).offset).toBe(0);
  });
});

describe('start caret: original-document character → text position', () => {
  // Characters 10×14, left 20, top 20. Line 0 "Hello World" (characters 0–10), line 1 "Second" (characters 11–16)
  const model = makePageModel(['Hello World', 'Second']);
  const identity = Array.from({ length: 11 }, (_, i) => i);

  it('before/after the clicked character (based on the middle)', () => {
    expect(offsetAtPagePoint(model, identity, [43, 25])).toBe(2); // 'l' (x 40–50) left half → before
    expect(offsetAtPagePoint(model, identity, [47, 25])).toBe(3); // right half → after
    expect(offsetAtPagePoint(model, identity, [5, 25])).toBe(0);
    expect(offsetAtPagePoint(model, identity, [500, 25])).toBe(11);
  });

  it('skips synthetic spaces (-1), and multi-code-unit characters use the before/after positions of the character', () => {
    // Position 5 is a synthetic space; positions 3 and 4 are the same character (assuming the ligature "ll")
    const mapping = [0, 1, 2, 3, 3, -1, 6, 7];
    expect(offsetAtPagePoint(model, mapping, [58, 25])).toBe(5); // character 3 right half → after the last code unit
    expect(offsetAtPagePoint(model, mapping, [52, 25])).toBe(3); // character 3 left half → before the first code unit
    expect(offsetAtPagePoint(model, mapping, [47, 25])).toBe(3); // character 2 right half → after character 2
    expect(offsetAtPagePoint(model, [], [10, 10])).toBeNull();
  });
});
