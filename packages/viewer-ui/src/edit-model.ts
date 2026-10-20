/**
 * 편집 모델(순수): 텍스트·모양 구간·캐럿·선택·IME 조합 구간과 편집 중 글자 단위 되돌리기(계약 5.9, 1.3 I6).
 *
 * - 상태(`EditorState`)는 불변 값이다. 연산 함수는 새 상태를 돌려준다.
 * - 새로 입력한 글자의 모양은 캐럿 앞 글자의 모양(문단 맨 앞이면 뒤 글자, 빈 텍스트면 `baseStyle`, 계약 D4).
 * - 입력·붙여넣기는 NFC 로 정규화하고, 이웃 자소와 합쳐지는 경우(NFD 자모 입력)는 영향 구간을 다시 정규화한다.
 * - 되돌리기 단위(I6): 연속 입력은 0.5초 정지·캐럿 이동·공백·문장부호 뒤에서 끊긴다. 조합 확정 한 번은 그 단위에 들어간다.
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

/** 캐럿이 줄 바꿈 경계(소프트 줄바꿈 위치)에 있을 때 어느 줄에 그릴지. */
export type Affinity = 'downstream' | 'upstream';

export interface EditorState {
  text: string;
  /** text 를 빈틈없이 덮는 모양 구간. text 가 비면 빈 배열. */
  spans: StyleSpan[];
  /** 빈 텍스트에 입력할 때·빈 TextRun 의 모양. */
  baseStyle: RunStyle;
  caret: number;
  anchor: number;
  affinity: Affinity;
  /** IME 조합 중인 [start, end). 조합 문자열은 text 안에 있다. */
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

/** 계획의 시작 텍스트·모양으로 편집 상태를 만든다. 캐럿 기본 위치는 텍스트 끝. */
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

/** 위치 index 글자의 모양. 범위 밖이면 null. */
export function styleAt(state: EditorState, index: number): RunStyle | null {
  for (const s of state.spans) if (index >= s.start && index < s.end) return s.style;
  return null;
}

/** pos 에 새 글자를 넣을 때의 모양: 앞 글자, 맨 앞이면 뒤 글자, 빈 텍스트면 baseStyle. */
export function insertionStyle(state: EditorState, pos: number): RunStyle {
  if (state.text.length === 0) return state.baseStyle;
  return styleAt(state, pos > 0 ? pos - 1 : 0) ?? state.baseStyle;
}

/** 모양 구간 → 편집 RPC 의 `TextRun[]`. 빈 텍스트도 모양을 유지하기 위해 빈 run 하나를 남긴다. */
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

/** [start, end) 를 insert 로 바꾼다(모양은 style). 새 텍스트와 구간을 돌려준다. */
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
 * [from, from+len) 를 새로 넣은 직후, 이웃 자소와 합쳐질 수 있는 영향 구간을 NFC 로 다시 정규화한다.
 * caret 은 삽입 끝(from+len)에 있다고 보고 정규화 뒤 같은 논리 위치로 옮긴다.
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

/** 선택(없으면 캐럿)을 raw 텍스트(정규화함)로 바꾼다. */
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

/** 캐럿 이동. extend 이면 anchor 를 유지해 선택을 넓힌다. 조합은 호출자가 먼저 확정한다. */
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

/** pos 가 놓인 단어를 선택한다(더블클릭). */
export function selectWordAt(state: EditorState, pos: number): EditorState {
  const [a, b] = wordRangeAt(state.text, pos);
  return setSelection(state, a, b);
}

// ── IME 조합 ──────────────────────────────────────────────────────────

/** 조합 시작(compositionstart). 선택이 있으면 IME 가 바꿀 것이므로 먼저 지운다. */
export function beginComposition(state: EditorState): EditorState {
  if (state.composition) return state;
  const base = hasSelection(state) ? deleteSelection(state) : state;
  return { ...base, composition: [base.caret, base.caret], anchor: base.caret };
}

/** 조합 문자열 갱신(compositionupdate·input). 조합 구간의 텍스트를 text 로 바꾸고 캐럿을 조합 끝에 둔다. */
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
 * 조합 확정(compositionend). finalText 가 주어지면 그 문자열로 확정한다. 확정 문자열은 NFC 로 정규화한다.
 * 조합 중이 아니면 상태를 바꾸지 않는다.
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

// ── 되돌리기 이력 ─────────────────────────────────────────────────────

/** 이력에 저장하는 상태(조합 없음). */
type Snapshot = Omit<EditorState, 'composition'>;

const snapshotOf = (s: EditorState): Snapshot => ({
  text: s.text,
  spans: s.spans,
  baseStyle: s.baseStyle,
  caret: s.caret,
  anchor: s.anchor,
  affinity: s.affinity,
});

/** 연속 입력이 한 단위로 묶이는 최대 정지 시간(ms, 계약 I6). */
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

  /** 캐럿 이동·클릭 등으로 현재 단위를 닫는다. */
  breakUnit(): void {
    this.open = null;
  }

  /** 변경 하나를 기록한다. before = 변경 직전 상태, endsUnit = 이 변경 뒤 단위를 닫음. */
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
  /** 시각(ms). 테스트에서 주입한다. */
  now?: () => number;
  /** 시작 캐럿 위치(기본 텍스트 끝). */
  caret?: number;
}

/** 편집 상태와 되돌리기 이력을 묶은 편집 모델. 연산은 텍스트가 바뀌었는지(boolean)를 돌려준다. */
export class EditorModel {
  state: EditorState;
  readonly history = new TextHistory();
  private readonly now: () => number;
  /** 조합을 시작하기 전 상태(되돌리기 단위의 "변경 전"). */
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

  /** 입력(beforeinput insertText). 조합 중이면 무시한다. */
  insertText(text: string): boolean {
    if (this.composing) return false;
    return this.apply(insertText(this.state, text), 'input', normalizeInput(text));
  }

  /** 붙여넣기: 항상 별도 단위. */
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

  /** 선택 삭제(잘라내기). 별도 단위. */
  deleteSelection(): boolean {
    if (this.composing) return false;
    return this.apply(deleteSelection(this.state), 'standalone', '');
  }

  /** 캐럿 이동·선택 변경(텍스트는 그대로). 조합 중이면 무시한다. */
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

  /** 조합 문자열 갱신. 이력에는 확정할 때 남긴다. */
  compositionUpdate(text: string): void {
    if (!this.composing) this.compositionOrigin = this.state;
    this.state = updateComposition(this.state, text);
  }

  /** 조합 확정. finalText 가 없으면 현재 조합 문자열로 확정한다. 확정 문자열이 있었는지 돌려준다. */
  compositionEnd(finalText?: string): boolean {
    if (!this.composing) return false;
    const origin = this.compositionOrigin ?? this.state;
    this.compositionOrigin = null;
    const [s] = this.state.composition!;
    const next = endComposition(this.state, finalText);
    const committed = next.text.slice(s, next.caret);
    if (committed.length > 0) {
      // 조합 시작 전 상태가 "변경 전" 이다. 조합 확정 한 번은 앞뒤 입력과 같은 단위로 묶일 수 있다.
      this.history.record(origin, next.caret, 'input', endsUndoUnit(committed), this.now());
    }
    this.state = next;
    return committed.length > 0;
  }

  // ── 되돌리기 ──

  /** 글자 단위 되돌리기. 조합 중이면 무시한다(계약 I5). */
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
