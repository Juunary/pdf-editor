/** Unit tests for finding reapply targets: cell targets (D1) and path fingerprints (D4). Uses only a synthetic context. */
import { describe, expect, it } from 'vitest';
import type { PathTarget, ParagraphTarget } from '@pdf-editor/shared-types';
import { EditStateError, findParagraphId, fingerprintMismatch } from '../src/edit-engine.js';
import type { ParagraphEditContext } from '../src/edit-adapter.js';

/** In table 1 (id 3): paragraphs 10 and 11 (glyphs 0–1, 2–3) in cell (0,0), paragraph 12 (glyphs 4–5) in cell (0,1), and flow paragraph 20 (glyph 6). */
function ctx(): ParagraphEditContext {
  const glyphs = [0, 1, 2, 3, 4, 5, 6];
  const paragraph = (id: number, chars: number[], table: number | null) => ({
    id,
    chars,
    table,
  });
  return {
    pageIndex: 2,
    model: { chars: glyphs.map((glyphSeq) => ({ glyphSeq })) },
    layout: {
      paragraphs: [
        paragraph(10, [0, 1], 3),
        paragraph(11, [2, 3], 3),
        paragraph(12, [4, 5], 3),
        paragraph(20, [6], null),
      ],
      tables: [
        {
          id: 3,
          cells: [
            { row: 0, col: 0, paragraphs: [10, 11] },
            { row: 0, col: 1, paragraphs: [12] },
          ],
        },
      ],
    },
  } as unknown as ParagraphEditContext;
}

const target = (glyphSeqs: number[], cell?: ParagraphTarget['cell']): ParagraphTarget => ({
  pageIndex: 2,
  glyphSeqs,
  editedBlock: null,
  bbox: [0, 0, 1, 1],
  ...(cell !== undefined ? { cell } : {}),
});

describe('findParagraphId', () => {
  it('a flow paragraph finds the one paragraph with the same glyph list', () => {
    expect(findParagraphId(ctx(), target([6]))).toBe(20);
    expect(() => findParagraphId(ctx(), target([6, 7]))).toThrow(EditStateError);
  });

  it('a cell target widens from the glyphSeqs[0] paragraph to the cell and checks that the whole cell matches', () => {
    expect(findParagraphId(ctx(), target([0, 1, 2, 3], { table: 3, row: 0, col: 0 }))).toBe(10);
    expect(findParagraphId(ctx(), target([4, 5], { table: 3, row: 0, col: 1 }))).toBe(12);
  });

  it('finds the target even if the paragraph order in the cell differs, as long as the glyph set is the same', () => {
    expect(findParagraphId(ctx(), target([2, 3, 0, 1], { table: 3, row: 0, col: 0 }))).toBe(11);
  });

  it('fails when the glyphs of the cell are only partial or in excess (including when only one paragraph matches)', () => {
    const cell = { table: 3, row: 0, col: 0 };
    expect(() => findParagraphId(ctx(), target([0, 1], cell))).toThrow('대상 셀을 찾지 못함');
    expect(() => findParagraphId(ctx(), target([0, 1, 2, 3, 4], cell))).toThrow(EditStateError);
  });

  it('fails when the cell position differs', () => {
    expect(() => findParagraphId(ctx(), target([4, 5], { table: 3, row: 0, col: 0 }))).toThrow(
      '대상 셀을 찾지 못함',
    );
    expect(() => findParagraphId(ctx(), target([4, 5], { table: 9, row: 0, col: 1 }))).toThrow(
      EditStateError,
    );
  });

  it('when cell is null, the flow paragraph rule applies', () => {
    expect(findParagraphId(ctx(), target([6], null))).toBe(20);
  });
});

/**
 * R4 reduced case (zen-ko-report-21333257 page 6): the layout attached the last two characters of the edit block (glyphs 0–5) to the next paragraph (glyphs 4–8).
 * The classification emits the block's first paragraph (40) and widens the target characters to the whole block, so the log's glyphSeqs (0–5) equals no layout paragraph.
 */
function splitBlockCtx(): ParagraphEditContext {
  return {
    pageIndex: 5,
    model: { chars: Array.from({ length: 9 }, (_, glyphSeq) => ({ glyphSeq })) },
    layout: {
      paragraphs: [
        { id: 40, chars: [0, 1, 2, 3], table: null },
        { id: 41, chars: [4, 5, 6, 7, 8], table: null },
      ],
      tables: [],
    },
  } as unknown as ParagraphEditContext;
}

const blockTarget = (glyphSeqs: number[], editedBlock: string | null): ParagraphTarget => ({
  pageIndex: 5,
  glyphSeqs,
  editedBlock,
  bbox: [0, 0, 1, 1],
});

describe('findParagraphId: edit block split by the layout (R4)', () => {
  const planned: Record<number, ParagraphTarget> = {
    40: blockTarget([0, 1, 2, 3, 4, 5], 'b1'),
    41: blockTarget([4, 5, 6, 7, 8], null),
  };
  const targetOf = (id: number): ParagraphTarget | null => planned[id] ?? null;

  it('when no layout paragraph matches exactly, finds it via the plan target of the paragraph holding the characters of the block', () => {
    expect(findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b1'), targetOf)).toBe(
      40,
    );
  });

  it('fails as before when there is no plan check function', () => {
    expect(() => findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b1'))).toThrow(
      '재적용 대상 문단을 찾지 못함(6쪽, 글리프 6개)',
    );
  });

  it('does not widen the search when the target is not an edit block (editedBlock null)', () => {
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], null), targetOf),
    ).toThrow(EditStateError);
  });

  it('fails when the block id or characters of the plan target differ from the log', () => {
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b2'), targetOf),
    ).toThrow(EditStateError);
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4], 'b1'), targetOf),
    ).toThrow(EditStateError);
  });

  it('skips paragraphs whose plan computation failed (null)', () => {
    const throwing = (id: number) => (id === 40 ? null : targetOf(id));
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b1'), throwing),
    ).toThrow(EditStateError);
  });
});

describe('fingerprintMismatch', () => {
  const base: PathTarget = {
    pageIndex: 0,
    paintSeqs: [4],
    fingerprints: [{ paintOp: 'f', constructOpCount: 1, bbox: [1, 2, 3, 4], constructHash: 'ab' }],
    bbox: [1, 2, 3, 4],
  };
  const withFp = (patch: Partial<PathTarget['fingerprints'][number]>): PathTarget => ({
    ...base,
    fingerprints: [{ ...base.fingerprints[0]!, ...patch }],
  });

  it('returns null when equal, box allows rounding error up to 1e-3', () => {
    expect(fingerprintMismatch(base, base)).toBeNull();
    expect(fingerprintMismatch(base, withFp({ bbox: [1.001, 2, 3, 4] }))).toBeNull();
  });

  it('returns a reason when the paint op, construct op count, hash, box or count differs', () => {
    expect(fingerprintMismatch(base, withFp({ paintOp: 'S' }))).toContain('칠하기 연산');
    expect(fingerprintMismatch(base, withFp({ constructOpCount: 2 }))).toContain('구성 연산 수');
    expect(fingerprintMismatch(base, withFp({ constructHash: 'cd' }))).toContain('해시');
    expect(fingerprintMismatch(base, withFp({ bbox: [1, 2, 3, 4.5] }))).toContain('상자');
    expect(fingerprintMismatch(base, { ...base, fingerprints: [] })).toContain('칠하기 연산 수');
  });
});
