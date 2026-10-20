import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { Matrix, PageModel, PathEditPlan, Point, Rect } from '@pdf-editor/shared-types';
import type { HandleName } from '../edit-geometry.js';
import type { PageView, ViewerController } from '../controller.js';
import { hexToRgb, pickerValue } from '../path-colors.js';
import { emptyPathEdit, type PathState } from '../path-controller.js';
import type { PathGesture } from '../path-gesture.js';
import {
  HANDLE_NAMES,
  boxTransform,
  pathPoints,
  resizeBox,
  transformRect,
  translateBox,
  unionRect,
  type PathCandidate,
  type PathPoint,
} from '../path-geometry.js';
import { cssToPage, pageToCss, renderScale, type PageLayout } from '../layout.js';
import { isTypingTarget } from '../shortcuts.js';

interface Props {
  controller: ViewerController;
  pageRef: RefObject<HTMLDivElement>;
  view: PageView;
  path: PathState;
  showEditable: boolean;
  /** 선택 후보(모델 + 쪽 판정). */
  candidates: PathCandidate[];
}

/** 끌기를 시작하기 위한 최소 이동(CSS px). 클릭과 구분한다. */
const DRAG_THRESHOLD_PX = 3;

type Drag =
  | {
      kind: 'move' | 'resize';
      handle: HandleName | null;
      start: Point;
      box: Rect;
      clientX: number;
      clientY: number;
      gesture: PathGesture | null;
      moved: boolean;
    }
  | {
      kind: 'point';
      index: number;
      start: Point;
      at: Point;
      clientX: number;
      clientY: number;
      gesture: PathGesture | null;
      moved: boolean;
    };

const cssBox = (rect: Rect, layout: PageLayout): Record<string, string> => {
  const [l, t] = pageToCss([rect[0], rect[1]], layout);
  const [r, b] = pageToCss([rect[2], rect[3]], layout);
  return { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${b - t}px` };
};

const handlePos = (h: HandleName, box: Rect): Point => [
  h.includes('w') ? box[0] : h.includes('e') ? box[2] : (box[0] + box[2]) / 2,
  h.includes('n') ? box[1] : h.includes('s') ? box[3] : (box[1] + box[3]) / 2,
];

/** 패스 선택 후 편집 UI: 선택 상자·핸들, 점 편집, 속성 패널, 끌기 미리보기. 선택·키 입력도 여기서 받는다. */
export function PathLayer({ controller, pageRef, view, path, showEditable, candidates }: Props) {
  const paths = controller.edit?.paths ?? null;
  const layout = view.layout;
  const selection = path.selection?.pageIndex === view.pageIndex ? path.selection : null;
  const plan = selection?.plan ?? null;
  const gesture = path.gesture;
  const drag = useRef<Drag | null>(null);
  const [, bump] = useState(0);
  /** 끌기 직후 따라오는 click 이 선택을 바꾸지 않게 한다. */
  const justDragged = useRef(false);

  const selected = useMemo(
    () => candidates.filter((c) => selection?.paintSeqs.includes(c.paintSeq)),
    [candidates, selection],
  );
  const baseBox: Rect | null = useMemo(() => {
    if (selected.length > 0) return unionRect(selected.map((c) => c.bbox));
    return plan ? plan.target.bbox : null;
  }, [selected, plan]);

  // 클릭으로 패스 선택: 편집 가능 표시가 켜져 있거나 Alt+클릭(글자 선택과 충돌 방지, 계약 4.5).
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || !paths) return;
    const onDown = (e: MouseEvent) => {
      if (e.button === 0 && e.altKey && !inPathUi(e.target)) e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || inPathUi(e.target)) return;
      const rect = page.getBoundingClientRect();
      const point = cssToPage(e.clientX - rect.left, e.clientY - rect.top, layout);
      const wantsPath = e.altKey || showEditable;
      if (!wantsPath) {
        // 바깥 클릭: 선택을 푼다.
        paths.clear();
        return;
      }
      // 글자를 끌어 선택한 직후의 클릭은 패스 선택으로 보지 않는다.
      const sel = window.getSelection();
      if (!e.altKey && sel && !sel.isCollapsed) return;
      void paths.selectAt(view.pageIndex, point, layout.cssScale, e.shiftKey);
    };
    page.addEventListener('mousedown', onDown, true);
    page.addEventListener('click', onClick);
    return () => {
      page.removeEventListener('mousedown', onDown, true);
      page.removeEventListener('click', onClick);
    };
  }, [paths, pageRef, layout, view.pageIndex, showEditable]);

  // 키: Delete/Backspace = 삭제, Esc = 끌기 취소 → 점 편집 종료 → 선택 해제.
  useLayoutEffect(() => {
    if (!paths || !selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        drag.current = null;
        void (async () => {
          if (await paths.cancelGesture()) return;
          if (controller.getState().edit.path.pointMode) paths.setPointMode(false);
          else paths.clear();
        })();
        e.preventDefault();
        return;
      }
      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        !isTypingTarget(document.activeElement)
      ) {
        if (plan?.editable) {
          e.preventDefault();
          void paths.deleteSelected();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paths, selection, plan, controller]);

  if (!paths || !selection || !baseBox) return null;

  const editable = plan?.editable === true;
  const gEdit = gesture?.edit ?? null;
  const transform: Matrix | null = gEdit?.transform ?? null;
  const shownBox: Rect = transform ? transformRect(transform, baseBox) : baseBox;
  const points: PathPoint[] =
    path.pointMode && selected.length === 1
      ? pathPoints(selected[0]!.infos.find((i) => i.segments) ?? selected[0]!.infos[0]!)
      : [];
  const dragged = gEdit?.points?.[0] ?? null;
  const shownPoints = points.map((pt) =>
    dragged && dragged.index === pt.index ? { ...pt, p: dragged.to } : pt,
  );

  const pointOf = (e: PointerEvent): Point => {
    const page = pageRef.current!;
    const r = page.getBoundingClientRect();
    return cssToPage(e.clientX - r.left, e.clientY - r.top, layout);
  };

  const onPointerDown = (e: PointerEvent, next: Drag) => {
    if (e.button !== 0 || !editable) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = next;
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dxCss = e.clientX - d.clientX;
    const dyCss = e.clientY - d.clientY;
    if (!d.moved && Math.hypot(dxCss, dyCss) < DRAG_THRESHOLD_PX) return;
    if (!d.gesture) {
      d.gesture = paths.beginGesture();
      if (!d.gesture) {
        drag.current = null;
        return;
      }
    }
    d.moved = true;
    const now = pointOf(e);
    const dx = now[0] - d.start[0];
    const dy = now[1] - d.start[1];
    if (d.kind === 'point') {
      const to: Point = [d.at[0] + dx, d.at[1] + dy];
      d.gesture.update(emptyPathEdit({ points: [{ index: d.index, to }] }));
    } else {
      const next =
        d.kind === 'move' || !d.handle
          ? translateBox(d.box, dx, dy)
          : resizeBox(d.box, d.handle, dx, dy, e.shiftKey);
      d.gesture.update(emptyPathEdit({ transform: boxTransform(d.box, next) }));
    }
    bump((n) => n + 1);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
    }
    if (d?.gesture) void paths.commitGesture();
  };
  // 선택 상자 위의 Shift+클릭(다중 선택에 더하기·빼기)과 Alt+클릭은 아래 패스에 전달한다.
  const onBoxClick = (e: MouseEvent) => {
    if (justDragged.current || (!e.shiftKey && !e.altKey)) return;
    const page = pageRef.current;
    if (!page) return;
    const r = page.getBoundingClientRect();
    const p = cssToPage(e.clientX - r.left, e.clientY - r.top, layout);
    void paths.selectAt(view.pageIndex, p, layout.cssScale, e.shiftKey);
  };

  const startBox = (kind: 'move' | 'resize', handle: HandleName | null) => (e: PointerEvent) =>
    onPointerDown(e, {
      kind,
      handle,
      start: pointOf(e),
      box: baseBox,
      clientX: e.clientX,
      clientY: e.clientY,
      gesture: null,
      moved: false,
    });
  const startPoint = (pt: PathPoint) => (e: PointerEvent) =>
    onPointerDown(e, {
      kind: 'point',
      index: pt.index,
      start: pointOf(e),
      at: pt.p,
      clientX: e.clientX,
      clientY: e.clientY,
      gesture: null,
      moved: false,
    });

  const canPoints = selection.paintSeqs.length === 1 && editable;
  return (
    <div
      id="pe-path-layer"
      class="pe-path-layer"
      data-count={selection.paintSeqs.length}
      data-editable={editable ? '1' : '0'}
      data-point-mode={path.pointMode ? '1' : '0'}
    >
      {gesture?.pending && transform && !gEdit?.points && (
        <PathPreview view={view} from={baseBox} to={shownBox} />
      )}
      {selected.map((c) => (
        <div
          key={c.paintSeq}
          class="pe-path-member"
          data-seq={c.paintSeq}
          style={cssBox(c.bbox, layout)}
        />
      ))}
      <div
        id="pe-path-box"
        class="pe-path-box"
        data-pe-path-ui=""
        data-pe-keep=""
        data-active={gesture ? '1' : '0'}
        data-bbox={shownBox.map((v) => v.toFixed(2)).join(',')}
        style={cssBox(shownBox, layout)}
        onPointerDown={path.pointMode ? undefined : startBox('move', null)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onBoxClick}
      >
        {editable &&
          !path.pointMode &&
          HANDLE_NAMES.map((h) => (
            <i
              key={h}
              class="pe-path-handle"
              data-handle={h}
              data-pe-path-ui=""
              style={{
                left: `${((handlePos(h, shownBox)[0] - shownBox[0]) / Math.max(shownBox[2] - shownBox[0], 1e-6)) * 100}%`,
                top: `${((handlePos(h, shownBox)[1] - shownBox[1]) / Math.max(shownBox[3] - shownBox[1], 1e-6)) * 100}%`,
              }}
              onPointerDown={startBox('resize', h)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          ))}
      </div>
      {path.pointMode && (
        <>
          <svg class="pe-path-lines" width={layout.cssWidth} height={layout.cssHeight}>
            {shownPoints
              .filter((pt) => pt.kind === 'control' && pt.anchor)
              .map((pt) => {
                const a = pageToCss(pt.anchor!, layout);
                const c = pageToCss(pt.p, layout);
                return <line key={pt.index} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} />;
              })}
          </svg>
          {shownPoints.map((pt) => {
            const [x, y] = pageToCss(pt.p, layout);
            return (
              <i
                key={pt.index}
                class="pe-path-point"
                data-index={pt.index}
                data-kind={pt.kind}
                data-pe-path-ui=""
                style={{ left: `${x}px`, top: `${y}px` }}
                onPointerDown={startPoint(pt)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
            );
          })}
        </>
      )}
      <PathPanel
        controller={controller}
        layout={layout}
        box={shownBox}
        plan={plan}
        count={selection.paintSeqs.length}
        pointMode={path.pointMode}
        canPoints={canPoints}
        busy={gesture !== null}
        note={path.note}
        error={gesture?.error ?? null}
      />
    </div>
  );
}

function inPathUi(target: EventTarget | null): boolean {
  return (target as Element | null)?.closest?.('[data-pe-path-ui]') != null;
}

interface PanelProps {
  controller: ViewerController;
  layout: PageLayout;
  box: Rect;
  plan: PathEditPlan | null;
  count: number;
  pointMode: boolean;
  canPoints: boolean;
  busy: boolean;
  note: string[] | null;
  error: string | null;
}

/** 속성 패널(채움 색·선 색·선 두께·점 편집·삭제). 색 선택기는 닫을 때(`change`) 한 번만 커밋한다. */
function PathPanel({
  controller,
  layout,
  box,
  plan,
  count,
  pointMode,
  canPoints,
  busy,
  note,
  error,
}: PanelProps) {
  const paths = controller.edit?.paths;
  if (!paths) return null;
  const editable = plan?.editable === true;
  const multi = count > 1;
  // 채움 색은 채우는 패스, 선 색·선 두께는 긋는 패스가 선택에 있을 때만(리뷰 L6).
  const paints = paths.selectionPaints();
  const [x, y] = pageToCss([box[0], box[3]], layout);
  const [rx] = pageToCss([box[2], box[1]], layout);
  const onColor = (field: 'fill' | 'stroke') => (e: Event) => {
    const rgb = hexToRgb((e.currentTarget as HTMLInputElement).value);
    if (rgb) void paths.applyOnce(emptyPathEdit({ [field]: rgb }));
  };
  const onWidth = (e: Event) => {
    const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v) && v >= 0) void paths.applyOnce(emptyPathEdit({ lineWidth: v }));
  };
  return (
    <div
      id="pe-path-panel"
      class="pe-path-panel"
      data-pe-path-ui=""
      data-pe-keep=""
      style={{ left: `${Math.max(0, Math.min(x, rx))}px`, top: `${y + 8}px` }}
    >
      <strong>{multi ? `패스 ${count}개 선택` : '패스 1개 선택'}</strong>
      {!editable && plan && (
        <ul id="pe-path-note" class="pe-path-note">
          {(note ?? ['이 패스는 편집할 수 없습니다.']).map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {editable && (
        <>
          <label>
            채움 색
            <input
              id="pe-path-fill"
              type="color"
              disabled={busy || !paints.fills}
              value={pickerValue(plan.fill)}
              onChange={onColor('fill')}
            />
          </label>
          <label>
            선 색
            <input
              id="pe-path-stroke"
              type="color"
              disabled={busy || !paints.strokes}
              value={pickerValue(plan.stroke)}
              onChange={onColor('stroke')}
            />
          </label>
          <label>
            선 두께(pt)
            <input
              id="pe-path-width"
              type="number"
              min="0"
              step="0.5"
              disabled={busy || !paints.strokes}
              value={plan.lineWidth === null ? '' : String(Math.round(plan.lineWidth * 100) / 100)}
              onChange={onWidth}
            />
          </label>
          <button
            id="pe-path-points"
            type="button"
            class="pe-btn"
            disabled={!canPoints || busy}
            aria-pressed={pointMode}
            title={
              canPoints
                ? '꼭짓점·제어점을 끌어 옮깁니다(패스 하나)'
                : '패스 하나를 선택하면 점 편집을 할 수 있습니다'
            }
            onClick={() => paths.setPointMode(!pointMode)}
          >
            점 편집
          </button>
          <button
            id="pe-path-delete"
            type="button"
            class="pe-btn"
            disabled={busy}
            title="선택한 패스를 지웁니다 (Delete)"
            onClick={() => void paths.deleteSelected()}
          >
            삭제
          </button>
        </>
      )}
      <button id="pe-path-clear" type="button" class="pe-btn" onClick={() => paths.clear()}>
        선택 해제
      </button>
      {error && (
        <p id="pe-path-error" class="pe-path-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 끄는 동안 원 렌더 비트맵 조각을 변환해 보여 준다(서버 갱신이 오기 전 미리보기, 계약 4.5). */
function PathPreview({ view, from, to }: { view: PageView; from: Rect; to: Rect }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const source = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = view.rendered.width;
    c.height = view.rendered.height;
    c.getContext('2d')?.putImageData(
      new ImageData(view.rendered.rgba, view.rendered.width, view.rendered.height),
      0,
      0,
    );
    return c;
  }, [view.rendered]);
  const { layout } = view;
  useLayoutEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = layout.bitmapWidth;
    canvas.height = layout.bitmapHeight;
    const s = renderScale(layout.cssScale, layout.devicePixelRatio);
    const px = (r: Rect): Rect => [
      (r[0] - layout.origin[0]) * s,
      (r[1] - layout.origin[1]) * s,
      (r[2] - layout.origin[0]) * s,
      (r[3] - layout.origin[1]) * s,
    ];
    const [sx0, sy0, sx1, sy1] = px(from);
    const [dx0, dy0, dx1, dy1] = px(to);
    const sw = Math.max(1, sx1 - sx0);
    const sh = Math.max(1, sy1 - sy0);
    ctx.drawImage(source, sx0, sy0, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
  }, [source, layout, from, to]);
  return (
    <canvas
      id="pe-path-preview"
      ref={ref}
      class="pe-debug-canvas"
      style={{ width: `${layout.cssWidth}px`, height: `${layout.cssHeight}px` }}
    />
  );
}

export type { PageModel };
