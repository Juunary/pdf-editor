import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { PageEditability } from '@pdf-editor/shared-types';
import {
  buildMarks,
  markAt,
  markFrame,
  markTip,
  MAX_PATH_MARKS,
  type Mark,
} from '../edit-marks.js';
import { VIEWER_STRINGS, type ViewerStrings } from '../strings.js';
import { cssToPage, type PageLayout } from '../layout.js';

/** Editable = green solid line, limited = orange dotted line (same colors as the M3 paragraph border, contract D6). */
const OK = '#2e7d32';
const LIMITED = '#ef6c00';
/** Distance (CSS px) by which the border is separated from the layout box when drawn together with the layout overlay. */
const LAYOUT_GAP_PX = 2.5;

interface Props {
  editability: PageEditability;
  layout: PageLayout;
  pageRef: RefObject<HTMLDivElement>;
  /** Whether the layout overlay is also visible. If so, paragraph borders are drawn outside and cell borders inside, offset. */
  withLayout?: boolean;
  /** Legend, tooltip and reason strings (Korean by default). */
  strings?: ViewerStrings;
}

/**
 * Editability overlay (D6): draws paragraph, cell and path borders on one canvas. Does not receive pointers (passes through to the existing layers).
 * The tooltip of the reason at the point where the mouse hovers is computed by listening to the page's mousemove.
 */
export function EditableMarks({
  editability,
  layout,
  pageRef,
  withLayout = false,
  strings = VIEWER_STRINGS.ko,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const built = useMemo(
    () => buildMarks(editability, MAX_PATH_MARKS, strings),
    [editability, strings],
  );
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
      <MarksLegend skipped={built.pathsSkipped} withLayout={withLayout} strings={strings} />
      {tip && (
        <div
          id="pe-mark-tip"
          class="pe-mark-tip"
          data-kind={tip.mark.kind}
          data-editable={tip.mark.editable ? '1' : '0'}
          style={{ left: `${tip.x + 12}px`, top: `${tip.y + 14}px` }}
        >
          {markTip(tip.mark, strings)}
        </div>
      )}
    </div>
  );
}

/** Legend line (pinned at the bottom of the screen). With the layout overlay, adds the layout box description. */
export function MarksLegend({
  skipped,
  withLayout = false,
  strings: t = VIEWER_STRINGS.ko,
}: {
  skipped: number;
  withLayout?: boolean;
  strings?: ViewerStrings;
}) {
  return (
    <div id="pe-marks-legend" class="pe-marks-legend" data-pe-keep="">
      <span class="pe-legend-item">
        <i class="pe-legend-swatch" data-editable="1" /> {t.legendEditable}
      </span>
      <span class="pe-legend-item">
        <i class="pe-legend-swatch" data-editable="0" /> {t.legendLimited}
      </span>
      <span class="pe-legend-item">{t.legendLines}</span>
      {withLayout && (
        <span class="pe-legend-item">
          <i class="pe-legend-swatch" data-layout="1" /> {t.legendLayout}
        </span>
      )}
      {skipped > 0 && <span class="pe-legend-item">{t.legendSkipped(skipped)}</span>}
    </div>
  );
}
