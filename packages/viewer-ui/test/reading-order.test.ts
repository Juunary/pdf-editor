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

/** 글자 k(0부터)의 중심점. 격자: x = 20 + 10k, 줄 y = 20 + 20·줄. */
function center(line: number, col: number, x0 = 20): [number, number] {
  return [x0 + col * 10 + 5, 20 + line * 20 + 7];
}

describe('buildReadingOrder', () => {
  it('lines 배열 순서가 읽기 순서(글리프 순서와 달라도)', () => {
    const model = makePageModel(['AB', 'CD']);
    model.lines.reverse(); // 줄 순서를 뒤집는다: 읽기 순서 CD → AB
    const order = buildReadingOrder(model);
    expect(order.items.map((it) => model.chars[it.charIndex]!.text).join('')).toBe('CDAB');
    expect(order.lines.map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('줄에 속하지 않은 글자는 뒤에 따로 줄로 묶는다', () => {
    const model = makePageModel(['AB'], { orphanText: 'xyz' });
    const order = buildReadingOrder(model);
    expect(order.orphanChars).toBe(3);
    expect(order.lines.map((l) => l.orphan)).toEqual([false, true]);
    expect(assembleText(model, order, 0, order.items.length)).toBe('AB\n\nxyz');
  });

  it('줄이 참조하지 않은 글자는 line 값과 무관하게 orphan, 잘못된 인덱스·중복은 무시', () => {
    const model = makePageModel(['AB']);
    model.lines[0]!.chars = [0, 0, 99, -1, 1];
    model.chars[1]!.line = 0;
    const order = buildReadingOrder(model);
    expect(order.items.map((it) => it.charIndex)).toEqual([0, 1]);
    expect(order.orphanChars).toBe(0);
  });

  it('orphan 글자는 기준선이 크게 바뀌면 새 줄', () => {
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

  it('빈 줄은 건너뛴다', () => {
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

  it('전체: 같은 블록 줄 사이는 \\n, 블록 사이는 빈 줄', () => {
    expect(assembleText(model, order, 0, n)).toBe('첫째 줄\n둘째 줄\n\n다른 문단');
  });

  it('줄 중간부터 다음 줄 중간까지', () => {
    // '첫째 줄'(4글자) 중 index 1부터, '둘째 줄' 앞 2글자까지
    expect(assembleText(model, order, 1, 4 + 2)).toBe('째 줄\n둘째');
  });

  it('한 줄 안 구간에는 구분자가 없다', () => {
    expect(assembleText(model, order, 0, 2)).toBe('첫째');
  });

  it('구간 순서가 뒤집혀도, 범위를 넘어도 보정한다', () => {
    expect(assembleText(model, order, 2, 0)).toBe('첫째');
    expect(assembleText(model, order, -5, 1)).toBe('첫');
    expect(assembleText(model, order, n - 1, n + 10)).toBe('단');
    expect(assembleText(model, order, 3, 3)).toBe('');
  });

  it('구분자 옵션', () => {
    expect(assembleText(model, order, 0, n, { lineSeparator: ' ', blockSeparator: ' / ' })).toBe(
      '첫째 줄 둘째 줄 / 다른 문단',
    );
  });

  it('합자는 한 글자 안의 여러 코드포인트로 그대로', () => {
    const lig = makePageModel(['ab']);
    lig.chars[0]!.text = 'ﬃ'.normalize('NFKC'); // "ffi"
    expect(assembleText(lig, buildReadingOrder(lig), 0, 2)).toBe('ffib');
  });
});

describe('locatePoint · caretAt', () => {
  const model = makePageModel(['ABCD', 'EFGH']);
  const order = buildReadingOrder(model);

  it('글자 안: 앞쪽 절반은 글자 앞, 뒤쪽 절반은 글자 뒤', () => {
    const [cx, cy] = center(0, 1); // 'B' 중심 x = 35
    expect(caretAt(model, order, [cx - 2, cy])).toMatchObject({ caret: 1, item: 1, distance: 0 });
    expect(caretAt(model, order, [cx + 2, cy])).toMatchObject({ caret: 2, item: 1, distance: 0 });
  });

  it('줄 끝 오른쪽 바깥은 줄의 마지막 글자 뒤', () => {
    expect(caretAt(model, order, [500, 27])?.caret).toBe(4);
    expect(caretAt(model, order, [500, 47])?.caret).toBe(8);
  });

  it('줄 시작 왼쪽 바깥은 첫 글자 앞', () => {
    expect(caretAt(model, order, [2, 27])?.caret).toBe(0);
    expect(caretAt(model, order, [2, 47])?.caret).toBe(4);
  });

  it('줄 사이 빈 곳은 더 가까운 줄', () => {
    // 줄 0: y 20–34, 줄 1: y 40–54. 사이 36 은 줄 0 쪽, 38 은 줄 1 쪽.
    expect(caretAt(model, order, [35, 36])?.item).toBe(1);
    expect(caretAt(model, order, [35, 38])?.item).toBe(5);
  });

  it('텍스트 위쪽·아래쪽 바깥', () => {
    expect(caretAt(model, order, [35, 0])?.item).toBe(1);
    expect(caretAt(model, order, [35, 700])?.item).toBe(5);
  });

  it('텍스트 아래 먼 곳은 긴 앞줄의 끝 글자가 아니라 세로로 가까운 마지막 줄로 정해진다', () => {
    const m = makePageModel(['AAAAAAAAAAAAAAAA', 'B']);
    const o = buildReadingOrder(m);
    // 앞줄 끝 글자(x 170–180)가 가로로는 더 가깝지만, 마지막 줄이 세로로 20pt 더 가깝다.
    expect(caretAt(m, o, [300, 700])).toMatchObject({ item: 16, caret: 17 });
  });

  it('글자가 없으면 null', () => {
    const empty = makePageModel([]);
    expect(caretAt(empty, buildReadingOrder(empty), [10, 10])).toBeNull();
  });

  it('겹치는 quad 는 읽기 순서가 앞선 글자', () => {
    const m = makePageModel(['AB']);
    m.chars[1]!.quad = [...m.chars[0]!.quad]; // 같은 자리
    expect(caretAt(m, buildReadingOrder(m), [25, 27])?.item).toBe(0);
  });

  it('세로 쓰기는 위→아래 진행으로 판정', () => {
    const m = makePageModel(['A']);
    const c = m.chars[0]!;
    c.wmode = 1;
    c.quad = [100, 100, 114, 100, 100, 124, 114, 124]; // 폭 14, 높이 24
    const order1 = buildReadingOrder(m);
    expect(caretAt(m, order1, [107, 105])?.caret).toBe(0); // 위쪽 절반
    expect(caretAt(m, order1, [107, 120])?.caret).toBe(1); // 아래쪽 절반
    expect(locatePoint(c, [107, 105]).progress).toBeCloseTo(5 / 24);
  });

  it('90도 회전 글자도 quad 축 기준으로 판정', () => {
    const m = makePageModel(['A']);
    // u = 아래(0,+20), v = 왼쪽(-10,0): ul=(100,100)
    m.chars[0]!.quad = [100, 100, 100, 120, 90, 100, 90, 120];
    const o = buildReadingOrder(m);
    expect(locatePoint(m.chars[0]!, [95, 104])).toMatchObject({ distance: 0 });
    expect(locatePoint(m.chars[0]!, [95, 104]).progress).toBeCloseTo(0.2);
    expect(caretAt(m, o, [95, 116])?.caret).toBe(1);
    expect(locatePoint(m.chars[0]!, [105, 104]).distance).toBeCloseTo(5); // 줄 사이 방향 5pt
  });

  it('폭 0 quad(공백 등)도 점 거리로 다룬다', () => {
    const m = makePageModel(['A']);
    m.chars[0]!.quad = [50, 50, 50, 50, 50, 64, 50, 64]; // 폭 0, 높이 14
    // 줄 진행 방향으로 3pt 떨어짐 → 가중치 적용
    expect(locatePoint(m.chars[0]!, [53, 57]).distance).toBeCloseTo(3 * ALONG_LINE_WEIGHT);
    m.chars[0]!.quad = [50, 50, 50, 50, 50, 50, 50, 50]; // 점
    expect(locatePoint(m.chars[0]!, [53, 54]).distance).toBeCloseTo(
      Math.hypot(3 * ALONG_LINE_WEIGHT, 4),
    );
  });
});

describe('itemAtPoint · 더블클릭 · 트리플클릭', () => {
  const model: PageModel = makePageModel(['ab cd', 'ef']);
  const order = buildReadingOrder(model);

  it('itemAtPoint: 안쪽만, 없으면 -1', () => {
    expect(itemAtPoint(model, order, center(0, 3))).toBe(3);
    expect(itemAtPoint(model, order, [500, 500])).toBe(-1);
  });

  it('wordRange: 공백으로 나뉜 단어, 공백 위에서는 공백 구간', () => {
    expect(wordRange(model, order, 1)).toEqual([0, 2]); // 'ab'
    expect(wordRange(model, order, 4)).toEqual([3, 5]); // 'cd'
    expect(wordRange(model, order, 2)).toEqual([2, 3]); // ' '
  });

  it('wordRange 는 줄 경계를 넘지 않는다', () => {
    expect(wordRange(model, order, 5)).toEqual([5, 7]); // 둘째 줄 'ef'
    expect(wordRange(model, order, 99)).toEqual([0, 0]);
  });

  it('lineRange', () => {
    expect(lineRange(order, 2)).toEqual([0, 5]);
    expect(lineRange(order, 6)).toEqual([5, 7]);
    expect(lineRange(order, -1)).toEqual([0, 0]);
  });
});
