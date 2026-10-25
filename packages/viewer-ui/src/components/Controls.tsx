import { useEffect, useRef, useState } from 'preact/hooks';
import {
  featureDisabledReason,
  overlayToggleState,
  overlayToggleTitle,
  type FeatureName,
  type ViewerController,
} from '../controller.js';
import { useViewerState } from '../hooks.js';
import { docHistoryShortcut } from '../edit-keys.js';
import { canStep } from '../page-nav.js';
import { isFindShortcut, isTypingTarget } from '../shortcuts.js';
import { FindBar } from './FindBar.js';

interface Props {
  controller: ViewerController;
}

/**
 * 페이지 이동 · 찾기 · 레이아웃 · 편집 버튼. 툴바에 마운트한다.
 * 원본 연결 디버그 오버레이는 툴바에 두지 않는다(사용자 요청 2026-10-22). 시험·진단은 `controller.toggleDebug()` 로 켠다.
 */
export function Controls({ controller }: Props) {
  const state = useViewerState(controller);
  const t = controller.strings;
  const [draft, setDraft] = useState<string | null>(null);
  /** Esc 로 취소할 때 뒤따르는 blur 가 입력을 확정하지 않게 한다. */
  const cancelled = useRef(false);
  const shown = draft ?? String(state.pageIndex + 1);
  const session = state.edit.session;

  // Ctrl+F 가로채기. 검색이 비활성화되면 브라우저 기본 찾기에 맡긴다.
  // 편집 밖 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 는 문서 되돌리기·다시 실행이다(편집 중에는 편집기 textarea 가 처리한다).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFindShortcut(e) && controller.shouldInterceptFind()) {
        e.preventDefault();
        controller.openFind();
        return;
      }
      const edit = controller.edit;
      const step = docHistoryShortcut(e);
      if (
        !edit ||
        !step ||
        e.isComposing ||
        edit.active ||
        isTypingTarget(document.activeElement)
      ) {
        return;
      }
      if (controller.getState().disabled.edit) return;
      e.preventDefault();
      void (step === 'undo' ? edit.undo() : edit.redo());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  /** 입력 확정. 유효하지 않으면 이동하지 않고 현재 페이지 번호로 되돌린다. */
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft !== null) controller.goToPageInput(draft);
    setDraft(null);
  };

  const searchReason = featureDisabledReason(state, 'search');
  const overlay = overlayToggleState(state, controller.edit !== null, t);
  const pathSelect = controller.edit?.paths != null && !state.disabled.path;
  const disabledOwn = (Object.keys(t.featureLabels) as FeatureName[]).filter(
    (f) => state.disabled[f] !== null,
  );

  return (
    <div id="pe-controls" class="pe-controls" role="toolbar" aria-label={t.controlsLabel}>
      <button
        id="pe-prev"
        type="button"
        class="pe-btn"
        title={t.prevPage}
        aria-label={t.prevPage}
        disabled={!canStep(state.pageIndex, -1, state.pageCount)}
        onClick={() => void controller.prevPage()}
      >
        ‹
      </button>
      <input
        id="pe-page-input"
        class="pe-page-input"
        type="text"
        inputMode="numeric"
        size={4}
        aria-label={t.pageNumber}
        value={shown}
        onFocus={(e) => e.currentTarget.select()}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            cancelled.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span id="pe-page-count" class="pe-page-count">
        {t.pageCount(state.pageCount)}
      </span>
      <button
        id="pe-next"
        type="button"
        class="pe-btn"
        title={t.nextPage}
        aria-label={t.nextPage}
        disabled={!canStep(state.pageIndex, 1, state.pageCount)}
        onClick={() => void controller.nextPage()}
      >
        ›
      </button>
      <button
        id="pe-find-toggle"
        type="button"
        class="pe-btn"
        title={searchReason !== null ? t.errorDetail(searchReason) : t.findTitle}
        aria-pressed={state.find.open}
        disabled={searchReason !== null}
        onClick={() => (state.find.open ? controller.closeFind() : controller.openFind())}
      >
        {t.find}
      </button>
      {/* 레이아웃 오버레이 + 편집 가능 표시(사용자 요청 2026-10-22). 편집 중이면 바깥 클릭처럼 편집을 끝내고 켠다. */}
      <button
        id="pe-overlay-toggle"
        type="button"
        class="pe-btn"
        title={overlayToggleTitle(overlay, pathSelect, t)}
        aria-pressed={overlay.on}
        disabled={overlay.layoutReason !== null && overlay.marksReason !== null}
        onClick={() => controller.toggleOverlays()}
      >
        {t.overlay}
      </button>
      {controller.edit && !state.disabled.edit && (
        <>
          <button
            id="pe-doc-undo"
            type="button"
            class="pe-btn"
            title={t.undoTitle}
            disabled={session !== null || state.edit.busy || state.edit.history?.canUndo !== true}
            onClick={() => void controller.edit?.undo()}
          >
            {t.undo}
          </button>
          <button
            id="pe-doc-redo"
            type="button"
            class="pe-btn"
            title={t.redoTitle}
            disabled={session !== null || state.edit.busy || state.edit.history?.canRedo !== true}
            onClick={() => void controller.edit?.redo()}
          >
            {t.redo}
          </button>
          {session && (
            <button
              id="pe-edit-cancel"
              type="button"
              class="pe-btn"
              data-pe-keep=""
              title={t.editCancelTitle}
              onClick={() => void controller.edit?.cancelActive()}
            >
              {t.editCancel}
            </button>
          )}
          <button
            id="pe-fb-toggle"
            type="button"
            class="pe-btn"
            data-pe-keep=""
            title={t.fallbackTitle}
            aria-pressed={state.edit.fallbackUnderline}
            onClick={() => controller.edit?.setFallbackUnderline(!state.edit.fallbackUnderline)}
          >
            {t.fallback}
          </button>
          <label class="pe-edit-opt" data-pe-keep="" title={t.blockTaggedTitle}>
            <input
              id="pe-block-tagged"
              type="checkbox"
              checked={state.edit.blockTagged}
              onChange={(e) => controller.edit?.setBlockTagged(e.currentTarget.checked)}
            />{' '}
            {t.blockTagged}
          </label>
        </>
      )}
      {state.edit.notice && (
        <span
          id="pe-edit-notice"
          class="pe-notice pe-edit-notice"
          role="status"
          title={t.dismissTitle}
          onClick={() => controller.edit?.dismissNotice()}
        >
          {state.edit.notice} ✕
        </span>
      )}
      {disabledOwn.length > 0 && (
        <span
          id="pe-notice"
          class="pe-notice"
          title={disabledOwn.map((f) => `${t.featureLabels[f]}: ${state.disabled[f]}`).join('\n')}
        >
          {t.disabledList(disabledOwn.map((f) => t.featureLabels[f]).join(', '))}
        </span>
      )}
      {state.find.open && <FindBar controller={controller} find={state.find} />}
    </div>
  );
}
