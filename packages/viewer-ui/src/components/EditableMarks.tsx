import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { PageEditability } from '@pdf-editor/shared-types';
import { buildMarks, markAt, markFrame, markTip, type Mark } from '../edit-marks.js';
import { cssToPage, type PageLayout } from '../layout.js';

/** 편집 가능 = 초록 실선, 제한 = 주황 점선(M3 문단 테두리와 같은 색, 계약 D6). */
const OK = '#2e7d32';
const LIMITED = '#ef6c00';
/** 레이아웃 오버레이와 함께 그릴 때 테두리를 레이아웃 상자에서 떼는 거리(CSS px). */
const LAYOUT_GAP_PX = 2.5;

interface Props {
  editability: PageEditability;
  layout: PageLayout;
  pageRef: RefObject<HTMLDivElement>;
  /** 레이아웃 오버레이가 함께 보이는지. 그러면 문단 테두리는 바깥, 셀 테두리는 안쪽으로 떼어 그린다. */
  withLayout?: boolean;
}

/**
 * 편집 가능 표시(D6): 문단·셀·패스 테두리를 한 캔버스에 그린다. 포인터를 받지 않는다(기존 층으로 통과).
 * 마우스를 올린 곳의 사유 툴팁은 쪽의 mousemove 를 들어서 계산한다.
 */
export function EditableMarks({ editability, layout, pageRef, withLayout = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const built = useMemo(() => buildMarks(editability), [editability]);
  const [tip, setTip] = useState<{ mark: Mark; x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = layout.bitmapWidth;
    canvas.height = layout.bitmapHeight;
    const s = layout.cssScale * layout.devicePixelRatio;
    ctx.setTransform(s, 0, 0, s, -layout.origin[0] * s, -layout.origin[1] * s);
    const px = 1 / layout.cssScale;
    const gap = withLayout ? LAYOUT_GAP_PX * px : 0;
    for (const kind of ['paragraph', 'cell', 'path'] as const) {
      for (const m of built.marks) {
        if (m.kind !== kind) continue;
        ctx.strokeStyle = m.editable ? OK : LIMITED;
        ctx.lineWidth = (kind === 'path' ? 0.75 : 1.5) * px;
        ctx.setLineDash(m.editable ? [] : [4 * px, 3 * px]);
        const [x0, y0, x1, y1] = markFrame(m, gap);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }, [built, layout, withLayout]);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const onMove = (e: MouseEvent) => {
      const r = page.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const hit = markAt(built.marks, cssToPage(x, y, layout), 2 / layout.cssScale);
      setTip((prev) => (hit ? { mark: hit, x, y } : prev === null ? prev : null));
    };
    const onLeave = () => setTip(null);
    page.addEventListener('mousemove', onMove);
    page.addEventListener('mouseleave', onLeave);
    return () => {
      page.removeEventListener('mousemove', onMove);
      page.removeEventListener('mouseleave', onLeave);
    };
  }, [built, layout, pageRef]);

  const counts = {
    paragraph: built.marks.filter((m) => m.kind === 'paragraph').length,
    cell: built.marks.filter((m) => m.kind === 'cell').length,
    path: built.marks.filter((m) => m.kind === 'path').length,
  };
  return (
    <div
      id="pe-marks"
      class="pe-marks"
      data-paragraphs={counts.paragraph}
      data-cells={counts.cell}
      data-paths={counts.path}
      data-paths-skipped={built.pathsSkipped}
      data-with-layout={withLayout ? '1' : '0'}
    >
      <canvas
        id="pe-marks-canvas"
        ref={canvasRef}
        class="pe-debug-canvas"
        style={{ width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` }}
      />
      <MarksLegend skipped={built.pathsSkipped} withLayout={withLayout} />
      {tip && (
        <div
          id="pe-mark-tip"
          class="pe-mark-tip"
          data-kind={tip.mark.kind}
          data-editable={tip.mark.editable ? '1' : '0'}
          style={{ left: `${tip.x + 12}px`, top: `${tip.y + 14}px` }}
        >
          {markTip(tip.mark)}
        </div>
      )}
    </div>
  );
}

/** 범례 한 줄(화면 아래쪽에 고정). 레이아웃 오버레이와 함께면 레이아웃 상자 설명을 더한다. */
export function MarksLegend({
  skipped,
  withLayout = false,
}: {
  skipped: number;
  withLayout?: boolean;
}) {
  return (
    <div id="pe-marks-legend" class="pe-marks-legend" data-pe-keep="">
      <span class="pe-legend-item">
        <i class="pe-legend-swatch" data-editable="1" /> 편집 가능
      </span>
      <span class="pe-legend-item">
        <i class="pe-legend-swatch" data-editable="0" /> 제한(점선)
      </span>
      <span class="pe-legend-item">굵은 선 = 문단·표 셀, 가는 선 = 패스</span>
      {withLayout && (
        <span class="pe-legend-item">
          <i class="pe-legend-swatch" data-layout="1" /> 레이아웃(색 = 역할, 번호 = 읽기 순서)
        </span>
      )}
      {skipped > 0 && <span class="pe-legend-item">패스 {skipped}개 생략</span>}
    </div>
  );
}
