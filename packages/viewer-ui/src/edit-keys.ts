/**
 * 편집기 숨은 textarea 의 키 입력 → 편집 동작(순수). 조합 중에는 IME 가 키를 쓰므로 아무 동작도 하지 않는다
 * (계약 1.3 I4·I5·I8: 조합 중 화살표·단축키·Esc 는 무시).
 */
export interface EditKeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** IME 조합 중(`KeyboardEvent.isComposing`). */
  isComposing?: boolean;
  /** 조합 중 keydown 은 keyCode 229(브라우저별로 isComposing 이 false 일 수 있다). */
  keyCode?: number;
}

export type EditKeyAction =
  | { type: 'move-h'; dir: -1 | 1; shift: boolean; word: boolean }
  | { type: 'move-v'; dir: -1 | 1; shift: boolean }
  | { type: 'line'; which: 'home' | 'end'; shift: boolean; whole: boolean }
  | { type: 'backspace'; word: boolean }
  | { type: 'delete'; word: boolean }
  | { type: 'enter' }
  | { type: 'select-all' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'commit' };

export function mapEditKey(e: EditKeyLike): EditKeyAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  switch (key) {
    case 'ArrowLeft':
      return { type: 'move-h', dir: -1, shift: e.shiftKey, word: ctrl };
    case 'ArrowRight':
      return { type: 'move-h', dir: 1, shift: e.shiftKey, word: ctrl };
    case 'ArrowUp':
      return { type: 'move-v', dir: -1, shift: e.shiftKey };
    case 'ArrowDown':
      return { type: 'move-v', dir: 1, shift: e.shiftKey };
    case 'Home':
      return { type: 'line', which: 'home', shift: e.shiftKey, whole: ctrl };
    case 'End':
      return { type: 'line', which: 'end', shift: e.shiftKey, whole: ctrl };
    case 'Backspace':
      return { type: 'backspace', word: ctrl };
    case 'Delete':
      return { type: 'delete', word: ctrl };
    case 'Enter':
      return ctrl ? null : { type: 'enter' };
    case 'Escape':
      return { type: 'commit' };
    case 'a':
      return ctrl && !e.shiftKey ? { type: 'select-all' } : null;
    case 'z':
      return ctrl ? { type: e.shiftKey ? 'redo' : 'undo' } : null;
    case 'y':
      return ctrl && !e.shiftKey ? { type: 'redo' } : null;
    default:
      return null;
  }
}

/** 문서 undo/redo 단축키(편집 밖): Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y. */
export function docHistoryShortcut(e: EditKeyLike): 'undo' | 'redo' | null {
  const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
  if (!ctrl) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  return null;
}
