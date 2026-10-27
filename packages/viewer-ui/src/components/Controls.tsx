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
 * Page navigation, find, layout and edit buttons. Mounted in the toolbar.
 * The source-link debug overlay is not placed in the toolbar (user request 2026-10-22). Turn it on for tests and diagnostics with `controller.toggleDebug()`.
 */
export function Controls({ controller }: Props) {
  const state = useViewerState(controller);
  const t = controller.strings;
  const [draft, setDraft] = useState<string | null>(null);
  /** Keeps the blur that follows a cancel with Esc from committing the input. */
  const cancelled = useRef(false);
  const shown = draft ?? String(state.pageIndex + 1);
  const session = state.edit.session;

  // Intercepts Ctrl+F. If search is disabled, leaves it to the browser's default find.
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y outside editing are document undo/redo (during editing the editor textarea handles them).
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

  /** Commit the input. If invalid, does not navigate and restores the current page number. */
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
      {/* Layout overlay + editability overlay (user request 2026-10-22). If editing, ends the edit as an outside click would, then turns on. */}
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
