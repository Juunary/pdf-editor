import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RenderedPage } from '@pdf-editor/shared-types';
import type { Loadable, PageView, ViewerController } from '../controller.js';
import { regionPlacement } from '../edit-paint.js';
import { useViewerState } from '../hooks.js';
import { hitsOnPage } from '../search-nav.js';
import { DebugInspector, DebugLayer } from './DebugLayer.js';
import { EditEntry } from './EditEntry.js';
import { EditableMarks } from './EditableMarks.js';
import { EditorLayer } from './EditorLayer.js';
import { PathLayer } from './PathLayer.js';
import { HighlightLayer } from './HighlightLayer.js';
import { LayoutLayer } from './LayoutLayer.js';
import { TextLayer } from './TextLayer.js';

interface Props {
  controller: ViewerController;
}

/** 현재 페이지: 캔버스와 그 위 오버레이(검색 하이라이트·디버그·텍스트 층). */
export function PageSurface({ controller }: Props) {
  const state = useViewerState(controller);
  const view = state.view;
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const session = state.edit.session;
  const pathGesture = state.edit.path.gesture;
  const region = session?.region ?? pathGesture?.region ?? null;
  /** 마지막으로 그린 기준 비트맵과, 그 위에 합성한 변경 영역. */
  const painted = useRef<{ view: PageView; token: number } | null>(null);
  const regionPainted = useRef<RenderedPage | null>(null);

  // 렌더된 비트맵을 캔버스에 그린 뒤 컨트롤러에 알린다(상태 표시·진단 기록용). 편집 중이면 그 위에 변경 영역
  // (`DraftUpdate.region`)을 합성한다(계약 D7). 기준 비트맵이 바뀌면(취소 복원·재렌더) 변경 영역도 다시 얹는다.
  useLayoutEffect(() => {
    if (!view) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      controller.log('paint-error', { pageIndex: view.pageIndex, error: '2d 컨텍스트 없음' });
      return;
    }
    const prev = painted.current;
    const baseChanged = prev?.view !== view || prev?.token !== state.repaintToken;
    if (baseChanged) {
      const { rendered } = view;
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      ctx.putImageData(new ImageData(rendered.rgba, rendered.width, rendered.height), 0, 0);
      painted.current = { view, token: state.repaintToken };
      regionPainted.current = null;
      if (prev?.view !== view) controller.reportPainted(view);
    }
    if (region && regionPainted.current !== region.rendered) {
      const { rendered } = region;
      const at = regionPlacement(rendered, view.layout);
      ctx.putImageData(new ImageData(rendered.rgba, rendered.width, rendered.height), at.x, at.y);
      regionPainted.current = rendered;
      if (!baseChanged) controller.edit?.currentSession()?.reportPainted(region.seq);
    }
  }, [controller, view, state.repaintToken, region]);

  if (!view) {
    return state.renderError ? (
      <div id="pe-render-error" class="pe-render-error" role="alert">
        페이지를 그리지 못했습니다: {state.renderError}
      </div>
    ) : null;
  }

  const { layout } = view;
  const text = readyValue(state.text, view.pageIndex);
  const debug = state.debugEnabled ? readyValue(state.debug, view.pageIndex) : null;
  const doc = state.layoutEnabled ? readyValue(state.layout, view.pageIndex) : null;
  const hits = hitsOnPage(state.find, view.pageIndex);
  const editability = state.edit.editability;
  const entry =
    !session && editability.status === 'ready' && editability.pageIndex === view.pageIndex
      ? editability.value
      : null;
  const pathCandidates =
    !session && controller.edit?.paths ? controller.edit.paths.candidates(view.pageIndex) : [];
  const showMarks = !session && entry !== null && state.edit.showEditable;
  const size = { width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` };

  return (
    <div
      id="pe-page"
      ref={pageRef}
      class={state.loading ? 'pe-page pe-loading' : 'pe-page'}
      data-page-index={view.pageIndex}
      data-css-scale={layout.cssScale}
      data-editing={session ? '1' : '0'}
      aria-busy={state.loading}
      style={size}
    >
      <canvas id="page-canvas" ref={canvasRef} class="pe-canvas" style={size} />
      {!session && hits.length > 0 && (
        <HighlightLayer hits={hits} layout={layout} pageIndex={view.pageIndex} />
      )}
      {!session && text && debug && (
        <DebugLayer model={text.model} linkage={debug.linkage} map={debug.map} layout={layout} />
      )}
      {!session && doc && <LayoutLayer doc={doc} layout={layout} thin={showMarks} />}
      {!session && text && (
        <TextLayer key={view.pageIndex} model={text.model} order={text.order} layout={layout} />
      )}
      {!session && text && debug && (
        <DebugInspector
          pageRef={pageRef}
          model={text.model}
          order={text.order}
          linkage={debug.linkage}
          map={debug.map}
          layout={layout}
        />
      )}
      {showMarks && entry && (
        <EditableMarks
          editability={entry}
          layout={layout}
          pageRef={pageRef}
          withLayout={doc !== null}
        />
      )}
      {entry && (
        <EditEntry
          controller={controller}
          pageRef={pageRef}
          layout={layout}
          pageIndex={view.pageIndex}
          editability={entry}
          popover={state.edit.popover}
          busy={state.edit.starting || state.edit.busy}
        />
      )}
      {/* 쪽 판정 전·재판정 중에도 둔다: 그 사이의 Alt+클릭을 받아 PathController 가 판정 뒤 처리한다(M8). */}
      {!session && controller.edit?.paths && !state.disabled.path && (
        <PathLayer
          controller={controller}
          pageRef={pageRef}
          view={view}
          path={state.edit.path}
          showEditable={state.edit.showEditable}
          candidates={pathCandidates}
        />
      )}
      {session && (
        <EditorLayer
          controller={controller}
          pageRef={pageRef}
          layout={layout}
          session={session}
          fallbackUnderline={state.edit.fallbackUnderline}
        />
      )}
    </div>
  );
}

/** 해당 페이지의 준비된 데이터만 꺼낸다(이동 중 이전 페이지 데이터는 쓰지 않는다). */
function readyValue<T>(loadable: Loadable<T>, pageIndex: number): T | null {
  return loadable.status === 'ready' && loadable.pageIndex === pageIndex ? loadable.value : null;
}
