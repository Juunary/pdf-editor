import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { PageModel } from '@pdf-editor/shared-types';
import { cssToPage, type CssBox, type PageLayout } from '../layout.js';
import {
  assembleText,
  caretAt,
  lineRange,
  wordRange,
  type CaretHit,
  type ReadingOrder,
} from '../reading-order.js';
import { rangeToCaretInterval, selectInterval } from '../selection-dom.js';
import { selectionRects } from '../selection-rects.js';
import { isSelectAllShortcut, isTypingTarget } from '../shortcuts.js';
import { layoutTextLayer } from '../text-layout.js';
import { TEXT_LAYER_FONT, canvasMeasure } from '../text-measure.js';
import { SelectionOverlay, createRectsStore } from './SelectionOverlay.js';

interface Props {
  model: PageModel;
  order: ReadingOrder;
  layout: PageLayout;
}

type DragMode = 'char' | 'word' | 'line';

interface Drag {
  mode: DragMode;
  /** Fixed caret in char mode. */
  anchor: number;
  /** Initial selection range in word and line modes. */
  base: [number, number];
}

/**
 * Transparent text layer over the canvas. Puts one span per character at the quad position (DOM order = reading order) and the text color is transparent.
 *
 * Selection does not use the browser's default drag selection; it decides the pointer position directly (caret based on the nearest character)
 * and reflects it in the DOM Selection. Selection does not jump between lines or outside line ends, and double/triple-click select a word/line.
 * Copy (copy event) assembles the selected characters into reading-order text and puts it in as text/plain.
 */
export function TextLayer({ model, order, layout }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const spansRef = useRef<HTMLElement[] | null>(null);
  const latest = useRef({ model, order, layout });
  latest.current = { model, order, layout };
  const rectsStore = useRef(createRectsStore()).current;
  const refreshSelection = useRef<() => void>(() => {});

  const lines = useMemo(
    () => layoutTextLayer(model, order, layout, canvasMeasure() ?? undefined),
    [model, order, layout],
  );

  // When the layout changes, discard the span list cache and redraw the highlight of the remaining selection at the new scale.
  useLayoutEffect(() => {
    spansRef.current = null;
    refreshSelection.current();
  }, [lines]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let drag: Drag | null = null;
    /** For Shift+click extension: the caret of the last single click. */
    let lastAnchor: number | null = null;
    /** The selection range this layer made last (a hint so copy and highlight do not scan characters). */
    let lastInterval: [number, number] | null = null;

    const spans = (): HTMLElement[] => {
      spansRef.current ??= Array.from(layer.querySelectorAll<HTMLElement>('span[data-i]'));
      return spansRef.current;
    };

    const caretFromEvent = (e: MouseEvent): CaretHit | null => {
      const { model, order, layout } = latest.current;
      const rect = layer.getBoundingClientRect();
      return caretAt(model, order, cssToPage(e.clientX - rect.left, e.clientY - rect.top, layout));
    };

    const apply = (d: Drag, hit: CaretHit) => {
      const selection = document.getSelection();
      if (!selection) return;
      const { model, order } = latest.current;
      let from = d.anchor;
      let to = hit.caret;
      if (d.mode !== 'char') {
        const r =
          d.mode === 'word' ? wordRange(model, order, hit.item) : lineRange(order, hit.item);
        from = Math.min(d.base[0], r[0]);
        to = Math.max(d.base[1], r[1]);
      }
      lastInterval = selectInterval(selection, spans(), from, to);
    };

    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      const hit = caretFromEvent(e);
      if (hit) apply(drag, hit);
    };

    const onUp = () => {
      drag = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // Block the browser's default selection start and drag, and select directly. Release focus from the input field.
      e.preventDefault();
      // If the default action is blocked, focus does not move to a subframe (MIME handler / embedded context), so
      // Ctrl+A, C and F go to the outer document (2026-10-19 integration e2e measurement). Focusing the layer element directly also releases the input field
      // focus and frame focus follows (window.focus() alone fails intermittently in embed).
      layer.focus({ preventScroll: true });
      if (!document.hasFocus()) window.focus();
      const hit = caretFromEvent(e);
      if (!hit) return;
      const { model, order } = latest.current;
      if (e.detail >= 3) {
        const base = lineRange(order, hit.item);
        drag = { mode: 'line', anchor: base[0], base };
      } else if (e.detail === 2) {
        const base = wordRange(model, order, hit.item);
        drag = { mode: 'word', anchor: base[0], base };
      } else {
        const anchor = e.shiftKey && lastAnchor !== null ? lastAnchor : hit.caret;
        lastAnchor = anchor;
        drag = { mode: 'char', anchor, base: [anchor, anchor] };
      }
      apply(drag, hit);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    /** Copy: if the selection is inside this layer, replaces it with reading-order text. */
    const onCopy = (e: ClipboardEvent) => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return;
      const interval = rangeToCaretInterval(range, spans(), lastInterval);
      if (!interval || !e.clipboardData) return;
      const { model, order } = latest.current;
      e.clipboardData.setData('text/plain', assembleText(model, order, interval[0], interval[1]));
      e.preventDefault();
    };

    /** Ctrl+A: selects all characters of this layer (default action inside an input field). */
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSelectAllShortcut(e) || isTypingTarget(document.activeElement)) return;
      const selection = document.getSelection();
      if (!selection) return;
      e.preventDefault();
      lastInterval = selectInterval(selection, spans(), 0, spans().length);
    };

    /** Reads the DOM selection (however it was made) and updates the highlight boxes. */
    const updateHighlight = () => {
      const { model, order, layout } = latest.current;
      let rects: CssBox[] = [];
      const selection = document.getSelection();
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        if (layer.contains(range.startContainer) && layer.contains(range.endContainer)) {
          const interval = rangeToCaretInterval(range, spans(), lastInterval);
          if (interval) {
            rects = selectionRects(
              model,
              order,
              interval[0],
              interval[1],
              layout.cssScale,
              layout.origin,
            );
          }
        }
      }
      rectsStore.set(rects);
    };
    refreshSelection.current = updateHighlight;

    layer.addEventListener('mousedown', onDown);
    document.addEventListener('copy', onCopy);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('selectionchange', updateHighlight);
    return () => {
      layer.removeEventListener('mousedown', onDown);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('selectionchange', updateHighlight);
      refreshSelection.current = () => {};
      rectsStore.set([]);
      onUp();
    };
  }, [rectsStore]);

  return (
    <div
      id="pe-text-layer"
      ref={layerRef}
      class="pe-text-layer"
      tabIndex={-1}
      style={{ fontFamily: TEXT_LAYER_FONT }}
      data-chars={order.items.length}
      data-orphan-chars={order.orphanChars}
    >
      <SelectionOverlay store={rectsStore} />
      {lines.map((line, li) => (
        <div key={li} class="pe-line" data-block={line.block}>
          {line.chars.flatMap((c) => {
            const char = (
              <span key={c.item} data-i={c.item} style={c.style}>
                {c.text}
              </span>
            );
            return c.space
              ? [
                  char,
                  <span key={`s${c.item}`} data-space="" style={c.space}>
                    {' '}
                  </span>,
                ]
              : [char];
          })}
        </div>
      ))}
    </div>
  );
}
