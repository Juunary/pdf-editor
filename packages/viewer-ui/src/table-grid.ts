/**
 * Table grid overlay (W4-6): based on merged cells. Instead of full row/column boundary lines, a box is drawn per cell (the merged range for a merged cell).
 * A cell box spans `rowSpan`/`colSpan` from `rowBounds`/`colBounds` (`TableCell.bbox` may be the character outline, so it is not used).
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

/** Grid boxes to draw. Slots missing from the cell list (empty) are filled with 1×1 slots. Slots covered by a merged cell are not drawn again. */
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
