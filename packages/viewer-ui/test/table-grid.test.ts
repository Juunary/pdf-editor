import { describe, expect, it } from 'vitest';
import type { LayoutTable } from '@pdf-editor/shared-types';
import { cellRect, gridCells } from '../src/table-grid.js';

const table = (cells: LayoutTable['cells']): LayoutTable => ({
  id: 0,
  bbox: [0, 0, 300, 90],
  rows: 3,
  cols: 3,
  rowBounds: [0, 30, 60, 90],
  colBounds: [0, 100, 200, 300],
  cells,
  strategy: 'lines',
  paths: [],
});

const cell = (row: number, col: number, rowSpan = 1, colSpan = 1) => ({
  row,
  col,
  rowSpan,
  colSpan,
  bbox: [0, 0, 1, 1] as [number, number, number, number],
  lines: [],
  paragraphs: [],
});

describe('표 격자(병합 셀 기준)', () => {
  it('셀 상자는 행·열 경계에서 span 만큼 잡는다', () => {
    const t = table([]);
    expect(cellRect(t, cell(1, 1))).toEqual([100, 30, 200, 60]);
    expect(cellRect(t, cell(0, 0, 1, 2))).toEqual([0, 0, 200, 30]);
    expect(cellRect(t, cell(1, 2, 2, 1))).toEqual([200, 30, 300, 90]);
    expect(cellRect(t, cell(5, 0))).toBeNull();
  });

  it('병합 셀이 덮은 칸은 다시 그리지 않고, 목록에 없는 칸은 1×1 로 채운다', () => {
    const t = table([cell(0, 0, 1, 2), cell(0, 2), cell(1, 2, 2, 1)]);
    const g = gridCells(t);
    // 병합 셀 3개 + 빈 칸: (1,0)(1,1)(2,0)(2,1) = 4
    expect(g).toHaveLength(7);
    expect(g.find((c) => c.row === 0 && c.col === 1)).toBeUndefined();
    expect(g.find((c) => c.row === 0 && c.col === 0)?.rect).toEqual([0, 0, 200, 30]);
    expect(g.find((c) => c.row === 2 && c.col === 2)).toBeUndefined();
  });
});
