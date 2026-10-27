import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import {
  MATCH_COLORS,
  MATCH_LABELS,
  classifyChar,
  describeChar,
  linkSummary,
  type CharMatch,
} from '../debug-info.js';
import { cssBoxStyle, cssToPage, quadToCssBox, type PageLayout } from '../layout.js';
import { itemAtPoint, type ReadingOrder } from '../reading-order.js';

interface LayerProps {
  model: PageModel;
  linkage: PageLinkage;
  map: SourceMap;
  layout: PageLayout;
}

const MATCH_KINDS: CharMatch[] = ['matched', 'limited', 'unmatched'];

/** Canvas that colors character quads by match status (success / edit-limited / failed). It does not receive mouse events. */
export function DebugLayer({ model, linkage, map, layout }: LayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const classes = useMemo(
    () => model.chars.map((_, i) => classifyChar(linkage, map, i)),
    [model, linkage, map],
  );
  const counts = useMemo(() => {
    const c: Record<CharMatch, number> = { matched: 0, limited: 0, unmatched: 0 };
    for (const k of classes) c[k]++;
    return c;
  }, [classes]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = layout.bitmapWidth;
    canvas.height = layout.bitmapHeight;
    const s = layout.cssScale * layout.devicePixelRatio;
    ctx.setTransform(s, 0, 0, s, -layout.origin[0] * s, -layout.origin[1] * s);
    model.chars.forEach((char, i) => {
      const q = char.quad;
      ctx.fillStyle = MATCH_COLORS[classes[i] ?? 'unmatched'];
      ctx.beginPath();
      ctx.moveTo(q[0], q[1]);
      ctx.lineTo(q[2], q[3]);
      ctx.lineTo(q[6], q[7]);
      ctx.lineTo(q[4], q[5]);
      ctx.closePath();
      ctx.fill();
    });
  }, [model, classes, layout]);

  return (
    <canvas
      id="pe-debug-canvas"
      ref={canvasRef}
      class="pe-debug-canvas"
      data-matched={counts.matched}
      data-limited={counts.limited}
      data-unmatched={counts.unmatched}
      style={{ width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` }}
    />
  );
}

interface InspectorProps extends LayerProps {
  order: ReadingOrder;
  pageRef: { current: HTMLElement | null };
}

interface Hover {
  item: number;
  x: number;
  y: number;
}

/** Summary HUD and the SourceOp tooltip of the character under the mouse. Events are received at the page container. */
export function DebugInspector({ model, order, linkage, map, layout, pageRef }: InspectorProps) {
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let frame = 0;
    let pending: MouseEvent | null = null;
    const update = () => {
      frame = 0;
      const e = pending;
      pending = null;
      if (!e) return;
      const rect = page.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const item = itemAtPoint(model, order, cssToPage(x, y, layout));
      setHover((prev) =>
        item < 0 ? null : prev && prev.item === item ? { ...prev, x, y } : { item, x, y },
      );
    };
    const onMove = (e: MouseEvent) => {
      pending = e;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onLeave = () => {
      pending = null;
      setHover(null);
    };
    page.addEventListener('mousemove', onMove);
    page.addEventListener('mouseleave', onLeave);
    return () => {
      page.removeEventListener('mousemove', onMove);
      page.removeEventListener('mouseleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pageRef, model, order, layout]);

  const counts = { matched: 0, limited: 0, unmatched: 0 } satisfies Record<CharMatch, number>;
  for (let i = 0; i < model.chars.length; i++) counts[classifyChar(linkage, map, i)]++;

  const hoveredChar = hover ? order.items[hover.item]?.charIndex : undefined;
  const tip = hoveredChar === undefined ? [] : describeChar(model, linkage, map, hoveredChar);
  const char = hoveredChar === undefined ? undefined : model.chars[hoveredChar];
  const alignRight = hover !== undefined && hover !== null && hover.x > layout.cssWidth * 0.6;

  return (
    <>
      <div id="pe-debug-hud" class="pe-debug-hud">
        <div>{linkSummary(linkage.stats)}</div>
        <div class="pe-debug-legend">
          {MATCH_KINDS.map((kind) => (
            <span key={kind}>
              <i style={{ background: MATCH_COLORS[kind] }} />
              {MATCH_LABELS[kind]} {counts[kind]}
            </span>
          ))}
        </div>
      </div>
      {hover && char && (
        <>
          <div
            id="pe-debug-box"
            class="pe-debug-box"
            style={cssBoxStyle(quadToCssBox(char.quad, layout.cssScale, layout.origin))}
          />
          <div
            id="pe-debug-tip"
            class="pe-debug-tip"
            style={
              alignRight
                ? { right: `${layout.cssWidth - hover.x + 14}px`, top: `${hover.y + 14}px` }
                : { left: `${hover.x + 14}px`, top: `${hover.y + 14}px` }
            }
          >
            {tip.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
