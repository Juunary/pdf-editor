import { useLayoutEffect, useRef } from 'preact/hooks';
import type {
  PageLayout as DocumentPageLayout,
  ParagraphRole,
  Rect,
} from '@pdf-editor/shared-types';
import type { PageLayout } from '../layout.js';
import { gridCells } from '../table-grid.js';

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
  /**
   * 편집 가능 표시와 함께 그리는지(사용자 요청 2026-10-22, "레이아웃·편집 표시" 한 버튼). 그러면 상자 테두리를 얇게 그려
   * 편집 가능 테두리(초록·주황)가 먼저 읽히게 한다. 채움·번호는 그대로.
   */
  thin?: boolean;
}

/** 테두리 굵기(CSS px): [기본, 편집 가능 표시와 함께]. */
const WIDTH = {
  paragraph: [1.5, 0.75],
  cellParagraph: [0.75, 0.5],
  table: [2, 1],
  grid: [0.75, 0.5],
  figure: [2, 1],
} as const;

/**
 * 레이아웃 오버레이(M2): 문단 상자(역할별 색), 표 격자, 도형 상자(점선), 최상위 읽기 순서 번호.
 * 마우스 이벤트는 받지 않는다.
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
    const px = 1 / layout.cssScale; // CSS 1px(페이지 단위)
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
      // 병합 셀 기준(W4-6): 행·열 경계 전체 선이 아니라 셀(병합이면 병합 범위)마다 상자를 그린다.
      for (const g of gridCells(t)) box(g.rect, TABLE_COLOR, w('grid'));
    }
    for (const f of doc.figures) box(f.bbox, FIGURE_COLOR, w('figure'), [6, 4]);
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
      // 왼쪽 끝 항목은 번호가 캔버스 밖으로 나가지 않게 상자 안쪽에 그린다.
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
