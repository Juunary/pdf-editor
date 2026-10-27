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

describe('table grid (merged-cell based)', () => {
  it('a cell box spans the row/column boundaries by its span', () => {
    const t = table([]);
    expect(cellRect(t, cell(1, 1))).toEqual([100, 30, 200, 60]);
    expect(cellRect(t, cell(0, 0, 1, 2))).toEqual([0, 0, 200, 30]);
    expect(cellRect(t, cell(1, 2, 2, 1))).toEqual([200, 30, 300, 90]);
    expect(cellRect(t, cell(5, 0))).toBeNull();
  });

  it('cells covered by a merged cell are not redrawn, and cells not in the list are filled as 1×1', () => {
    const t = table([cell(0, 0, 1, 2), cell(0, 2), cell(1, 2, 2, 1)]);
    const g = gridCells(t);
    // 3 merged cells + a blank cell: (1,0)(1,1)(2,0)(2,1) = 4
    expect(g).toHaveLength(7);
    expect(g.find((c) => c.row === 0 && c.col === 1)).toBeUndefined();
    expect(g.find((c) => c.row === 0 && c.col === 0)?.rect).toEqual([0, 0, 200, 30]);
    expect(g.find((c) => c.row === 2 && c.col === 2)).toBeUndefined();
  });
});
