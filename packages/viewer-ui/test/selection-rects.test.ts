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

  it('한 줄 안 구간은 글자 상자 합집합 하나(배율 적용)', () => {
    // 'World'(6–10번): x 80–130pt, y 20–34pt
    const [box, ...rest] = selectionRects(model, order, 6, 11, 2);
    expect(rest).toEqual([]);
    expect(box).toEqual({ left: 160, top: 40, width: 100, height: 28, rotation: 0 });
  });

  it('여러 줄에 걸치면 줄마다 상자 하나, 각 줄의 선택된 글자 범위만', () => {
    // 'World'(6–10) + 둘째 줄 'Second'(11–16)
    const boxes = selectionRects(model, order, 6, 17, 1);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({ left: 80, top: 20, width: 50, height: 14, rotation: 0 });
    expect(boxes[1]).toEqual({ left: 20, top: 40, width: 60, height: 14, rotation: 0 });
  });

  it('구간 순서가 뒤집혀도, 범위를 넘어도 보정하고, 빈 구간은 상자가 없다', () => {
    expect(selectionRects(model, order, 11, 6, 1)).toHaveLength(1);
    expect(selectionRects(model, order, 20, 999, 1)).toHaveLength(1);
    expect(selectionRects(model, order, 3, 3, 1)).toEqual([]);
  });

  it('페이지 경계 원점을 뺀다', () => {
    const [box] = selectionRects(model, order, 0, 1, 1, [10, 5]);
    expect(box).toMatchObject({ left: 10, top: 15 });
  });

  it('글자 크기가 섞이면 가장 큰 글자까지 포함한다', () => {
    const m = makePageModel(['ab']);
    m.chars[1]!.quad = [30, 15, 40, 15, 30, 40, 40, 40]; // 둘째 글자가 위아래로 더 큼
    const [box] = selectionRects(m, buildReadingOrder(m), 0, 2, 1);
    expect(box).toEqual({ left: 20, top: 15, width: 20, height: 25, rotation: 0 });
  });

  it('90도 회전 줄은 rotation 과 줄 방향 길이로 표현한다', () => {
    const m = makePageModel(['ab']);
    // 글자 폭 10, 높이 4. u 는 아래(0,+10), v 는 왼쪽(-4,0). 두 글자가 아래로 이어진다.
    m.chars[0]!.quad = [50, 10, 50, 20, 46, 10, 46, 20];
    m.chars[1]!.quad = [50, 20, 50, 30, 46, 20, 46, 30];
    const [box] = selectionRects(m, buildReadingOrder(m), 0, 2, 1);
    expect(box).toMatchObject({ left: 50, top: 10, width: 20, height: 4, rotation: 90 });
  });
});
