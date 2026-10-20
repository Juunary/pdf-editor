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

describe.each([true, false])('캐럿·줄 기하(강제 줄바꿈 글자를 줄에 포함=%s)', (newlineInLine) => {
  // 폭 50 = 5글자. "ab cd efgh" → "ab cd " / "efgh"(공백 뒤에서 소프트 줄바꿈)
  const text = 'ab cd efgh\nxy';
  const r = reflow(text, 50, newlineInLine);

  it('줄이 공백 뒤에서 나뉘고 강제 줄바꿈 뒤에 새 줄이 시작한다', () => {
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

  it('캐럿 x·상자: 글리프 위치, 줄 끝, 소프트 줄바꿈 경계 affinity', () => {
    const c0 = caretBox(r, text, 0)!;
    expect(c0).toMatchObject({ x: 100, line: 0 });
    expect(c0.bottom - c0.top).toBe(DEFAULT_LAYOUT.ascent + DEFAULT_LAYOUT.descent);
    expect(caretBox(r, text, 3)!.x).toBe(130);
    // 오프셋 6 = 소프트 줄바꿈 경계("ab cd " 끝 = "efgh" 시작)
    expect(caretBox(r, text, 6, 'downstream')).toMatchObject({ line: 1, x: 100 });
    expect(caretBox(r, text, 6, 'upstream')).toMatchObject({ line: 0 });
    // 줄 끝 공백 구간은 줄 오른쪽 끝(x1)에 접힌다: "ab cd" 폭 50
    expect(caretBox(r, text, 6, 'upstream')!.x).toBe(150);
    // 강제 줄바꿈 줄의 끝(오프셋 10 = '\n' 위치)은 그 줄 끝, 그 다음(11)은 새 줄 처음
    expect(caretBox(r, text, 10)).toMatchObject({ line: 1, x: 140 });
    expect(caretBox(r, text, 11)).toMatchObject({ line: 2, x: 100 });
    expect(caretBox(r, text, text.length)).toMatchObject({ line: 2, x: 120 });
  });

  it('점 → 위치: 가까운 줄·글자 경계, 줄 끝 오른쪽 바깥, 위·아래 바깥', () => {
    // 첫 줄 y = 62 기준선(50+12), 상자 51~65
    expect(offsetAtPoint(r, text, [104, 58])).toEqual({ offset: 0, affinity: 'downstream' });
    expect(offsetAtPoint(r, text, [106, 58]).offset).toBe(1);
    expect(offsetAtPoint(r, text, [400, 58]).offset).toBe(5); // "ab cd" 끝(공백 앞)
    expect(offsetAtPoint(r, text, [400, 78]).offset).toBe(10); // 둘째 줄 끝
    expect(offsetAtPoint(r, text, [0, -500]).offset).toBe(0);
    expect(offsetAtPoint(r, text, [400, 500]).offset).toBe(text.length);
  });

  it('위·아래 이동은 목표 x 를 유지하고, 첫 줄 위는 처음·마지막 줄 아래는 끝으로 간다', () => {
    const down = moveVertical(r, text, 3, 'downstream', 1, null);
    expect(down).toMatchObject({ offset: 9, goalX: 130 }); // "efgh" 의 x=130 위치(오프셋 6+3)
    const down2 = moveVertical(r, text, down.offset, down.affinity, 1, down.goalX);
    expect(down2.offset).toBe(13); // 마지막 줄 "xy" 는 짧아 줄 끝으로 접힌다
    expect(moveVertical(r, text, 13, 'downstream', 1, 130).offset).toBe(text.length);
    expect(moveVertical(r, text, 2, 'downstream', -1, null).offset).toBe(0);
  });

  it('Home/End 는 리플로우 줄 기준', () => {
    expect(lineBoundary(r, text, 3, 'downstream', 'home')).toEqual({
      offset: 0,
      affinity: 'downstream',
    });
    // 소프트 줄바꿈 줄의 End = 줄 끝(upstream)
    expect(lineBoundary(r, text, 3, 'downstream', 'end')).toEqual({
      offset: 6,
      affinity: 'upstream',
    });
    // 강제 줄바꿈 줄의 End = '\n' 앞
    expect(lineBoundary(r, text, 8, 'downstream', 'end')).toEqual({
      offset: 10,
      affinity: 'downstream',
    });
    expect(lineBoundary(r, text, 12, 'downstream', 'home').offset).toBe(11);
  });

  it('줄 번호 판정', () => {
    expect(lineIndexOf(r, text, 7)).toBe(1);
    expect(lineIndexOf(r, text, 6, 'upstream')).toBe(0);
    expect(lineIndexOf(r, text, 99)).toBe(2);
  });

  it('선택 상자: 줄마다 하나, 줄바꿈을 지나면 강제 줄바꿈 줄만 여백', () => {
    const rects = rangeRects(r, text, 1, 13);
    expect(rects.length).toBe(3);
    expect(rects[0]![0]).toBe(110);
    expect(rects[1]![2]).toBeGreaterThan(140); // 강제 줄바꿈 표시 여백 포함
    expect(rangeRects(r, text, 4, 4)).toEqual([]);
  });

  it('조합 밑줄은 선택 상자 아래 변에 놓인다', () => {
    const lines = compositionUnderlines(r, text, [1, 3]);
    expect(lines).toHaveLength(1);
    expect(lines[0]![1]).toBe(lines[0]![3]);
    expect(lines[0]![0]).toBe(110);
    expect(lines[0]![2]).toBe(130);
  });
});

describe('폴백·없는 글자 표시', () => {
  it('폴백 글자는 이어진 구간으로, 없는 글자는 표시 위치로 돌려준다', () => {
    const text = 'ab한글☃cd';
    const r = reflow(text, 400);
    const segs = fallbackSegments(r);
    expect(segs).toHaveLength(1);
    expect(segs[0]![0]).toBe(120);
    expect(segs[0]![2]).toBe(140);
    const marks = missingMarks(r);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ x: 140, offset: 4, length: 1 });
    // 없는 글자는 폭 0 이라 다음 글자가 같은 x 에서 시작한다
    expect(caretBox(r, text, 5)!.x).toBe(140);
  });
});

describe('빈 문단', () => {
  it('텍스트가 비어도 줄 1개로 캐럿을 그릴 수 있다', () => {
    const r = reflow('', 100);
    expect(r.lines).toHaveLength(1);
    expect(caretBox(r, '', 0)).toMatchObject({ x: 100, line: 0 });
    expect(offsetAtPoint(r, '', [500, 500]).offset).toBe(0);
    expect(offsetAtX(r, '', 0, 0).offset).toBe(0);
  });
});

describe('시작 캐럿: 원 문서 글자 → 텍스트 위치', () => {
  // 글자 10×14, 왼쪽 20·위쪽 20. 줄 0 "Hello World"(글자 0–10), 줄 1 "Second"(글자 11–16)
  const model = makePageModel(['Hello World', 'Second']);
  const identity = Array.from({ length: 11 }, (_, i) => i);

  it('클릭한 글자 앞·뒤(가운데 기준)', () => {
    expect(offsetAtPagePoint(model, identity, [43, 25])).toBe(2); // 'l'(x 40–50) 왼쪽 절반 → 앞
    expect(offsetAtPagePoint(model, identity, [47, 25])).toBe(3); // 오른쪽 절반 → 뒤
    expect(offsetAtPagePoint(model, identity, [5, 25])).toBe(0);
    expect(offsetAtPagePoint(model, identity, [500, 25])).toBe(11);
  });

  it('합성 공백(-1)은 건너뛰고, 여러 코드유닛 글자는 글자 앞·뒤 위치를 쓴다', () => {
    // 위치 5 는 합성 공백, 위치 3·4 는 같은 글자(합자 "ll" 가정)
    const mapping = [0, 1, 2, 3, 3, -1, 6, 7];
    expect(offsetAtPagePoint(model, mapping, [58, 25])).toBe(5); // 글자 3 오른쪽 절반 → 마지막 코드유닛 뒤
    expect(offsetAtPagePoint(model, mapping, [52, 25])).toBe(3); // 글자 3 왼쪽 절반 → 첫 코드유닛 앞
    expect(offsetAtPagePoint(model, mapping, [47, 25])).toBe(3); // 글자 2 오른쪽 절반 → 글자 2 뒤
    expect(offsetAtPagePoint(model, [], [10, 10])).toBeNull();
  });
});
