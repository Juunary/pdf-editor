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
  /** plan·begin 진행 중이거나 문서 undo/redo 처리 중. */
  busy: boolean;
}

/** 페이지 공간 사각형 → 컨테이너 기준 CSS 상자. */
export function cssRect(rect: Rect, layout: PageLayout): Record<string, string> {
  const [l, t] = pageToCss([rect[0], rect[1]], layout);
  const [r, b] = pageToCss([rect[2], rect[3]], layout);
  return { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` };
}

/**
 * 편집 진입(계약 5.9): 마우스가 문단 위에 있으면 테두리(편집 가능 = 실선, 제한 = 점선·다른 색),
 * 더블클릭하면 편집을 시작하거나 제한 사유를 팝오버로 보여 준다. 한 번 클릭·드래그는 텍스트 층이 그대로 처리한다.
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

  // 레이아웃 효과로 등록한다: 렌더 직후(다음 프레임을 기다리지 않고) 더블클릭을 받는다.
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

  // 팝오버: 바깥을 누르거나 Esc 를 누르면 닫는다(렌더 직후부터 받도록 레이아웃 효과로 등록한다).
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
          <strong>이 문단은 편집할 수 없습니다</strong>
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
            닫기
          </button>
        </div>
      )}
    </div>
  );
}
