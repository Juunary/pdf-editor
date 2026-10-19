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

/** 시각을 손으로 움직이는 모델. */
function model(r: TextRun[], caret?: number) {
  const clock = { t: 1000 };
  const m = new EditorModel(r, { now: () => clock.t, ...(caret === undefined ? {} : { caret }) });
  return { m, clock };
}

describe('편집 상태', () => {
  it('runs 를 이어 텍스트·모양 구간을 만들고 같은 모양은 합친다', () => {
    const s = createEditorState(runs(['ab', A], ['cd', A], ['EF', B]));
    expect(s.text).toBe('abcdEF');
    expect(s.spans.map((x) => [x.start, x.end, x.style.sourceChar])).toEqual([
      [0, 4, 0],
      [4, 6, 7],
    ]);
    expect(s.caret).toBe(6);
    expect(() => createEditorState([])).toThrow();
  });

  it('새 글자는 캐럿 앞 글자의 모양을 따르고, 맨 앞이면 뒤 글자의 모양을 따른다', () => {
    const s = createEditorState(runs(['ab', A], ['CD', B]), 2);
    const mid = insertText(s, 'x');
    expect(styleAt(mid, 2)?.sourceChar).toBe(0); // 앞 글자 b(A)
    const atStart = insertText({ ...createEditorState(runs(['ab', A], ['CD', B]), 0) }, 'y');
    expect(styleAt(atStart, 0)?.sourceChar).toBe(0);
    const afterB = insertText(createEditorState(runs(['ab', A], ['CD', B]), 4), 'z');
    expect(styleAt(afterB, 4)?.sourceChar).toBe(7);
  });

  it('선택을 지워 텍스트가 비어도 모양(빈 run)을 유지한다', () => {
    const { m } = model(runs(['ab', B]));
    m.selectAll();
    m.deleteSelection();
    expect(m.state.text).toBe('');
    expect(toRuns(m.state)).toEqual([{ text: '', style: B }]);
    m.insertText('q');
    expect(toRuns(m.state)).toEqual([{ text: 'q', style: B }]);
  });

  it('toRuns 는 모양 구간별 텍스트를 돌려준다', () => {
    const { m } = model(runs(['ab', A], ['CD', B]), 2);
    m.insertText('x');
    expect(toRuns(m.state)).toEqual([
      { text: 'abx', style: A },
      { text: 'CD', style: B },
    ]);
  });
});

describe('입력·삭제·선택', () => {
  it('선택을 입력으로 바꾸고 NFC 로 정규화한다', () => {
    const { m } = model(runs(['hello', A]), 5);
    m.setSelection(1, 3);
    expect(selectedText(m.state)).toBe('el');
    m.insertText('한');
    expect(m.state.text).toBe('h한lo');
    expect(m.state.caret).toBe(2);
  });

  it('입력·붙여넣기·조합 확정의 NBSP 는 공백이 된다', () => {
    const { m } = model(runs(['', A]));
    m.insertText('a\u00a0b');
    m.paste('c\u00a0d');
    m.compositionUpdate('e\u00a0f');
    m.compositionEnd();
    expect(m.state.text).toBe('a bc de f');
  });

  it('분리 입력된 NFD 자모도 이웃 자소와 합쳐 NFC 로 만든다', () => {
    const { m } = model(runs(['', A]));
    m.insertText('ᄒ'); // ᄒ
    m.insertText('ᅡ'); // ᅡ
    expect(m.state.text).toBe('하');
    expect(m.state.caret).toBe(1);
  });

  it('Backspace·Delete 는 자소 단위, Ctrl 이면 단어 단위', () => {
    const { m } = model(runs(['aé big', A]));
    m.deleteBackward();
    expect(m.state.text).toBe('aé bi');
    m.moveTo(3);
    m.deleteBackward();
    expect(m.state.text).toBe('a bi'); // é(결합 문자 2개)를 한 번에 지운다
    m.moveTo(0);
    m.deleteForward();
    expect(m.state.text).toBe(' bi');
    m.moveTo(3);
    m.deleteBackward(true);
    expect(m.state.text).toBe(' ');
  });

  it('줄 맨 앞 Backspace·끝 Delete 는 아무 일도 하지 않는다', () => {
    const { m } = model(runs(['ab', A]), 0);
    expect(m.deleteBackward()).toBe(false);
    m.moveTo(2);
    expect(m.deleteForward()).toBe(false);
  });

  it('Shift 이동은 선택을 넓히고, 이동 없는 setSelection 은 텍스트를 바꾸지 않는다', () => {
    const { m } = model(runs(['abcd', A]), 1);
    m.moveTo(3, true);
    expect(m.state.anchor).toBe(1);
    expect(selectedText(m.state)).toBe('bc');
    m.moveTo(0);
    expect(m.state.anchor).toBe(0);
  });
});

describe('IME 조합', () => {
  it('조합 문자열은 텍스트 안에서 교체되고 캐럿은 조합 끝에 있다(I1)', () => {
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

  it('조합 중 Backspace(자모 삭제)는 조합 문자열만 갱신한다(I2)', () => {
    const { m } = model(runs(['', A]));
    m.compositionUpdate('한');
    m.compositionUpdate('하');
    expect(m.state.text).toBe('하');
    m.compositionUpdate('');
    expect(m.state.text).toBe('');
    expect(m.compositionEnd('')).toBe(false);
    expect(m.state.composition).toBeNull();
  });

  it('조합 중에는 입력·삭제·이동·되돌리기를 무시한다(I4·I5)', () => {
    const { m } = model(runs(['ab', A]), 2);
    m.compositionUpdate('가');
    expect(m.insertText('x')).toBe(false);
    expect(m.deleteBackward()).toBe(false);
    m.moveTo(0);
    expect(m.state.caret).toBe(3);
    expect(m.undo()).toBe(false);
    expect(m.state.text).toBe('ab가');
  });

  it('조합 확정 문자열도 NFC 로 정규화한다', () => {
    const { m } = model(runs(['', A]));
    m.compositionUpdate('한');
    m.compositionEnd();
    expect(m.state.text).toBe('한');
    expect(m.state.caret).toBe(1);
  });

  it('선택이 있는 상태에서 조합을 시작하면 선택을 지우고 시작한다', () => {
    const { m } = model(runs(['abcd', A]), 1);
    m.setSelection(1, 3);
    m.compositionStart();
    expect(m.state.text).toBe('ad');
    m.compositionUpdate('가');
    m.compositionEnd();
    expect(m.state.text).toBe('a가d');
    // 한 번의 되돌리기로 조합 전(선택 포함 원문)으로 돌아간다.
    m.undo();
    expect(m.state.text).toBe('abcd');
  });
});

describe('되돌리기 단위(I6)', () => {
  it('연속 입력은 한 단위이고 공백 뒤에서 끊긴다', () => {
    const { m, clock } = model(runs(['', A]));
    for (const ch of 'hello world') {
      m.insertText(ch);
      clock.t += 50;
    }
    expect(m.state.text).toBe('hello world');
    m.undo();
    expect(m.state.text).toBe('hello '); // "world" 가 한 단위
    m.undo();
    expect(m.state.text).toBe(''); // "hello " 가 한 단위(공백까지)
    expect(m.undo()).toBe(false);
    m.redo();
    expect(m.state.text).toBe('hello ');
    m.redo();
    expect(m.state.text).toBe('hello world');
    expect(m.redo()).toBe(false);
  });

  it('0.5초를 넘기는 정지는 단위를 끊는다', () => {
    const { m, clock } = model(runs(['', A]));
    m.insertText('a');
    clock.t += UNDO_PAUSE_MS;
    m.insertText('b'); // 정확히 0.5초: 같은 단위
    clock.t += UNDO_PAUSE_MS + 1;
    m.insertText('c'); // 0.5초 초과: 새 단위
    m.undo();
    expect(m.state.text).toBe('ab');
    m.undo();
    expect(m.state.text).toBe('');
  });

  it('캐럿 이동은 단위를 끊는다', () => {
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

  it('조합 확정 한 번은 앞뒤 입력과 같은 단위에 들어간다', () => {
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

  it('조합 확정 뒤 공백을 입력하면 그 공백까지가 한 단위', () => {
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

  it('연속 Backspace 는 한 단위, 붙여넣기는 항상 별도 단위', () => {
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

  it('되돌린 뒤 새로 입력하면 다시 실행 이력이 사라진다', () => {
    const { m } = model(runs(['', A]));
    m.insertText('a');
    m.moveTo(0);
    m.insertText('b');
    m.undo();
    expect(m.history.canRedo).toBe(true);
    m.insertText('c');
    expect(m.history.canRedo).toBe(false);
  });

  it('되돌리기는 캐럿·선택도 복원한다', () => {
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
