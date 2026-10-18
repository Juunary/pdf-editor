import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import type { PageModel } from '@pdf-editor/shared-types';
import { cssToPage, type PageLayout } from '../layout.js';
import {
  assembleText,
  caretAt,
  lineRange,
  wordRange,
  type CaretHit,
  type ReadingOrder,
} from '../reading-order.js';
import { rangeToCaretInterval, selectInterval } from '../selection-dom.js';
import { isSelectAllShortcut, isTypingTarget } from '../shortcuts.js';
import { layoutTextLayer } from '../text-layout.js';
import { TEXT_LAYER_FONT, canvasMeasure } from '../text-measure.js';

interface Props {
  model: PageModel;
  order: ReadingOrder;
  layout: PageLayout;
}

type DragMode = 'char' | 'word' | 'line';

interface Drag {
  mode: DragMode;
  /** char 모드의 고정 캐럿. */
  anchor: number;
  /** word·line 모드의 처음 선택 구간. */
  base: [number, number];
}

/**
 * 캔버스 위 투명 텍스트 층. 글자마다 span 하나를 quad 위치에 두고(DOM 순서 = 읽기 순서) 글자색은 투명하다.
 *
 * 선택은 브라우저 기본 드래그 선택을 쓰지 않고 포인터 위치를 직접 판정해(가장 가까운 글자 기준 캐럿)
 * DOM Selection 에 반영한다. 줄 사이·줄 끝 바깥에서도 선택이 튀지 않고, 더블/트리플클릭은 단어/줄 선택이다.
 * 복사(copy 이벤트)는 선택된 글자를 읽기 순서 텍스트로 조립해 text/plain 으로 넣는다.
 */
export function TextLayer({ model, order, layout }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const spansRef = useRef<HTMLElement[] | null>(null);
  const latest = useRef({ model, order, layout });
  latest.current = { model, order, layout };

  const lines = useMemo(
    () => layoutTextLayer(model, order, layout, canvasMeasure() ?? undefined),
    [model, order, layout],
  );

  // 레이아웃이 바뀌면 span 목록 캐시를 버린다.
  useLayoutEffect(() => {
    spansRef.current = null;
  }, [lines]);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    let drag: Drag | null = null;
    /** Shift+클릭 확장용: 마지막 단일 클릭의 캐럿. */
    let lastAnchor: number | null = null;

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
      selectInterval(selection, spans(), from, to);
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
      // 브라우저 기본 선택 시작·드래그를 막고 직접 선택한다. 입력란 포커스는 해제한다.
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur?.();
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

    /** 복사: 선택이 이 층 안이면 읽기 순서 텍스트로 대체한다. */
    const onCopy = (e: ClipboardEvent) => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return;
      const interval = rangeToCaretInterval(range, spans());
      if (!interval || !e.clipboardData) return;
      const { model, order } = latest.current;
      e.clipboardData.setData('text/plain', assembleText(model, order, interval[0], interval[1]));
      e.preventDefault();
    };

    /** Ctrl+A: 이 층의 모든 글자를 선택한다(입력란 안에서는 기본 동작). */
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSelectAllShortcut(e) || isTypingTarget(document.activeElement)) return;
      const selection = document.getSelection();
      if (!selection) return;
      e.preventDefault();
      selectInterval(selection, spans(), 0, spans().length);
    };

    layer.addEventListener('mousedown', onDown);
    document.addEventListener('copy', onCopy);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      layer.removeEventListener('mousedown', onDown);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('keydown', onKeyDown);
      onUp();
    };
  }, []);

  return (
    <div
      id="pe-text-layer"
      ref={layerRef}
      class="pe-text-layer"
      style={{ fontFamily: TEXT_LAYER_FONT }}
      data-chars={order.items.length}
      data-orphan-chars={order.orphanChars}
    >
      {lines.map((line, li) => (
        <div key={li} class="pe-line" data-block={line.block}>
          {line.chars.map((c) => (
            <span key={c.item} data-i={c.item} style={c.style}>
              {c.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
