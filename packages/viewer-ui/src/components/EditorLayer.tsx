import { useLayoutEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { EditWarning, Rect } from '@pdf-editor/shared-types';
import type { ViewerController } from '../controller.js';
import { isTaggedPlan } from '../edit-controller.js';
import {
  caretBox,
  compositionUnderlines,
  fallbackSegments,
  missingMarks,
  rangeRects,
  resizeArea,
  type HandleName,
} from '../edit-geometry.js';
import { EDIT_PAGES_NOTICE, TAGGED_NOTICE } from '../edit-labels.js';
import { mapEditKey } from '../edit-keys.js';
import type { EditSession, EditSessionView } from '../edit-session.js';
import { cssToPage, pageToCss, type PageLayout } from '../layout.js';
import { cssRect } from './EditEntry.js';

interface Props {
  controller: ViewerController;
  pageRef: RefObject<HTMLDivElement>;
  layout: PageLayout;
  session: EditSessionView;
  fallbackUnderline: boolean;
}

const HANDLES: [HandleName, number, number][] = [
  ['nw', 0, 0],
  ['n', 0.5, 0],
  ['ne', 1, 0],
  ['e', 1, 0.5],
  ['se', 1, 1],
  ['s', 0.5, 1],
  ['sw', 0, 1],
  ['w', 0, 0.5],
];

const HANDLE_SIZE = 8;

const CHOICES: { id: 'expand' | 'shrink' | 'keep'; label: string; title: string }[] = [
  {
    id: 'expand',
    label: '영역 넓히기',
    title: '글자가 들어가도록 영역 아래 변을 내립니다(상한까지)',
  },
  { id: 'shrink', label: '글자 줄이기', title: '글자 크기를 줄여 영역에 맞춥니다(최소 80%)' },
  { id: 'keep', label: '그대로 두기', title: '넘친 줄을 그대로 둡니다(영역 밖은 잘릴 수 있음)' },
];

/** 같은 경고(종류+메시지)는 한 번만. */
function mergeWarnings(...lists: EditWarning[][]): EditWarning[] {
  const seen = new Set<string>();
  const out: EditWarning[] = [];
  for (const w of lists.flat()) {
    const key = `${w.kind}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * 편집 층(계약 5.9, D7): 영역 테두리·핸들, 캐럿·선택·조합 밑줄(리플로우 결과로 그림), 폴백·없는 글자 표시,
 * 초과 UI(3선택), 경고 목록, 태그 쪽 안내, 입력용 숨은 textarea.
 *
 * 캐럿·선택은 "마지막으로 처리된 프레임"(`session.shown`)으로 그려 캔버스에 합성된 글자와 어긋나지 않는다.
 */
export function EditorLayer({ controller, pageRef, layout, session, fallbackUnderline }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const { shown, editor, format, plan } = session;
  const reflow = shown.reflow;
  const caret = caretBox(reflow, shown.text, shown.caret, shown.affinity);
  const sessionOf = (): EditSession | null => controller.edit?.currentSession() ?? null;

  // 시작할 때 입력용 textarea 에 포커스를 준다.
  // 더블클릭으로 선택됐던 텍스트 층의 DOM 선택은 지운다(남아 있으면 이후 IME 조합 중 선택이 바뀌어 조합이 끊긴다).
  useLayoutEffect(() => {
    document.getSelection()?.removeAllRanges();
    taRef.current?.focus({ preventScroll: true });
    // 임베디드 문맥(`<embed>`·`<iframe>`)에서는 프레임 자체에 포커스가 없을 수 있다(텍스트 층과 같은 이유, m1 통합 실측).
    if (!document.hasFocus()) window.focus();
  }, [session.draftId]);

  // 모델이 조합을 끝냈는데 IME 는 아직 조합 중이면(저장 전 커밋 등) blur 로 IME 조합을 끝내고 다시 포커스한다.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || editor.composition) return;
    if (composingRef.current) {
      ta.blur();
      composingRef.current = false;
    }
    if (ta.value !== '') ta.value = '';
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
  }, [editor.composition]);

  // 입력: keydown·beforeinput·composition*·클립보드. Preact 의 이벤트 이름 규칙과 무관하게 직접 등록한다.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const s = sessionOf();
      if (!s) return;
      if ((e.isComposing || e.keyCode === 229) && (e.ctrlKey || e.metaKey)) {
        // 조합 중 단축키(Ctrl+Z 등)는 무시한다(I5). 막지 않으면 브라우저가 편집 명령(historyUndo)으로 조합을 깨뜨린다.
        e.preventDefault();
        return;
      }
      const action = mapEditKey(e);
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action.type) {
        case 'move-h':
          s.moveHorizontal(action.dir, action.shift, action.word);
          break;
        case 'move-v':
          s.moveVerticalKey(action.dir, action.shift);
          break;
        case 'line':
          s.moveLineBoundary(action.which, action.shift, action.whole);
          break;
        case 'backspace':
          s.backspace(action.word);
          break;
        case 'delete':
          s.deleteKey(action.word);
          break;
        case 'enter':
          s.typeText('\n');
          break;
        case 'select-all':
          s.selectAll();
          break;
        case 'undo':
          s.undo();
          break;
        case 'redo':
          s.redo();
          break;
        case 'commit':
          void commitAndFinish(controller);
          break;
      }
    };
    const onBeforeInput = (e: InputEvent) => {
      const s = sessionOf();
      if (!s) return;
      // 되돌리기·다시 실행 편집 명령은 조합 여부와 무관하게 막는다(편집기 이력은 keydown 에서 처리한다).
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        return;
      }
      if (e.isComposing) return; // 조합 중 입력은 composition 이벤트로 처리한다
      e.preventDefault();
      switch (e.inputType) {
        case 'insertText':
        case 'insertReplacementText':
          s.typeText(e.data ?? e.dataTransfer?.getData('text/plain') ?? '');
          break;
        case 'insertLineBreak':
        case 'insertParagraph':
          s.typeText('\n');
          break;
        case 'deleteContentBackward':
          s.backspace();
          break;
        case 'deleteContentForward':
          s.deleteKey();
          break;
        case 'deleteWordBackward':
          s.backspace(true);
          break;
        case 'deleteWordForward':
          s.deleteKey(true);
          break;
        default:
          break; // 붙여넣기·자르기는 클립보드 이벤트, 되돌리기는 keydown 에서 처리한다
      }
    };
    const onCompositionStart = () => {
      composingRef.current = true;
      sessionOf()?.compositionStart();
    };
    const onCompositionUpdate = (e: CompositionEvent) => {
      composingRef.current = true;
      sessionOf()?.compositionUpdate(e.data ?? ta.value);
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      composingRef.current = false;
      sessionOf()?.compositionEnd(e.data !== '' && e.data != null ? e.data : ta.value);
      ta.value = '';
    };
    const onCopy = (e: ClipboardEvent) => {
      const s = sessionOf();
      if (!s) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', s.copyText());
    };
    const onCut = (e: ClipboardEvent) => {
      const s = sessionOf();
      if (!s) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', s.cut());
    };
    const onPaste = (e: ClipboardEvent) => {
      const s = sessionOf();
      if (!s) return;
      e.preventDefault();
      s.paste(e.clipboardData?.getData('text/plain') ?? ''); // 텍스트만
    };
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('beforeinput', onBeforeInput);
    ta.addEventListener('compositionstart', onCompositionStart);
    ta.addEventListener('compositionupdate', onCompositionUpdate);
    ta.addEventListener('compositionend', onCompositionEnd);
    ta.addEventListener('copy', onCopy);
    ta.addEventListener('cut', onCut);
    ta.addEventListener('paste', onPaste);
    return () => {
      ta.removeEventListener('keydown', onKeyDown);
      ta.removeEventListener('beforeinput', onBeforeInput);
      ta.removeEventListener('compositionstart', onCompositionStart);
      ta.removeEventListener('compositionupdate', onCompositionUpdate);
      ta.removeEventListener('compositionend', onCompositionEnd);
      ta.removeEventListener('copy', onCopy);
      ta.removeEventListener('cut', onCut);
      ta.removeEventListener('paste', onPaste);
    };
  }, [controller]);

  // 바깥 클릭 = 커밋(조합 중이면 조합을 확정한 뒤, 계약 I8).
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('[data-pe-keep]')) return;
      taRef.current?.blur(); // 조합 중이면 compositionend 가 동기로 오고 모델이 확정한다
      void commitAndFinish(controller);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [controller]);

  const pagePoint = (e: MouseEvent) => {
    const rect = pageRef.current?.getBoundingClientRect();
    return cssToPage(e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0), layout);
  };

  /** 영역 안 마우스 누름: 캐럿·선택(더블클릭 = 단어, 트리플클릭 = 전체). 조합 중이면 확정한 뒤 이동한다(I4). */
  const onAreaDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const s = sessionOf();
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    if (s.isComposing) taRef.current?.blur(); // compositionend 가 동기로 와서 모델이 확정한다
    s.pointerDown(pagePoint(e), e.detail, e.shiftKey);
    taRef.current?.focus({ preventScroll: true });
    const onMove = (m: MouseEvent) => s.pointerDrag(pagePoint(m));
    const onUp = () => {
      s.pointerUp();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  /** 영역 핸들 드래그: areaLimit 안으로 자른다. */
  const onHandleDown = (handle: HandleName) => (e: MouseEvent) => {
    if (e.button !== 0) return;
    const s = sessionOf();
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    const start = pagePoint(e);
    const base: Rect = [...reflow.area];
    const limit = plan.areaLimit;
    const onMove = (m: MouseEvent) => {
      const p = pagePoint(m);
      s.setFormat({ area: resizeArea(base, handle, p[0] - start[0], p[1] - start[1], limit) });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      taRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const area = reflow.area;
  const hitBox: Rect = [
    Math.min(area[0], reflow.contentBox[0]),
    Math.min(area[1], reflow.contentBox[1]),
    Math.max(area[2], reflow.contentBox[2]),
    Math.max(area[3], reflow.contentBox[3]),
  ];
  const selection = shown.composition
    ? []
    : rangeRects(reflow, shown.text, shown.anchor, shown.caret);
  const underlines = shown.composition
    ? compositionUnderlines(reflow, shown.text, shown.composition)
    : [];
  const fallback = fallbackUnderline ? fallbackSegments(reflow) : [];
  const missing = missingMarks(reflow);
  const warnings = mergeWarnings(plan.warnings, session.warnings);
  const choice = format.overflow;
  const showOverflowPanel = reflow.overflow || choice !== null;
  const areaBottomCss = pageToCss([area[0], area[3]], layout);
  const caretCss = caret ? pageToCss([caret.x, caret.top], layout) : null;
  const caretHeightCss = caret ? (caret.bottom - caret.top) * layout.cssScale : 0;
  const chip =
    choice === 'shrink' && reflow.fontScale < 1
      ? `글자 ${Math.round(reflow.fontScale * 100)}%`
      : choice === 'expand' && reflow.area[3] > format.area[3] + 0.01
        ? '영역 넓힘'
        : null;

  return (
    <div
      id="pe-edit-layer"
      class="pe-edit-layer"
      data-draft-id={session.draftId}
      data-updating={session.updating ? '1' : '0'}
      data-committing={session.committing ? '1' : '0'}
      aria-busy={session.committing ? 'true' : 'false'}
      data-composing={editor.composition ? '1' : '0'}
    >
      <div
        id="pe-edit-hit"
        class="pe-edit-hit"
        data-pe-keep=""
        style={cssRect(hitBox, layout)}
        onMouseDown={onAreaDown}
      />
      <div
        id="pe-edit-area"
        class="pe-edit-area"
        data-area={area.map((n) => Math.round(n * 100) / 100).join(',')}
        data-overflow={reflow.overflow ? '1' : '0'}
        style={cssRect(area, layout)}
      />
      {selection.map((r, i) => (
        <div key={`s${i}`} class="pe-edit-sel" style={cssRect(r, layout)} />
      ))}
      {fallback.map((r, i) => (
        <div key={`f${i}`} class="pe-edit-fb" style={cssRect(r, layout)} />
      ))}
      {missing.map((m, i) => (
        <div
          key={`m${i}`}
          class="pe-edit-missing"
          title="원본·폴백 글꼴 모두 이 글자의 글리프가 없어 쓰지 않습니다"
          data-offset={m.offset}
          style={cssRect([m.x - 1, m.top, m.x + 1, m.bottom], layout)}
        />
      ))}
      {underlines.map((r, i) => (
        <div key={`c${i}`} class="pe-edit-comp" style={cssRect(r, layout)} />
      ))}
      {warnings.flatMap((w, wi) =>
        w.rects.map((r, ri) => (
          <div
            key={`w${wi}-${ri}`}
            class="pe-edit-warn-rect"
            data-kind={w.kind}
            style={cssRect(r, layout)}
          />
        )),
      )}
      {reflow.overflow && (
        <div
          id="pe-edit-overflow-line"
          class="pe-edit-overflow-line"
          style={{
            left: `${areaBottomCss[0]}px`,
            top: `${areaBottomCss[1]}px`,
            width: `${(area[2] - area[0]) * layout.cssScale}px`,
          }}
        />
      )}
      {caret && caretCss && (
        <div
          id="pe-edit-caret"
          class="pe-edit-caret"
          data-offset={shown.caret}
          data-x={Math.round(caret.x * 100) / 100}
          data-top={Math.round(caret.top * 100) / 100}
          data-line={caret.line}
          style={{
            left: `${caretCss[0]}px`,
            top: `${caretCss[1]}px`,
            height: `${caretHeightCss}px`,
          }}
        />
      )}
      {HANDLES.map(([name, fx, fy]) => {
        const p = pageToCss(
          [area[0] + fx * (area[2] - area[0]), area[1] + fy * (area[3] - area[1])],
          layout,
        );
        return (
          <div
            key={name}
            class="pe-edit-handle"
            data-handle={name}
            data-pe-keep=""
            style={{ left: `${p[0] - HANDLE_SIZE / 2}px`, top: `${p[1] - HANDLE_SIZE / 2}px` }}
            onMouseDown={onHandleDown(name)}
          />
        );
      })}
      {showOverflowPanel && (
        <div
          id="pe-edit-overflow"
          class="pe-edit-overflow"
          data-pe-keep=""
          data-choice={choice ?? ''}
          style={{ left: `${areaBottomCss[0]}px`, top: `${areaBottomCss[1] + 6}px` }}
        >
          {reflow.overflow && <span class="pe-edit-overflow-msg">영역을 넘었습니다</span>}
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              class="pe-btn"
              data-choice={c.id}
              title={c.title}
              aria-pressed={choice === c.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                sessionOf()?.setFormat({ overflow: choice === c.id ? null : c.id });
                taRef.current?.focus({ preventScroll: true });
              }}
            >
              {c.label}
            </button>
          ))}
          {chip && <span class="pe-edit-chip">{chip}</span>}
        </div>
      )}
      <div id="pe-edit-info" class="pe-edit-info" data-pe-keep="">
        {isTaggedPlan(plan) && (
          <div id="pe-edit-tagged-note" class="pe-edit-tagged">
            {TAGGED_NOTICE}
          </div>
        )}
        {session.committing && (
          <div id="pe-edit-busy" class="pe-edit-notice-line" role="status">
            편집을 반영하는 중입니다. 끝날 때까지 입력은 받지 않습니다.
          </div>
        )}
        {session.error && (
          <div id="pe-edit-error" class="pe-edit-error" role="alert">
            미리보기 갱신 실패: {session.error}
          </div>
        )}
        {session.notice && (
          <div id="pe-edit-session-notice" class="pe-edit-notice-line" role="status">
            {session.notice}
          </div>
        )}
        {warnings.length > 0 && (
          <ul id="pe-edit-warnings" class="pe-edit-warnings" aria-label="편집 경고">
            {warnings.map((w, i) => (
              <li key={i} data-kind={w.kind}>
                {w.message}
              </li>
            ))}
          </ul>
        )}
        <div class="pe-edit-hint">{EDIT_PAGES_NOTICE}</div>
      </div>
      <textarea
        id="pe-edit-input"
        ref={taRef}
        class="pe-edit-input"
        aria-label="문단 편집"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        rows={1}
        style={{
          left: `${caretCss ? caretCss[0] : 0}px`,
          top: `${caretCss ? caretCss[1] : 0}px`,
          height: `${Math.max(caretHeightCss, 8)}px`,
          fontSize: `${Math.max(caretHeightCss * 0.8, 8)}px`,
        }}
      />
    </div>
  );
}

/** 커밋하고 편집을 마친 뒤 보류했던 환경 변화(창 크기)를 반영한다. */
async function commitAndFinish(controller: ViewerController): Promise<void> {
  const ended = await controller.edit?.commitActive();
  if (ended) await controller.afterEditEnded();
}
