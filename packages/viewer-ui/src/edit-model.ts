/**
 * Edit model (pure): text, style ranges, caret, selection, IME composition range, and per-character undo during editing (contract 5.9, 1.3 I6).
 *
 * - The state (`EditorState`) is an immutable value. Operation functions return a new state.
 * - The style of newly typed characters is that of the character before the caret (the following character at the paragraph start, `baseStyle` for empty text, contract D4).
 * - Input and paste are normalized to NFC, and where they merge with neighboring graphemes (NFD jamo input), the affected range is normalized again.
 * - Undo unit (I6): continuous input is split after a 0.5 s pause, caret move, whitespace, or sentence punctuation. One composition commit goes into that unit.
 */
import type { RunStyle, TextRun } from '@pdf-editor/shared-types';
import {
  ceilBoundary,
  endsUndoUnit,
  nextBoundary,
  nextWordStart,
  normalizeInput,
  prevBoundary,
  prevWordStart,
  snapBoundary,
  wordRangeAt,
} from './edit-text.js';

export interface StyleSpan {
  start: number;
  end: number;
  style: RunStyle;
}

/** Which line to draw the caret on when it is at a line-break boundary (soft line-break position). */
export type Affinity = 'downstream' | 'upstream';

export interface EditorState {
  text: string;
  /** Style ranges that cover text without gaps. An empty array if text is empty. */
  spans: StyleSpan[];
  /** Style of typing into empty text, and of an empty TextRun. */
  baseStyle: RunStyle;
  caret: number;
  anchor: number;
  affinity: Affinity;
  /** [start, end) under IME composition. The composition string is inside text. */
  composition: [number, number] | null;
}

const sameStyle = (a: RunStyle, b: RunStyle): boolean =>
  a.sourceChar === b.sourceChar &&
  a.fontId === b.fontId &&
  a.size === b.size &&
  a.bold === b.bold &&
  a.italic === b.italic;

function mergeSpans(spans: StyleSpan[]): StyleSpan[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: StyleSpan[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && last.end === s.start && sameStyle(last.style, s.style)) {
      out[out.length - 1] = { start: last.start, end: s.end, style: last.style };
    } else out.push(s);
  }
  return out;
}

/** Builds the edit state from the plan's start text and styles. The default caret position is the end of the text. */
export function createEditorState(runs: TextRun[], caret?: number): EditorState {
  const first = runs[0];
  if (!first) throw new Error('편집 시작 runs 가 비어 있습니다');
  let text = '';
  const spans: StyleSpan[] = [];
  for (const run of runs) {
    spans.push({ start: text.length, end: text.length + run.text.length, style: run.style });
    text += run.text;
  }
  const pos = snapBoundary(text, Math.max(0, Math.min(caret ?? text.length, text.length)));
  return {
    text,
    spans: mergeSpans(spans),
    baseStyle: first.style,
    caret: pos,
    anchor: pos,
    affinity: 'downstream',
    composition: null,
  };
}

/** Style of the character at position index. null if out of range. */
export function styleAt(state: EditorState, index: number): RunStyle | null {
  for (const s of state.spans) if (index >= s.start && index < s.end) return s.style;
  return null;
}

/** Style when inserting a new character at pos: the previous character, the following one at the very start, baseStyle for empty text. */
export function insertionStyle(state: EditorState, pos: number): RunStyle {
  if (state.text.length === 0) return state.baseStyle;
  return styleAt(state, pos > 0 ? pos - 1 : 0) ?? state.baseStyle;
}

/** Style ranges → the `TextRun[]` of the edit RPC. Empty text also keeps one empty run to preserve the style. */
export function toRuns(state: EditorState): TextRun[] {
  if (state.text.length === 0) return [{ text: '', style: state.baseStyle }];
  return state.spans.map((s) => ({ text: state.text.slice(s.start, s.end), style: s.style }));
}

export function selectionRange(state: EditorState): [number, number] {
  return [Math.min(state.anchor, state.caret), Math.max(state.anchor, state.caret)];
}

export function hasSelection(state: EditorState): boolean {
  return state.anchor !== state.caret;
}

export function selectedText(state: EditorState): string {
  const [a, b] = selectionRange(state);
  return state.text.slice(a, b);
}

export function compositionText(state: EditorState): string {
  return state.composition ? state.text.slice(state.composition[0], state.composition[1]) : '';
}

/** Replaces [start, end) with insert (style is style). Returns the new text and ranges. */
function replaceRange(
  state: EditorState,
  start: number,
  end: number,
  insert: string,
  style: RunStyle,
): Pick<EditorState, 'text' | 'spans' | 'baseStyle'> {
  const text = state.text.slice(0, start) + insert + state.text.slice(end);
  const delta = insert.length - (end - start);
  const out: StyleSpan[] = [];
  for (const s of state.spans) {
    if (s.start < start) out.push({ start: s.start, end: Math.min(s.end, start), style: s.style });
    if (s.end > end) {
      out.push({ start: Math.max(s.start, end) + delta, end: s.end + delta, style: s.style });
    }
  }
  if (insert.length > 0) out.push({ start, end: start + insert.length, style });
  return {
    text,
    spans: text.length === 0 ? [] : mergeSpans(out),
    baseStyle: text.length === 0 ? style : state.baseStyle,
  };
}

function withCaret(state: EditorState, pos: number): EditorState {
  return { ...state, caret: pos, anchor: pos, affinity: 'downstream', composition: null };
}

/**
 * Right after [from, from+len) is newly inserted, renormalizes to NFC the affected range that may merge with neighboring graphemes.
 * The caret is taken to be at the insertion end (from+len) and is moved to the same logical position after normalization.
 */
function fixupNfc(state: EditorState, from: number, len: number): EditorState {
  const end = from + len;
  const region0 = snapBoundary(state.text, from);
  const region1 = ceilBoundary(state.text, end);
  const region = state.text.slice(region0, region1);
  const nfc = region.normalize('NFC');
  if (nfc === region) return state;
  const prefix = state.text.slice(region0, end).normalize('NFC').length;
  const style = styleAt(state, region0) ?? state.baseStyle;
  const next = replaceRange(state, region0, region1, nfc, style);
  const pos = Math.min(region0 + prefix, next.text.length);
  return { ...state, ...next, caret: pos, anchor: pos };
}

/** Replaces the selection (the caret if none) with raw text (normalized). */
export function insertText(state: EditorState, raw: string): EditorState {
  const text = normalizeInput(raw);
  if (text === '') return hasSelection(state) ? deleteSelection(state) : state;
  const [a, b] = selectionRange(state);
  const style = insertionStyle(state, a);
  const next = replaceRange(state, a, b, text, style);
  const moved: EditorState = { ...state, ...next, caret: a + text.length, anchor: a + text.length };
  const fixed = fixupNfc(moved, a, text.length);
  return withCaret(fixed, fixed.caret);
}

export function deleteSelection(state: EditorState): EditorState {
  if (!hasSelection(state)) return state;
  const [a, b] = selectionRange(state);
  const style = styleAt(state, a) ?? state.baseStyle;
  return withCaret({ ...state, ...replaceRange(state, a, b, '', style) }, a);
}

export function deleteBackward(state: EditorState, byWord = false): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  if (state.caret === 0) return state;
  const from = byWord
    ? prevWordStart(state.text, state.caret)
    : prevBoundary(state.text, state.caret);
  const style = styleAt(state, from) ?? state.baseStyle;
  return withCaret({ ...state, ...replaceRange(state, from, state.caret, '', style) }, from);
}

export function deleteForward(state: EditorState, byWord = false): EditorState {
  if (hasSelection(state)) return deleteSelection(state);
  if (state.caret >= state.text.length) return state;
  const to = byWord
    ? nextWordStart(state.text, state.caret)
    : nextBoundary(state.text, state.caret);
  const style = styleAt(state, state.caret) ?? state.baseStyle;
  return withCaret({ ...state, ...replaceRange(state, state.caret, to, '', style) }, state.caret);
}

/** Caret move. With extend, keeps the anchor and widens the selection. The caller finalizes any composition first. */
export function moveTo(
  state: EditorState,
  pos: number,
  extend = false,
  affinity: Affinity = 'downstream',
): EditorState {
  const p = snapBoundary(state.text, Math.max(0, Math.min(pos, state.text.length)));
  return { ...state, caret: p, anchor: extend ? state.anchor : p, affinity };
}

export function setSelection(
  state: EditorState,
  anchor: number,
  caret: number,
  affinity: Affinity = 'downstream',
): EditorState {
  const a = snapBoundary(state.text, Math.max(0, Math.min(anchor, state.text.length)));
  const c = snapBoundary(state.text, Math.max(0, Math.min(caret, state.text.length)));
  return { ...state, anchor: a, caret: c, affinity };
}

export function selectAll(state: EditorState): EditorState {
  return { ...state, anchor: 0, caret: state.text.length, affinity: 'downstream' };
}

/** Selects the word containing pos (double-click). */
export function selectWordAt(state: EditorState, pos: number): EditorState {
  const [a, b] = wordRangeAt(state.text, pos);
  return setSelection(state, a, b);
}

// ── IME composition ───────────────────────────────────────────────────

/** Composition start (compositionstart). If there is a selection, the IME will replace it, so it is deleted first. */
export function beginComposition(state: EditorState): EditorState {
  if (state.composition) return state;
  const base = hasSelection(state) ? deleteSelection(state) : state;
  return { ...base, composition: [base.caret, base.caret], anchor: base.caret };
}

/** Composition string update (compositionupdate, input). Replaces the text of the composition range with text and puts the caret at the composition end. */
export function updateComposition(state: EditorState, text: string): EditorState {
  const base = state.composition ? state : beginComposition(state);
  const [s, e] = base.composition!;
  const style = insertionStyle(base, s);
  const next = replaceRange(base, s, e, text, style);
  const end = s + text.length;
  return {
    ...base,
    ...next,
    composition: [s, end],
    caret: end,
    anchor: end,
    affinity: 'downstream',
  };
}

/**
 * Composition end (compositionend). If finalText is given, finalizes with that string. The finalized string is normalized to NFC.
 * Does not change the state if not composing.
 */
export function endComposition(state: EditorState, finalText?: string): EditorState {
  if (!state.composition) return state;
  let cur = finalText === undefined ? state : updateComposition(state, finalText);
  const [s, e] = cur.composition!;
  const committed = normalizeInput(cur.text.slice(s, e));
  const style = insertionStyle(cur, s);
  const next = replaceRange(cur, s, e, committed, style);
  cur = {
    ...cur,
    ...next,
    composition: null,
    caret: s + committed.length,
    anchor: s + committed.length,
  };
  return committed.length > 0 ? fixupNfc(cur, s, committed.length) : cur;
}

// ── Undo history ──────────────────────────────────────────────────────

/** State stored in the history (no composition). */
type Snapshot = Omit<EditorState, 'composition'>;

const snapshotOf = (s: EditorState): Snapshot => ({
  text: s.text,
  spans: s.spans,
  baseStyle: s.baseStyle,
  caret: s.caret,
  anchor: s.anchor,
  affinity: s.affinity,
});

/** Maximum pause during which continuous input is grouped into one unit (ms, contract I6). */
export const UNDO_PAUSE_MS = 500;

export type UnitKind = 'input' | 'delete-back' | 'delete-forward' | 'standalone';

interface OpenUnit {
  kind: UnitKind;
  last: number;
  caret: number;
  closed: boolean;
}

export class TextHistory {
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private open: OpenUnit | null = null;

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Closes the current unit by caret move, click, etc. */
  breakUnit(): void {
    this.open = null;
  }

  /** Records one change. before = the state just before the change, endsUnit = closes the unit after this change. */
  record(
    before: EditorState,
    afterCaret: number,
    kind: UnitKind,
    endsUnit: boolean,
    t: number,
  ): void {
    const open = this.open;
    const mergeable =
      open !== null &&
      kind !== 'standalone' &&
      open.kind === kind &&
      !open.closed &&
      t - open.last <= UNDO_PAUSE_MS &&
      before.caret === open.caret;
    if (!mergeable) {
      this.undoStack.push(snapshotOf(before));
      this.redoStack = [];
    }
    this.open = { kind, last: t, caret: afterCaret, closed: endsUnit };
  }

  undo(current: EditorState): Snapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(snapshotOf(current));
    this.open = null;
    return prev;
  }

  redo(current: EditorState): Snapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(snapshotOf(current));
    this.open = null;
    return next;
  }
}

export interface EditorModelOptions {
  /** Time (ms). Injected in tests. */
  now?: () => number;
  /** Start caret position (default: end of text). */
  caret?: number;
}

/** Edit model combining the edit state and the undo history. An operation returns whether the text changed (boolean). */
export class EditorModel {
  state: EditorState;
  readonly history = new TextHistory();
  private readonly now: () => number;
  /** State before composition started (the "before change" of the undo unit). */
  private compositionOrigin: EditorState | null = null;

  constructor(runs: TextRun[], options: EditorModelOptions = {}) {
    this.state = createEditorState(runs, options.caret);
    this.now = options.now ?? (() => Date.now());
  }

  private get composing(): boolean {
    return this.state.composition !== null;
  }

  private apply(next: EditorState, kind: UnitKind, inserted: string): boolean {
    const before = this.state;
    const changed = next.text !== before.text || next.spans !== before.spans;
    if (changed) {
      this.history.record(before, next.caret, kind, endsUndoUnit(inserted), this.now());
    } else if (next.caret !== before.caret || next.anchor !== before.anchor) {
      this.history.breakUnit();
    }
    this.state = next;
    return changed;
  }

  /** Input (beforeinput insertText). Ignored while composing. */
  insertText(text: string): boolean {
    if (this.composing) return false;
    return this.apply(insertText(this.state, text), 'input', normalizeInput(text));
  }

  /** Paste: always a separate unit. */
  paste(text: string): boolean {
    if (this.composing) return false;
    return this.apply(insertText(this.state, text), 'standalone', '');
  }

  deleteBackward(byWord = false): boolean {
    if (this.composing) return false;
    return this.apply(deleteBackward(this.state, byWord), 'delete-back', '');
  }

  deleteForward(byWord = false): boolean {
    if (this.composing) return false;
    return this.apply(deleteForward(this.state, byWord), 'delete-forward', '');
  }

  /** Delete selection (cut). A separate unit. */
  deleteSelection(): boolean {
    if (this.composing) return false;
    return this.apply(deleteSelection(this.state), 'standalone', '');
  }

  /** Caret move / selection change (text unchanged). Ignored while composing. */
  moveTo(pos: number, extend = false, affinity: Affinity = 'downstream'): void {
    if (this.composing) return;
    this.apply(moveTo(this.state, pos, extend, affinity), 'standalone', '');
  }

  setSelection(anchor: number, caret: number, affinity: Affinity = 'downstream'): void {
    if (this.composing) return;
    this.apply(setSelection(this.state, anchor, caret, affinity), 'standalone', '');
  }

  selectAll(): void {
    if (this.composing) return;
    this.apply(selectAll(this.state), 'standalone', '');
  }

  selectWordAt(pos: number): void {
    if (this.composing) return;
    this.apply(selectWordAt(this.state, pos), 'standalone', '');
  }

  // ── IME ──

  compositionStart(): void {
    if (this.composing) return;
    this.compositionOrigin = this.state;
    this.state = beginComposition(this.state);
  }

  /** Composition string update. Recorded in the history when finalized. */
  compositionUpdate(text: string): void {
    if (!this.composing) this.compositionOrigin = this.state;
    this.state = updateComposition(this.state, text);
  }

  /** Composition end. If there is no finalText, finalizes with the current composition string. Returns whether there was a finalized string. */
  compositionEnd(finalText?: string): boolean {
    if (!this.composing) return false;
    const origin = this.compositionOrigin ?? this.state;
    this.compositionOrigin = null;
    const [s] = this.state.composition!;
    const next = endComposition(this.state, finalText);
    const committed = next.text.slice(s, next.caret);
    if (committed.length > 0) {
      // The state before composition started is the "before change". One composition commit may be grouped into the same unit as the input before and after it.
      this.history.record(origin, next.caret, 'input', endsUndoUnit(committed), this.now());
    }
    this.state = next;
    return committed.length > 0;
  }

  // ── Undo ──

  /** Per-character undo. Ignored while composing (contract I5). */
  undo(): boolean {
    if (this.composing) return false;
    const prev = this.history.undo(this.state);
    if (!prev) return false;
    this.state = { ...prev, composition: null };
    return true;
  }

  redo(): boolean {
    if (this.composing) return false;
    const next = this.history.redo(this.state);
    if (!next) return false;
    this.state = { ...next, composition: null };
    return true;
  }

  breakUnit(): void {
    this.history.breakUnit();
  }
}
