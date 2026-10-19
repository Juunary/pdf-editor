/** 키 입력 판정(순수 함수). */

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey?: boolean;
}

function primaryModifier(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey;
}

/** Ctrl+F / Cmd+F. Shift 가 붙은 조합(Ctrl+Shift+F)은 제외한다. */
export function isFindShortcut(e: KeyLike): boolean {
  return primaryModifier(e) && !e.shiftKey && e.key.toLowerCase() === 'f';
}

/** Ctrl+A / Cmd+A. */
export function isSelectAllShortcut(e: KeyLike): boolean {
  return primaryModifier(e) && !e.shiftKey && e.key.toLowerCase() === 'a';
}

/** 글자를 입력하는 요소(입력란·편집 가능 영역)인지. 이 안에서는 기본 동작을 가로채지 않는다. */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
