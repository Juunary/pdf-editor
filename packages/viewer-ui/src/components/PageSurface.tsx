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

/** Current page: the canvas and the overlays on it (search highlight, debug, text layer). */
export function PageSurface({ controller }: Props) {
  const state = useViewerState(controller);
  const view = state.view;
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const session = state.edit.session;
  const pathGesture = state.edit.path.gesture;
  const region = session?.region ?? pathGesture?.region ?? null;
  /** The base bitmap drawn last, and the changed region composited over it. */
  const painted = useRef<{ view: PageView; token: number } | null>(null);
  const regionPainted = useRef<RenderedPage | null>(null);

  // After drawing the rendered bitmap onto the canvas, notify the controller (for status display and diagnostic logging). During editing, composite the changed region
  // (`DraftUpdate.region`) over it (contract D7). When the base bitmap changes (cancel restore, re-render), the changed region is laid over again.
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
        {controller.strings.pageRenderFailed(controller.strings.errorDetail(state.renderError))}
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
          strings={controller.strings}
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
      {/* Also placed before page classification and during reclassification: it receives Alt+click in the meantime and PathController handles it after classification (M8). */}
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

/** Takes out only the prepared data of that page (data of the previous page is not used while navigating). */
function readyValue<T>(loadable: Loadable<T>, pageIndex: number): T | null {
  return loadable.status === 'ready' && loadable.pageIndex === pageIndex ? loadable.value : null;
}
