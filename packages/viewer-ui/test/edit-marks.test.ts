import { describe, expect, it } from 'vitest';
import type { PageEditability, PathEditability } from '@pdf-editor/shared-types';
import { buildMarks, isSmallPath, markAt, markTip } from '../src/edit-marks.js';

const path = (
  seq: number,
  bbox: [number, number, number, number],
  extra = {},
): PathEditability => ({
  pathIndex: seq,
  paintSeq: seq,
  bbox,
  editable: true,
  reasons: [],
  ...extra,
});

const page = (paths: PathEditability[]): PageEditability => ({
  pageIndex: 0,
  revision: 1,
  paragraphs: [
    {
      paragraphId: 1,
      bbox: [0, 0, 100, 20],
      editable: true,
      editedBlock: null,
      reasons: [],
      cell: null,
    },
    {
      paragraphId: 2,
      bbox: [0, 30, 50, 50],
      editable: false,
      editedBlock: null,
      reasons: ['vertical-or-rotated'],
      cell: { table: 0, row: 1, col: 2 },
    },
  ],
  paths,
  ms: 1,
});

describe('편집 가능 표시 계산', () => {
  it('문단·셀·패스를 종류별로 담고 제한은 사유 문구를 단다', () => {
    const { marks } = buildMarks(
      page([path(7, [10, 10, 60, 40], { editable: false, reasons: ['clip-path'] })]),
    );
    expect(marks.map((m) => [m.kind, m.editable])).toEqual([
      ['paragraph', true],
      ['cell', false],
      ['path', false],
    ]);
    expect(marks[1]!.reasons[0]).toContain('세로쓰기');
    expect(marks[2]!.reasons[0]).toContain('클립');
  });

  it('작은 패스(짧은 변 < 1pt 이고 긴 변 < 4pt)는 그리지 않는다. 긴 괘선은 그린다', () => {
    expect(isSmallPath([0, 0, 0.5, 3])).toBe(true);
    expect(isSmallPath([0, 0, 0.5, 40])).toBe(false);
    expect(isSmallPath([0, 0, 3, 3])).toBe(false);
    const r = buildMarks(page([path(1, [0, 0, 0.5, 3]), path(2, [0, 0, 0.5, 40])]));
    expect(r.marks.filter((m) => m.kind === 'path').map((m) => m.id)).toEqual([2]);
    expect(r.pathsSkipped).toBe(1);
  });

  it('2,000 개를 넘으면 큰 순서로 2,000 개만 남긴다', () => {
    const many = Array.from({ length: 2500 }, (_, i) => path(i, [0, 0, 5 + i, 5]));
    const r = buildMarks(page(many));
    const shown = r.marks.filter((m) => m.kind === 'path');
    expect(shown).toHaveLength(2000);
    expect(r.pathsSkipped).toBe(500);
    expect(shown[0]!.id).toBe(2499);
    expect(shown.some((m) => m.id === 0)).toBe(false);
  });

  it('마우스 아래에서 가장 작은 표시를 찾고 툴팁 문구를 만든다', () => {
    const { marks } = buildMarks(page([path(7, [10, 2, 30, 12])]));
    expect(markAt(marks, [15, 5])?.kind).toBe('path');
    expect(markAt(marks, [90, 5])?.kind).toBe('paragraph');
    expect(markAt(marks, [500, 500])).toBeNull();
    expect(markTip(marks[1]!)).toMatch(/^표 셀 · 제한: /);
    expect(markTip(marks[0]!)).toBe('문단 · 편집 가능');
  });
});
