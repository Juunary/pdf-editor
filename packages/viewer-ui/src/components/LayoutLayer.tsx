import { useLayoutEffect, useRef } from 'preact/hooks';
import type {
  PageLayout as DocumentPageLayout,
  ParagraphRole,
  Rect,
} from '@pdf-editor/shared-types';
import type { PageLayout } from '../layout.js';
import { gridCells } from '../table-grid.js';

/** Box colors by role (same as the layout overlay legend). */
export const ROLE_COLORS: Record<ParagraphRole, string> = {
  body: '#1e88e5',
  heading: '#d81b60',
  'list-item': '#2e7d32',
  caption: '#ef6c00',
  header: '#8e24aa',
  footer: '#8e24aa',
  footnote: '#6d4c41',
  other: '#546e7a',
};

const TABLE_COLOR = '#00897b';
const FIGURE_COLOR = '#f9a825';

interface Props {
  doc: DocumentPageLayout;
  layout: PageLayout;
  /**
   * Whether it is drawn together with the editability overlay (user request 2026-10-22, the single "레이아웃·편집 표시" button). If so, the box border is drawn thin so that
   * the editable borders (green, orange) read first. Fill and numbers are unchanged.
   */
  thin?: boolean;
}

/** Border widths (CSS px): [default, together with the editability overlay]. */
const WIDTH = {
  paragraph: [1.5, 0.75],
  cellParagraph: [0.75, 0.5],
  table: [2, 1],
  grid: [0.75, 0.5],
  figure: [2, 1],
} as const;

/**
 * Layout overlay (M2): paragraph boxes (colored by role), table grid, shape boxes (dotted), top-level reading-order numbers.
 * Does not receive mouse events.
 */
export function LayoutLayer({ doc, layout, thin = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = layout.bitmapWidth;
    canvas.height = layout.bitmapHeight;
    const s = layout.cssScale * layout.devicePixelRatio;
    ctx.setTransform(s, 0, 0, s, -layout.origin[0] * s, -layout.origin[1] * s);
    const px = 1 / layout.cssScale; // CSS 1px (in page units)
    const w = (k: keyof typeof WIDTH) => WIDTH[k][thin ? 1 : 0];
    const box = (r: Rect, color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * px;
      ctx.setLineDash(dash.map((d) => d * px));
      ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    };
    for (const p of doc.paragraphs) {
      ctx.fillStyle = `${ROLE_COLORS[p.role]}1f`;
      ctx.fillRect(p.bbox[0], p.bbox[1], p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
      box(
        p.bbox,
        ROLE_COLORS[p.role],
        p.table === null && p.figure === null ? w('paragraph') : w('cellParagraph'),
      );
    }
    for (const t of doc.tables) {
      box(t.bbox, TABLE_COLOR, w('table'));
      // Based on merged cells (W4-6): instead of full row/column boundary lines, a box is drawn per cell (the merged range for a merged cell).
      for (const g of gridCells(t)) box(g.rect, TABLE_COLOR, w('grid'));
    }
    for (const f of doc.figures) box(f.bbox, FIGURE_COLOR, w('figure'), [6, 4]);
    // Reading-order numbers (top-left of top-level items).
    ctx.setLineDash([]);
    ctx.font = `bold ${10 * px}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    doc.readingOrder.forEach((ref, k) => {
      const r =
        ref.kind === 'paragraph'
          ? doc.paragraphs[ref.id]?.bbox
          : ref.kind === 'table'
            ? doc.tables[ref.id]?.bbox
            : doc.figures[ref.id]?.bbox;
      if (!r) return;
      const label = String(k + 1);
      const w = ctx.measureText(label).width + 4 * px;
      // For items at the left edge, draw the number inside the box so it does not go off the canvas.
      const x = r[0] - w >= layout.origin[0] ? r[0] - w : r[0];
      ctx.fillStyle = '#212121';
      ctx.fillRect(x, r[1], w, 12 * px);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x + 2 * px, r[1] + 1 * px);
    });
  }, [doc, layout, thin]);

  return (
    <canvas
      id="pe-layout-canvas"
      ref={canvasRef}
      class="pe-debug-canvas"
      data-paragraphs={doc.paragraphs.length}
      data-tables={doc.tables.length}
      data-figures={doc.figures.length}
      data-columns={doc.columns.length}
      data-order={doc.readingOrder.length}
      data-grid-cells={doc.tables.reduce((n, t) => n + gridCells(t).length, 0)}
      data-thin={thin ? '1' : '0'}
      style={{ width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` }}
    />
  );
}
