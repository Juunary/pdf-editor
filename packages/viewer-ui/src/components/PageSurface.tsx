import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Loadable, ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { hitsOnPage } from '../search-nav.js';
import { DebugInspector, DebugLayer } from './DebugLayer.js';
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

  // 렌더된 비트맵을 캔버스에 그린 뒤 컨트롤러에 알린다(상태 표시·진단 기록용).
  useLayoutEffect(() => {
    if (!view) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      controller.log('paint-error', { pageIndex: view.pageIndex, error: '2d 컨텍스트 없음' });
      return;
    }
    const { rendered } = view;
    canvas.width = rendered.width;
    canvas.height = rendered.height;
    ctx.putImageData(new ImageData(rendered.rgba, rendered.width, rendered.height), 0, 0);
    controller.reportPainted(view);
  }, [controller, view]);

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
  const size = { width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` };

  return (
    <div
      id="pe-page"
      ref={pageRef}
      class={state.loading ? 'pe-page pe-loading' : 'pe-page'}
      data-page-index={view.pageIndex}
      data-css-scale={layout.cssScale}
      aria-busy={state.loading}
      style={size}
    >
      <canvas id="page-canvas" ref={canvasRef} class="pe-canvas" style={size} />
      {hits.length > 0 && <HighlightLayer hits={hits} layout={layout} pageIndex={view.pageIndex} />}
      {text && debug && (
        <DebugLayer model={text.model} linkage={debug.linkage} map={debug.map} layout={layout} />
      )}
      {doc && <LayoutLayer doc={doc} layout={layout} />}
      {text && (
        <TextLayer key={view.pageIndex} model={text.model} order={text.order} layout={layout} />
      )}
      {text && debug && (
        <DebugInspector
          pageRef={pageRef}
          model={text.model}
          order={text.order}
          linkage={debug.linkage}
          map={debug.map}
          layout={layout}
        />
      )}
    </div>
  );
}

/** 해당 페이지의 준비된 데이터만 꺼낸다(이동 중 이전 페이지 데이터는 쓰지 않는다). */
function readyValue<T>(loadable: Loadable<T>, pageIndex: number): T | null {
  return loadable.status === 'ready' && loadable.pageIndex === pageIndex ? loadable.value : null;
}
