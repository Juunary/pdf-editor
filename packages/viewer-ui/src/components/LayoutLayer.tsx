import { useLayoutEffect, useRef } from 'preact/hooks';
import type {
  PageLayout as DocumentPageLayout,
  ParagraphRole,
  Rect,
} from '@pdf-editor/shared-types';
import type { PageLayout } from '../layout.js';

/** 역할별 상자 색(레이아웃 오버레이 범례와 같다). */
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
}

/**
 * 레이아웃 오버레이(M2): 문단 상자(역할별 색), 표 격자, 도형 상자(점선), 최상위 읽기 순서 번호.
 * 마우스 이벤트는 받지 않는다.
 */
export function LayoutLayer({ doc, layout }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = layout.bitmapWidth;
    canvas.height = layout.bitmapHeight;
    const s = layout.cssScale * layout.devicePixelRatio;
    ctx.setTransform(s, 0, 0, s, -layout.origin[0] * s, -layout.origin[1] * s);
    const px = 1 / layout.cssScale; // CSS 1px(페이지 단위)
    const box = (r: Rect, color: string, width: number, dash: number[] = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * px;
      ctx.setLineDash(dash.map((d) => d * px));
      ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    };
    for (const p of doc.paragraphs) {
      ctx.fillStyle = `${ROLE_COLORS[p.role]}1f`;
      ctx.fillRect(p.bbox[0], p.bbox[1], p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
      box(p.bbox, ROLE_COLORS[p.role], p.table === null && p.figure === null ? 1.5 : 0.75);
    }
    for (const t of doc.tables) {
      box(t.bbox, TABLE_COLOR, 2);
      ctx.lineWidth = 0.75 * px;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const y of t.rowBounds.slice(1, -1)) {
        ctx.moveTo(t.bbox[0], y);
        ctx.lineTo(t.bbox[2], y);
      }
      for (const x of t.colBounds.slice(1, -1)) {
        ctx.moveTo(x, t.bbox[1]);
        ctx.lineTo(x, t.bbox[3]);
      }
      ctx.stroke();
    }
    for (const f of doc.figures) box(f.bbox, FIGURE_COLOR, 2, [6, 4]);
    // 읽기 순서 번호(최상위 항목 왼쪽 위).
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
      ctx.fillStyle = '#212121';
      ctx.fillRect(r[0] - w, r[1], w, 12 * px);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, r[0] - w + 2 * px, r[1] + 1 * px);
    });
  }, [doc, layout]);

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
      style={{ width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` }}
    />
  );
}
