/**
 * editBlockLineGroups(docs/m3-integration.md 9.6): 편집 블록 글자가 있는 줄 묶음. 순수 함수라 최소 객체로 시험한다.
 */
import { describe, expect, it } from 'vitest';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import { editBlockLineGroups } from '../src/index.js';

/** 줄마다 글자 목록(글자 = [텍스트, 연산 id]). 연산 id → formPath 객체 번호들. */
function fixture(lines: [string, number][][], opForms: number[][]) {
  const chars: { text: string }[] = [];
  const charOp: number[] = [];
  const modelLines = lines.map((cs) => ({
    chars: cs.map(([text, op]) => {
      chars.push({ text });
      charOp.push(op);
      return chars.length - 1;
    }),
  }));
  const model = { chars, lines: modelLines } as unknown as PageModel;
  const map = {
    ops: opForms.map((nums, id) => ({
      id,
      formPath: nums.map((objectNumber) => ({ objectNumber })),
    })),
  } as unknown as SourceMap;
  const linkage = { charOp } as unknown as PageLinkage;
  return { model, map, linkage };
}

const blocks = [
  { editId: 'a', objectNumber: 10 },
  { editId: 'b', objectNumber: 20 },
];

describe('editBlockLineGroups', () => {
  it('블록마다 줄 묶음(블록 순서), 블록 밖 줄·빈 묶음은 뺀다', () => {
    // 연산 0: 쪽, 1: 블록 10(바깥 Form 5 안), 2: 블록 20.
    const { model, map, linkage } = fixture(
      [
        [['x', 0]],
        [
          ['b', 2],
          ['b', 2],
        ],
        [['a', 1]],
        [['a', 1]],
      ],
      [[], [5, 10], [20]],
    );
    expect(editBlockLineGroups(model, map, linkage, blocks)).toEqual([[2, 3], [1]]);
    expect(editBlockLineGroups(model, map, linkage, [{ editId: 'c', objectNumber: 99 }])).toEqual(
      [],
    );
    expect(editBlockLineGroups(model, map, linkage, [])).toEqual([]);
  });

  it('섞인 줄은 보이는 글자 과반(절반 초과)의 블록, 과반이 없으면 어느 묶음에도 넣지 않는다', () => {
    const { model, map, linkage } = fixture(
      [
        // 블록 글자 2 + 쪽 글자 1(공백은 세지 않음) → 블록.
        [
          ['a', 1],
          [' ', 0],
          ['a', 1],
          ['x', 0],
        ],
        // 반반 → 없음.
        [
          ['a', 1],
          ['x', 0],
        ],
        // 연결 실패 글자(-1)는 블록 밖.
        [
          ['a', 1],
          ['?', -1],
          ['?', -1],
        ],
      ],
      [[], [10]],
    );
    expect(editBlockLineGroups(model, map, linkage, blocks)).toEqual([[0]]);
  });
});
