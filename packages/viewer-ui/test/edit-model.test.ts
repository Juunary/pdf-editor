import { describe, expect, it } from 'vitest';
import type { RunStyle, TextRun } from '@pdf-editor/shared-types';
import {
  EditorModel,
  UNDO_PAUSE_MS,
  compositionText,
  createEditorState,
  insertText,
  selectedText,
  styleAt,
  toRuns,
} from '../src/edit-model.js';

const style = (sourceChar: number, extra: Partial<RunStyle> = {}): RunStyle => ({
  sourceChar,
  fontId: 0,
  size: 12,
  bold: false,
  italic: false,
  color: null,
  ...extra,
});
const A = style(0);
const B = style(7, { bold: true });
const runs = (...parts: [string, RunStyle][]): TextRun[] =>
  parts.map(([text, st]) => ({ text, style: st }));

/** A model whose time is advanced by hand. */
function model(r: TextRun[], caret?: number) {
  const clock = { t: 1000 };
  const m = new EditorModel(r, { now: () => clock.t, ...(caret === undefined ? {} : { caret }) });
  return { m, clock };
}

describe('edit state', () => {
  it('joins runs to build text and style ranges, and merges identical styles', () => {
    const s = createEditorState(runs(['ab', A], ['cd', A], ['EF', B]));
    expect(s.text).toBe('abcdEF');
    expect(s.spans.map((x) => [x.start, x.end, x.style.sourceChar])).toEqual([
      [0, 4, 0],
      [4, 6, 7],
    ]);
    expect(s.caret).toBe(6);
    expect(() => createEditorState([])).toThrow();
  });

  it('new characters follow the style of the character before the caret, or of the next character if at the very start', () => {
    const s = createEditorState(runs(['ab', A], ['CD', B]), 2);
    const mid = insertText(s, 'x');
    expect(styleAt(mid, 2)?.sourceChar).toBe(0); // the previous character b(A)
    const atStart = insertText({ ...createEditorState(runs(['ab', A], ['CD', B]), 0) }, 'y');
    expect(styleAt(atStart, 0)?.sourceChar).toBe(0);
    const afterB = insertText(createEditorState(runs(['ab', A], ['CD', B]), 4), 'z');
    expect(styleAt(afterB, 4)?.sourceChar).toBe(7);
  });

  it('keeps the style (empty run) even if deleting the selection leaves the text empty', () => {
    const { m } = model(runs(['ab', B]));
    m.selectAll();
    m.deleteSelection();
    expect(m.state.text).toBe('');
    expect(toRuns(m.state)).toEqual([{ text: '', style: B }]);
    m.insertText('q');
    expect(toRuns(m.state)).toEqual([{ text: 'q', style: B }]);
  });

  it('toRuns returns the text per style range', () => {
    const { m } = model(runs(['ab', A], ['CD', B]), 2);
    m.insertText('x');
    expect(toRuns(m.state)).toEqual([
      { text: 'abx', style: A },
      { text: 'CD', style: B },
    ]);
  });
});

describe('input, deletion, selection', () => {
  it('replaces the selection with input and normalizes to NFC', () => {
    const { m } = model(runs(['hello', A]), 5);
    m.setSelection(1, 3);
    expect(selectedText(m.state)).toBe('el');
    m.insertText('한');
    expect(m.state.text).toBe('h한lo');
    expect(m.state.caret).toBe(2);
  });

  it('NBSP in input, paste and composition commit becomes a space', () => {
    const { m } = model(runs(['', A]));
    m.insertText('a\u00a0b');
    m.paste('c\u00a0d');
    m.compositionUpdate('e\u00a0f');
    m.compositionEnd();
    expect(m.state.text).toBe('a bc de f');
  });

  it('NFD jamo input separately is also combined with neighboring graphemes into NFC', () => {
    const { m } = model(runs(['', A]));
    m.insertText('ᄒ'); // ᄒ
    m.insertText('ᅡ'); // ᅡ
    expect(m.state.text).toBe('하');
    expect(m.state.caret).toBe(1);
  });

  it('Backspace and Delete work per grapheme, per word with Ctrl', () => {
    const { m } = model(runs(['aé big', A]));
    m.deleteBackward();
    expect(m.state.text).toBe('aé bi');
    m.moveTo(3);
    m.deleteBackward();
    expect(m.state.text).toBe('a bi'); // deletes é (2 combining characters) at once
    m.moveTo(0);
    m.deleteForward();
    expect(m.state.text).toBe(' bi');
    m.moveTo(3);
    m.deleteBackward(true);
    expect(m.state.text).toBe(' ');
  });

  it('Backspace at the line start and Delete at the end do nothing', () => {
    const { m } = model(runs(['ab', A]), 0);
    expect(m.deleteBackward()).toBe(false);
    m.moveTo(2);
    expect(m.deleteForward()).toBe(false);
  });

  it('Shift movement extends the selection, and setSelection without movement does not change the text', () => {
    const { m } = model(runs(['abcd', A]), 1);
    m.moveTo(3, true);
    expect(m.state.anchor).toBe(1);
    expect(selectedText(m.state)).toBe('bc');
    m.moveTo(0);
    expect(m.state.anchor).toBe(0);
  });
});

describe('IME composition', () => {
  it('the composition string is replaced within the text and the caret is at the end of the composition (I1)', () => {
    const { m } = model(runs(['ab', A]), 1);
    m.compositionStart();
    m.compositionUpdate('ㅎ');
    expect(m.state.text).toBe('aㅎb');
    expect(m.state.composition).toEqual([1, 2]);
    m.compositionUpdate('하');
    m.compositionUpdate('한');
    expect(m.state.text).toBe('a한b');
    expect(compositionText(m.state)).toBe('한');
    expect(m.state.caret).toBe(2);
    expect(m.compositionEnd('한')).toBe(true);
    expect(m.state.composition).toBeNull();
    expect(m.state.text).toBe('a한b');
  });

  it('Backspace during composition (jamo deletion) updates only the composition string (I2)', () => {
    const { m } = model(runs(['', A]));
    m.compositionUpdate('한');
    m.compositionUpdate('하');
    expect(m.state.text).toBe('하');
    m.compositionUpdate('');
    expect(m.state.text).toBe('');
    expect(m.compositionEnd('')).toBe(false);
    expect(m.state.composition).toBeNull();
  });

  it('input, deletion, movement and undo are ignored during composition (I4, I5)', () => {
    const { m } = model(runs(['ab', A]), 2);
    m.compositionUpdate('가');
    expect(m.insertText('x')).toBe(false);
    expect(m.deleteBackward()).toBe(false);
    m.moveTo(0);
    expect(m.state.caret).toBe(3);
    expect(m.undo()).toBe(false);
    expect(m.state.text).toBe('ab가');
  });

  it('the composition commit string is also normalized to NFC', () => {
    const { m } = model(runs(['', A]));
    m.compositionUpdate('한');
    m.compositionEnd();
    expect(m.state.text).toBe('한');
    expect(m.state.caret).toBe(1);
  });

  it('starting a composition with a selection clears the selection and then starts', () => {
    const { m } = model(runs(['abcd', A]), 1);
    m.setSelection(1, 3);
    m.compositionStart();
    expect(m.state.text).toBe('ad');
    m.compositionUpdate('가');
    m.compositionEnd();
    expect(m.state.text).toBe('a가d');
    // One undo returns to the state before composition (the original text including the selection).
    m.undo();
    expect(m.state.text).toBe('abcd');
  });
});

describe('undo units (I6)', () => {
  it('continuous input is one unit and breaks after whitespace', () => {
    const { m, clock } = model(runs(['', A]));
    for (const ch of 'hello world') {
      m.insertText(ch);
      clock.t += 50;
    }
    expect(m.state.text).toBe('hello world');
    m.undo();
    expect(m.state.text).toBe('hello '); // "world" is one unit
    m.undo();
    expect(m.state.text).toBe(''); // "hello " is one unit (including the space)
    expect(m.undo()).toBe(false);
    m.redo();
    expect(m.state.text).toBe('hello ');
    m.redo();
    expect(m.state.text).toBe('hello world');
    expect(m.redo()).toBe(false);
  });

  it('a pause longer than 0.5 s breaks the unit', () => {
    const { m, clock } = model(runs(['', A]));
    m.insertText('a');
    clock.t += UNDO_PAUSE_MS;
    m.insertText('b'); // exactly 0.5 s: same unit
    clock.t += UNDO_PAUSE_MS + 1;
    m.insertText('c'); // over 0.5 s: new unit
    m.undo();
    expect(m.state.text).toBe('ab');
    m.undo();
    expect(m.state.text).toBe('');
  });

  it('caret movement breaks the unit', () => {
    const { m } = model(runs(['', A]));
    m.insertText('a');
    m.insertText('b');
    m.moveTo(0);
    m.insertText('c');
    expect(m.state.text).toBe('cab');
    m.undo();
    expect(m.state.text).toBe('ab');
    m.undo();
    expect(m.state.text).toBe('');
  });

  it('one composition commit goes into the same unit as the input before and after it', () => {
    const { m, clock } = model(runs(['', A]));
    m.insertText('a');
    clock.t += 100;
    m.compositionUpdate('한');
    m.compositionEnd('한');
    clock.t += 100;
    m.insertText('b');
    expect(m.state.text).toBe('a한b');
    m.undo();
    expect(m.state.text).toBe('');
  });

  it('typing a space after a composition commit makes the text up to that space one unit', () => {
    const { m, clock } = model(runs(['', A]));
    m.compositionUpdate('안');
    m.compositionEnd('안');
    clock.t += 100;
    m.insertText(' ');
    clock.t += 100;
    m.compositionUpdate('녕');
    m.compositionEnd('녕');
    expect(m.state.text).toBe('안 녕');
    m.undo();
    expect(m.state.text).toBe('안 ');
    m.undo();
    expect(m.state.text).toBe('');
  });

  it('consecutive Backspace is one unit, and paste is always a separate unit', () => {
    const { m, clock } = model(runs(['abcdef', A]));
    m.deleteBackward();
    clock.t += 50;
    m.deleteBackward();
    clock.t += 50;
    m.deleteBackward();
    expect(m.state.text).toBe('abc');
    m.undo();
    expect(m.state.text).toBe('abcdef');
    m.paste('XY');
    clock.t += 10;
    m.paste('Z');
    expect(m.state.text).toBe('abcdefXYZ');
    m.undo();
    expect(m.state.text).toBe('abcdefXY');
    m.undo();
    expect(m.state.text).toBe('abcdef');
  });

  it('typing anew after undo clears the redo history', () => {
    const { m } = model(runs(['', A]));
    m.insertText('a');
    m.moveTo(0);
    m.insertText('b');
    m.undo();
    expect(m.history.canRedo).toBe(true);
    m.insertText('c');
    expect(m.history.canRedo).toBe(false);
  });

  it('undo also restores the caret and selection', () => {
    const { m } = model(runs(['hello', A]), 5);
    m.setSelection(0, 5);
    m.insertText('X');
    expect(m.state.text).toBe('X');
    m.undo();
    expect(m.state.text).toBe('hello');
    expect(m.state.caret).toBe(5);
    expect(m.state.anchor).toBe(0);
  });
});
