/**
 * 표 격자 오버레이(W4-6): 병합 셀 기준. 행·열 경계 전체 선이 아니라 셀(병합이면 병합 범위)마다 상자를 그린다.
 * 셀 상자는 `rowBounds`·`colBounds` 에서 `rowSpan`·`colSpan` 만큼 잡는다(`TableCell.bbox` 는 글자 외곽일 수 있어 쓰지 않는다).
 */
import type { LayoutTable, Rect, TableCell } from '@pdf-editor/shared-types';

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  rect: Rect;
}

export function cellRect(
  table: LayoutTable,
  cell: Pick<TableCell, 'row' | 'col' | 'rowSpan' | 'colSpan'>,
): Rect | null {
  const x0 = table.colBounds[cell.col];
  const x1 =
    table.colBounds[Math.min(cell.col + Math.max(cell.colSpan, 1), table.colBounds.length - 1)];
  const y0 = table.rowBounds[cell.row];
  const y1 =
    table.rowBounds[Math.min(cell.row + Math.max(cell.rowSpan, 1), table.rowBounds.length - 1)];
  if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) return null;
  return [x0, y0, x1, y1];
}

/** 그릴 격자 상자들. 셀 목록에 없는(빈) 칸은 1×1 칸으로 채운다. 병합 셀이 덮은 칸은 다시 그리지 않는다. */
export function gridCells(table: LayoutTable): GridCell[] {
  const covered = new Set<string>();
  const out: GridCell[] = [];
  for (const c of table.cells) {
    const rect = cellRect(table, c);
    if (!rect) continue;
    out.push({ row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, rect });
    for (let r = c.row; r < c.row + Math.max(c.rowSpan, 1); r++) {
      for (let k = c.col; k < c.col + Math.max(c.colSpan, 1); k++) covered.add(`${r}:${k}`);
    }
  }
  for (let r = 0; r < table.rows; r++) {
    for (let k = 0; k < table.cols; k++) {
      if (covered.has(`${r}:${k}`)) continue;
      const rect = cellRect(table, { row: r, col: k, rowSpan: 1, colSpan: 1 });
      if (rect) out.push({ row: r, col: k, rowSpan: 1, colSpan: 1, rect });
    }
  }
  return out;
}
