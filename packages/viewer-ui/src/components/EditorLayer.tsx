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
import { warningText } from '../edit-labels.js';
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

/** The same warning (kind + message) only once. */
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
 * Edit layer (contract 5.9, D7): region border and handles, caret/selection/composition underline (drawn from the reflow result), fallback and missing character markers,
 * overflow indicator (the region is widened automatically by reflow; only the overflow remaining after hitting the limit is shown + "되돌리기"), warning list, tagged-page notice,
 * hidden textarea for input.
 *
 * The caret and selection are drawn from the "last processed frame" (`session.shown`) so they do not diverge from the characters composited onto the canvas.
 */
export function EditorLayer({ controller, pageRef, layout, session, fallbackUnderline }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const { shown, editor, plan } = session;
  const t = controller.strings;
  const reflow = shown.reflow;
  const caret = caretBox(reflow, shown.text, shown.caret, shown.affinity);
  const sessionOf = (): EditSession | null => controller.edit?.currentSession() ?? null;

  // On start, focus the input textarea.
  // Clear the DOM selection of the text layer left from the double-click (if it remains, the selection changes during later IME composition and breaks the composition).
  useLayoutEffect(() => {
    document.getSelection()?.removeAllRanges();
    taRef.current?.focus({ preventScroll: true });
    // In an embedded context (`<embed>`, `<iframe>`) the frame itself may not have focus (same reason as the text layer, m1 integration measurement).
    if (!document.hasFocus()) window.focus();
  }, [session.draftId]);

  // If the model has ended composition but the IME is still composing (commit before save, etc.), end the IME composition with blur and focus again.
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

  // Input: keydown, beforeinput, composition*, clipboard. Registered directly regardless of Preact's event name rules.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const s = sessionOf();
      if (!s) return;
      if ((e.isComposing || e.keyCode === 229) && (e.ctrlKey || e.metaKey)) {
        // Shortcuts during composition (Ctrl+Z etc.) are ignored (I5). If not blocked, the browser breaks the composition with an edit command (historyUndo).
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
      // Undo/redo edit commands are blocked regardless of composition (the editor history is handled in keydown).
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        return;
      }
      if (e.isComposing) return; // input during composition is handled by composition events
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
          break; // paste/cut are handled by clipboard events, undo by keydown
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
      s.paste(e.clipboardData?.getData('text/plain') ?? ''); // text only
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

  // Outside click = commit (if composing, finalize the composition first, contract I8).
  useLayoutEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.('[data-pe-keep]')) return;
      taRef.current?.blur(); // if composing, compositionend arrives synchronously and the model finalizes
      void commitAndFinish(controller);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [controller]);

  const pagePoint = (e: MouseEvent) => {
    const rect = pageRef.current?.getBoundingClientRect();
    return cssToPage(e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0), layout);
  };

  /** Mouse down inside the region: caret/selection (double-click = word, triple-click = all). If composing, finalizes first and then moves (I4). */
  const onAreaDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const s = sessionOf();
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    if (s.isComposing) taRef.current?.blur(); // compositionend arrives synchronously and the model finalizes
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

  /** Region handle drag: clipped to areaLimit. */
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
  const areaBottomCss = pageToCss([area[0], area[3]], layout);
  const caretCss = caret ? pageToCss([caret.x, caret.top], layout) : null;
  const caretHeightCss = caret ? (caret.bottom - caret.top) * layout.cssScale : 0;

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
          title={t.glyphMissingTitle}
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
      {reflow.overflow && (
        // The region widens automatically to the text height (contract 5.4, 2026-10-20). What reaches here is only the overflow left over because of the region limit (page/Form boundary).
        // Committing as is (Esc, outside click) is applied with the overflow-clipped warning state (user decision).
        <div
          id="pe-edit-overflow"
          class="pe-edit-overflow"
          data-pe-keep=""
          style={{ left: `${areaBottomCss[0]}px`, top: `${areaBottomCss[1] + 6}px` }}
        >
          <span class="pe-edit-overflow-msg">{t.overflowMessage}</span>
          <button
            type="button"
            id="pe-edit-revert"
            class="pe-btn"
            title={t.revertTitle}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void controller.edit?.cancelActive()}
          >
            {t.revert}
          </button>
        </div>
      )}
      <div id="pe-edit-info" class="pe-edit-info" data-pe-keep="">
        {isTaggedPlan(plan) && (
          <div id="pe-edit-tagged-note" class="pe-edit-tagged">
            {t.taggedNotice}
          </div>
        )}
        {session.committing && (
          <div id="pe-edit-busy" class="pe-edit-notice-line" role="status">
            {t.committingNotice}
          </div>
        )}
        {session.error && (
          <div id="pe-edit-error" class="pe-edit-error" role="alert">
            {t.previewFailed(t.errorDetail(session.error))}
          </div>
        )}
        {session.notice && (
          <div id="pe-edit-session-notice" class="pe-edit-notice-line" role="status">
            {session.notice}
          </div>
        )}
        {warnings.length > 0 && (
          <ul id="pe-edit-warnings" class="pe-edit-warnings" aria-label={t.editWarningsLabel}>
            {warnings.map((w, i) => (
              <li key={i} data-kind={w.kind}>
                {warningText(w, t)}
              </li>
            ))}
          </ul>
        )}
        <div class="pe-edit-hint">{t.editPagesNotice}</div>
      </div>
      <textarea
        id="pe-edit-input"
        ref={taRef}
        class="pe-edit-input"
        aria-label={t.editorLabel}
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

/** After committing and finishing the edit, applies the environment change (window size) that was deferred. */
async function commitAndFinish(controller: ViewerController): Promise<void> {
  const ended = await controller.edit?.commitActive();
  if (ended) await controller.afterEditEnded();
}
