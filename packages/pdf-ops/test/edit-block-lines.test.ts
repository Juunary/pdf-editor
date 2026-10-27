/**
 * editBlockLineGroups (docs/m3-integration.md 9.6): groups of lines holding edit-block characters. A pure function, so it is tested with minimal objects.
 */
import { describe, expect, it } from 'vitest';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import { editBlockLineGroups } from '../src/index.js';

/** Character list per line (character = [text, operation id]). Operation id -> formPath object numbers. */
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
  it('one line group per block (block order); lines outside blocks and empty groups are dropped', () => {
    // Operation 0: page, 1: block 10 (inside outer Form 5), 2: block 20.
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

  it('a mixed line goes to the block with the majority (more than half) of visible characters; with no majority it goes to no group', () => {
    const { model, map, linkage } = fixture(
      [
        // 2 block characters + 1 page character (spaces are not counted) -> block.
        [
          ['a', 1],
          [' ', 0],
          ['a', 1],
          ['x', 0],
        ],
        // Half and half -> none.
        [
          ['a', 1],
          ['x', 0],
        ],
        // A character with a failed link (-1) is outside the block.
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
