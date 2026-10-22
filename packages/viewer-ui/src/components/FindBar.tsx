import { useEffect, useRef } from 'preact/hooks';
import type { ViewerController } from '../controller.js';
import { findLabel, type FindState } from '../search-nav.js';

interface Props {
  controller: ViewerController;
  find: FindState;
}

/** Ctrl+F 검색창. Enter 다음, Shift+Enter 이전, Esc 닫기. */
export function FindBar({ controller, find }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const t = controller.strings;

  // 열릴 때와 Ctrl+F 를 다시 누를 때마다 입력란에 포커스하고 전체 선택한다.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [find.focusToken]);

  const hasHits = find.hits.length > 0;
  return (
    <div id="pe-find" class="pe-find" role="search">
      <input
        id="pe-find-input"
        ref={inputRef}
        class="pe-find-input"
        type="text"
        placeholder={t.findPlaceholder}
        aria-label={t.findPlaceholder}
        value={find.query}
        onInput={(e) => controller.setFindQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          // 한글 IME 조합 중 Enter 는 조합 확정이므로 검색 이동으로 쓰지 않는다.
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            controller.submitFind(e.shiftKey);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            controller.closeFind();
          }
        }}
      />
      <span id="pe-find-count" class="pe-find-count" aria-live="polite" data-status={find.status}>
        {findLabel(find, t)}
      </span>
      <button
        id="pe-find-prev"
        type="button"
        class="pe-btn"
        title={t.findPrevTitle}
        aria-label={t.findPrev}
        disabled={!hasHits}
        onClick={() => controller.stepFind(-1)}
      >
        ↑
      </button>
      <button
        id="pe-find-next"
        type="button"
        class="pe-btn"
        title={t.findNextTitle}
        aria-label={t.findNext}
        disabled={!hasHits}
        onClick={() => controller.stepFind(1)}
      >
        ↓
      </button>
      <label class="pe-find-case" title={t.matchCase}>
        <input
          id="pe-find-case"
          type="checkbox"
          aria-label={t.matchCase}
          checked={find.caseSensitive}
          onChange={(e) => controller.setCaseSensitive(e.currentTarget.checked)}
        />
        Aa
      </label>
      <button
        id="pe-find-close"
        type="button"
        class="pe-btn"
        title={t.findCloseTitle}
        aria-label={t.findClose}
        onClick={() => controller.closeFind()}
      >
        ✕
      </button>
    </div>
  );
}
