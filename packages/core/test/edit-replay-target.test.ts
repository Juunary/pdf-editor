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

/**
 * R4 축소 사례(zen-ko-report-21333257 6쪽): 편집 블록(글리프 0–5)의 끝 두 글자를 레이아웃이 다음 문단(글리프 4–8)에 붙였다.
 * 판정은 블록 첫 문단(40)을 내보내고 대상 글자를 블록 전체로 넓히므로, 로그 glyphSeqs(0–5)는 어느 레이아웃 문단과도 같지 않다.
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

describe('findParagraphId: 레이아웃이 나눈 편집 블록(R4)', () => {
  const planned: Record<number, ParagraphTarget> = {
    40: blockTarget([0, 1, 2, 3, 4, 5], 'b1'),
    41: blockTarget([4, 5, 6, 7, 8], null),
  };
  const targetOf = (id: number): ParagraphTarget | null => planned[id] ?? null;

  it('정확히 같은 레이아웃 문단이 없으면 블록 글자를 가진 문단의 계획 대상으로 찾는다', () => {
    expect(findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b1'), targetOf)).toBe(
      40,
    );
  });

  it('계획 확인 함수가 없으면 이전처럼 실패한다', () => {
    expect(() => findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b1'))).toThrow(
      '재적용 대상 문단을 찾지 못함(6쪽, 글리프 6개)',
    );
  });

  it('편집 블록 대상이 아니면(editedBlock null) 넓혀 찾지 않는다', () => {
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], null), targetOf),
    ).toThrow(EditStateError);
  });

  it('계획 대상의 블록 id 나 글자가 로그와 다르면 실패한다', () => {
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4, 5], 'b2'), targetOf),
    ).toThrow(EditStateError);
    expect(() =>
      findParagraphId(splitBlockCtx(), blockTarget([0, 1, 2, 3, 4], 'b1'), targetOf),
    ).toThrow(EditStateError);
  });

  it('계획 계산이 실패한 문단(null)은 건너뛴다', () => {
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
