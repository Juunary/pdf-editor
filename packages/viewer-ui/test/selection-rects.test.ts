import { describe, expect, it } from 'vitest';
import { buildReadingOrder } from '../src/reading-order.js';
import { selectionRects } from '../src/selection-rects.js';
import { makePageModel } from './fixtures.js';

describe('selectionRects', () => {
  const model = makePageModel([
    { text: 'Hello World', block: 1 },
    { text: 'Second line', block: 1 },
  ]);
  const order = buildReadingOrder(model);

  it('a range within one line is a single union of character boxes (scale applied)', () => {
    // 'World' (6–10): x 80–130pt, y 20–34pt
    const [box, ...rest] = selectionRects(model, order, 6, 11, 2);
    expect(rest).toEqual([]);
    expect(box).toEqual({ left: 160, top: 40, width: 100, height: 28, rotation: 0 });
  });

  it('spanning several lines gives one box per line, covering only the selected character range of each line', () => {
    // 'World' (6–10) + second line 'Second' (11–16)
    const boxes = selectionRects(model, order, 6, 17, 1);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({ left: 80, top: 20, width: 50, height: 14, rotation: 0 });
    expect(boxes[1]).toEqual({ left: 20, top: 40, width: 60, height: 14, rotation: 0 });
  });

  it('a reversed range or one past the bounds is corrected, and an empty range has no box', () => {
    expect(selectionRects(model, order, 11, 6, 1)).toHaveLength(1);
    expect(selectionRects(model, order, 20, 999, 1)).toHaveLength(1);
    expect(selectionRects(model, order, 3, 3, 1)).toEqual([]);
  });

  it('subtracts the page boundary origin', () => {
    const [box] = selectionRects(model, order, 0, 1, 1, [10, 5]);
    expect(box).toMatchObject({ left: 10, top: 15 });
  });

  it('when character sizes are mixed, the largest character is included', () => {
    const m = makePageModel(['ab']);
    m.chars[1]!.quad = [30, 15, 40, 15, 30, 40, 40, 40]; // the second character is larger vertically
    const [box] = selectionRects(m, buildReadingOrder(m), 0, 2, 1);
    expect(box).toEqual({ left: 20, top: 15, width: 20, height: 25, rotation: 0 });
  });

  it('a 90-degree rotated line is expressed with rotation and the along-line length', () => {
    const m = makePageModel(['ab']);
    // Character width 10, height 4. u points down (0,+10), v points left (-4,0). The two characters continue downward.
    m.chars[0]!.quad = [50, 10, 50, 20, 46, 10, 46, 20];
    m.chars[1]!.quad = [50, 20, 50, 30, 46, 20, 46, 30];
    const [box] = selectionRects(m, buildReadingOrder(m), 0, 2, 1);
    expect(box).toMatchObject({ left: 50, top: 10, width: 20, height: 4, rotation: 90 });
  });
});
