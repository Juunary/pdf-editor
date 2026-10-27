/** Key input classification (pure function). */

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

/** Ctrl+F / Cmd+F. Combinations with Shift (Ctrl+Shift+F) are excluded. */
export function isFindShortcut(e: KeyLike): boolean {
  return primaryModifier(e) && !e.shiftKey && e.key.toLowerCase() === 'f';
}

/** Ctrl+A / Cmd+A. */
export function isSelectAllShortcut(e: KeyLike): boolean {
  return primaryModifier(e) && !e.shiftKey && e.key.toLowerCase() === 'a';
}

/** Whether the element accepts typed characters (input field, editable region). Default actions are not intercepted inside it. */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
