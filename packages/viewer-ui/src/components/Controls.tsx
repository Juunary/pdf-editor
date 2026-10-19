import { useEffect, useRef, useState } from 'preact/hooks';
import { featureDisabledReason, type FeatureName, type ViewerController } from '../controller.js';
import { useViewerState } from '../hooks.js';
import { canStep } from '../page-nav.js';
import { isFindShortcut } from '../shortcuts.js';
import { FindBar } from './FindBar.js';

const FEATURE_LABELS: Record<FeatureName, string> = {
  text: '텍스트 선택',
  search: '검색',
  debug: '연결 디버그',
  layout: '레이아웃',
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

  // Ctrl+F 가로채기. 검색이 비활성화되면 브라우저 기본 찾기에 맡긴다.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isFindShortcut(e) && controller.shouldInterceptFind()) {
        e.preventDefault();
        controller.openFind();
      }
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
