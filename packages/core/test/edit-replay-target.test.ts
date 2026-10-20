/** 재적용 대상 찾기 단위 시험: 셀 대상(D1)과 패스 지문(D4). 합성 컨텍스트만 쓴다. */
import { describe, expect, it } from 'vitest';
import type { PathTarget, ParagraphTarget } from '@pdf-editor/shared-types';
import { EditStateError, findParagraphId, fingerprintMismatch } from '../src/edit-engine.js';
import type { ParagraphEditContext } from '../src/edit-adapter.js';

/** 표 1(id 3)의 셀 (0,0)에 문단 10·11(글리프 0–1, 2–3), 셀 (0,1)에 문단 12(글리프 4–5), 흐름 문단 20(글리프 6). */
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
  it('흐름 문단은 글리프 목록이 같은 문단 하나를 찾는다', () => {
    expect(findParagraphId(ctx(), target([6]))).toBe(20);
    expect(() => findParagraphId(ctx(), target([6, 7]))).toThrow(EditStateError);
  });

  it('셀 대상은 glyphSeqs[0] 문단에서 셀로 넓혀 셀 전체 일치를 확인한다', () => {
    expect(findParagraphId(ctx(), target([0, 1, 2, 3], { table: 3, row: 0, col: 0 }))).toBe(10);
    expect(findParagraphId(ctx(), target([4, 5], { table: 3, row: 0, col: 1 }))).toBe(12);
  });

  it('셀 안 문단 순서가 달라도 같은 글리프 집합이면 찾는다', () => {
    expect(findParagraphId(ctx(), target([2, 3, 0, 1], { table: 3, row: 0, col: 0 }))).toBe(11);
  });

  it('셀의 글리프가 일부만이거나 넘치면 실패한다(한 문단만 일치하는 경우 포함)', () => {
    const cell = { table: 3, row: 0, col: 0 };
    expect(() => findParagraphId(ctx(), target([0, 1], cell))).toThrow('대상 셀을 찾지 못함');
    expect(() => findParagraphId(ctx(), target([0, 1, 2, 3, 4], cell))).toThrow(EditStateError);
  });

  it('셀 위치가 다르면 실패한다', () => {
    expect(() => findParagraphId(ctx(), target([4, 5], { table: 3, row: 0, col: 0 }))).toThrow(
      '대상 셀을 찾지 못함',
    );
    expect(() => findParagraphId(ctx(), target([4, 5], { table: 9, row: 0, col: 1 }))).toThrow(
      EditStateError,
    );
  });

  it('cell 이 null 이면 흐름 문단 규칙', () => {
    expect(findParagraphId(ctx(), target([6], null))).toBe(20);
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

  it('같으면 null, 상자는 1e-3 반올림 오차까지 허용', () => {
    expect(fingerprintMismatch(base, base)).toBeNull();
    expect(fingerprintMismatch(base, withFp({ bbox: [1.001, 2, 3, 4] }))).toBeNull();
  });

  it('칠하기 연산·구성 연산 수·해시·상자·개수가 다르면 사유를 돌려준다', () => {
    expect(fingerprintMismatch(base, withFp({ paintOp: 'S' }))).toContain('칠하기 연산');
    expect(fingerprintMismatch(base, withFp({ constructOpCount: 2 }))).toContain('구성 연산 수');
    expect(fingerprintMismatch(base, withFp({ constructHash: 'cd' }))).toContain('해시');
    expect(fingerprintMismatch(base, withFp({ bbox: [1, 2, 3, 4.5] }))).toContain('상자');
    expect(fingerprintMismatch(base, { ...base, fingerprints: [] })).toContain('칠하기 연산 수');
  });
});
