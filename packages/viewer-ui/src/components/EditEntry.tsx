import { useLayoutEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { PageEditability, Rect } from '@pdf-editor/shared-types';
import type { ViewerController } from '../controller.js';
import type { EditPopover } from '../edit-controller.js';
import { paragraphAt } from '../edit-geometry.js';
import { cssToPage, pageToCss, type PageLayout } from '../layout.js';

interface Props {
  controller: ViewerController;
  pageRef: RefObject<HTMLDivElement>;
  layout: PageLayout;
  pageIndex: number;
  editability: PageEditability;
  popover: EditPopover | null;
  /** plan/begin in progress, or document undo/redo in progress. */
  busy: boolean;
}

/** Page-space rectangle → container-relative CSS box. */
export function cssRect(rect: Rect, layout: PageLayout): Record<string, string> {
  const [l, t] = pageToCss([rect[0], rect[1]], layout);
  const [r, b] = pageToCss([rect[2], rect[3]], layout);
  return { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` };
}

/**
 * Edit entry (contract 5.9): when the mouse is over a paragraph, a border (editable = solid line, limited = dotted line, different color),
 * and double-clicking starts editing or shows the limit reason in a popover. A single click or drag is handled as is by the text layer.
 */
export function EditEntry({
  controller,
  pageRef,
  layout,
  pageIndex,
  editability,
  popover,
  busy,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const paragraphs = editability.paragraphs;

  // Registered as a layout effect: receives the double-click right after render (without waiting for the next frame).
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const pointOf = (e: MouseEvent) => {
      const rect = page.getBoundingClientRect();
      return cssToPage(e.clientX - rect.left, e.clientY - rect.top, layout);
    };
    const onMove = (e: MouseEvent) => {
      const hit = paragraphAt(paragraphs, pointOf(e));
      setHover((prev) => (prev === (hit?.paragraphId ?? null) ? prev : (hit?.paragraphId ?? null)));
    };
    const onLeave = () => setHover(null);
    const onDouble = (e: MouseEvent) => {
      if (busy || e.button !== 0) return;
      const point = pointOf(e);
      const hit = paragraphAt(paragraphs, point);
      if (!hit) return;
      e.preventDefault();
      void controller.edit?.begin(pageIndex, hit.paragraphId, point);
    };
    page.addEventListener('mousemove', onMove);
    page.addEventListener('mouseleave', onLeave);
    page.addEventListener('dblclick', onDouble);
    return () => {
      page.removeEventListener('mousemove', onMove);
      page.removeEventListener('mouseleave', onLeave);
      page.removeEventListener('dblclick', onDouble);
    };
  }, [controller, pageRef, layout, pageIndex, paragraphs, busy]);

  // Popover: closes on an outside press or Esc (registered as a layout effect so it receives events right after render).
  useLayoutEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('#pe-edit-popover')) {
        controller.edit?.dismissPopover();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') controller.edit?.dismissPopover();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [controller, popover]);

  const hovered = hover === null ? null : (paragraphs.find((p) => p.paragraphId === hover) ?? null);
  return (
    <div id="pe-edit-entry" class="pe-edit-entry">
      {hovered && (
        <div
          id="pe-edit-hover"
          class="pe-edit-hover"
          data-paragraph={hovered.paragraphId}
          data-editable={hovered.editable ? '1' : '0'}
          data-cell={hovered.cell ? '1' : '0'}
          style={cssRect(hovered.bbox, layout)}
        />
      )}
      {popover && popover.pageIndex === pageIndex && (
        <div
          id="pe-edit-popover"
          class="pe-edit-popover"
          role="alert"
          data-pe-keep=""
          data-paragraph={popover.paragraphId}
          style={{
            left: `${pageToCss([popover.bbox[0], popover.bbox[3]], layout)[0]}px`,
            top: `${pageToCss([popover.bbox[0], popover.bbox[3]], layout)[1] + 6}px`,
          }}
        >
          <strong>
            {popover.kind === 'cell'
              ? controller.strings.cellNotEditableTitle
              : controller.strings.paragraphNotEditableTitle}
          </strong>
          <ul>
            {popover.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <button
            type="button"
            class="pe-btn"
            id="pe-edit-popover-close"
            onClick={() => controller.edit?.dismissPopover()}
          >
            {controller.strings.popoverClose}
          </button>
        </div>
      )}
    </div>
  );
}
