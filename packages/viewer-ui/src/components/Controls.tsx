import { useEffect, useRef, useState } from 'preact/hooks';
import { featureDisabledReason, type FeatureName, type ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { docHistoryShortcut } from '../edit-keys.js';
import { EDIT_PAGES_NOTICE } from '../edit-labels.js';
import { canStep } from '../page-nav.js';
import { isFindShortcut, isTypingTarget } from '../shortcuts.js';
import { FindBar } from './FindBar.js';

const FEATURE_LABELS: Record<FeatureName, string> = {
  text: '텍스트 선택',
  search: '검색',
  debug: '연결 디버그',
  layout: '레이아웃',
  edit: '문단 편집',
};

interface Props {
  controller: ViewerController;
}

/** 페이지 이동 · 찾기 · 디버그 토글. 툴바에 마운트한다. */
export function Controls({ controller }: Props) {
  const state = useViewerState(controller);
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
  const debugReason = featureDisabledReason(state, 'debug');
  const layoutReason = featureDisabledReason(state, 'layout');
  const disabledOwn = (Object.keys(FEATURE_LABELS) as FeatureName[]).filter(
    (f) => state.disabled[f] !== null,
  );

  return (
    <div id="pe-controls" class="pe-controls" role="toolbar" aria-label="페이지 이동">
      <button
        id="pe-prev"
        type="button"
        class="pe-btn"
        title="이전 페이지"
        aria-label="이전 페이지"
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
        aria-label="페이지 번호"
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
        / {state.pageCount}
      </span>
      <button
        id="pe-next"
        type="button"
        class="pe-btn"
        title="다음 페이지"
        aria-label="다음 페이지"
        disabled={!canStep(state.pageIndex, 1, state.pageCount)}
        onClick={() => void controller.nextPage()}
      >
        ›
      </button>
      <button
        id="pe-find-toggle"
        type="button"
        class="pe-btn"
        title={searchReason ?? '문서에서 찾기 (Ctrl+F)'}
        aria-pressed={state.find.open}
        disabled={searchReason !== null}
        onClick={() => (state.find.open ? controller.closeFind() : controller.openFind())}
      >
        찾기
      </button>
      <button
        id="pe-debug-toggle"
        type="button"
        class="pe-btn"
        title={debugReason ?? '원본 연결 디버그 오버레이'}
        aria-pressed={state.debugEnabled}
        disabled={debugReason !== null}
        onClick={() => controller.toggleDebug()}
      >
        연결 디버그
      </button>
      <button
        id="pe-layout-toggle"
        type="button"
        class="pe-btn"
        title={layoutReason ?? '레이아웃 오버레이(문단·표·도형·읽기 순서)'}
        aria-pressed={state.layoutEnabled}
        disabled={layoutReason !== null}
        onClick={() => controller.toggleLayout()}
      >
        레이아웃
      </button>
      {controller.edit && !state.disabled.edit && (
        <>
          <button
            id="pe-doc-undo"
            type="button"
            class="pe-btn"
            title="편집 되돌리기 (Ctrl+Z)"
            disabled={session !== null || state.edit.busy || state.edit.history?.canUndo !== true}
            onClick={() => void controller.edit?.undo()}
          >
            되돌리기
          </button>
          <button
            id="pe-doc-redo"
            type="button"
            class="pe-btn"
            title="다시 실행 (Ctrl+Shift+Z, Ctrl+Y)"
            disabled={session !== null || state.edit.busy || state.edit.history?.canRedo !== true}
            onClick={() => void controller.edit?.redo()}
          >
            다시 실행
          </button>
          {session && (
            <button
              id="pe-edit-cancel"
              type="button"
              class="pe-btn"
              data-pe-keep=""
              title="이 문단의 편집을 버리고 원래대로 되돌립니다"
              onClick={() => void controller.edit?.cancelActive()}
            >
              편집 취소
            </button>
          )}
          <button
            id="pe-fb-toggle"
            type="button"
            class="pe-btn"
            title="원본 글꼴에 없어 폴백 글꼴로 쓴 글자에 점선 밑줄 표시"
            aria-pressed={state.edit.fallbackUnderline}
            onClick={() => controller.edit?.setFallbackUnderline(!state.edit.fallbackUnderline)}
          >
            폴백 표시
          </button>
          <label
            class="pe-edit-opt"
            title={`태그된 PDF 쪽의 문단은 편집하지 않습니다. ${EDIT_PAGES_NOTICE}`}
          >
            <input
              id="pe-block-tagged"
              type="checkbox"
              checked={state.edit.blockTagged}
              onChange={(e) => controller.edit?.setBlockTagged(e.currentTarget.checked)}
            />{' '}
            태그 PDF 편집 막기
          </label>
        </>
      )}
      {state.edit.notice && (
        <span
          id="pe-edit-notice"
          class="pe-notice pe-edit-notice"
          role="status"
          title="클릭하면 닫습니다"
          onClick={() => controller.edit?.dismissNotice()}
        >
          {state.edit.notice} ✕
        </span>
      )}
      {disabledOwn.length > 0 && (
        <span
          id="pe-notice"
          class="pe-notice"
          title={disabledOwn.map((f) => `${FEATURE_LABELS[f]}: ${state.disabled[f]}`).join('\n')}
        >
          비활성: {disabledOwn.map((f) => FEATURE_LABELS[f]).join(', ')}
        </span>
      )}
      {state.find.open && <FindBar controller={controller} find={state.find} />}
    </div>
  );
}
