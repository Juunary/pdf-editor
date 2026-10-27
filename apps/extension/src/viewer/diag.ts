/** Diagnostic log for M0 manual verification. "진단 결과 복사" (Copy diagnostics) extracts the JSON to paste into docs. */
export interface DiagEntry {
  at: string;
  event: string;
  data?: unknown;
}

export class DiagLog {
  readonly entries: DiagEntry[] = [];
  constructor(private readonly onChange: (log: DiagLog) => void) {}

  add(event: string, data?: unknown): void {
    this.entries.push({ at: new Date().toISOString(), event, data });
    this.onChange(this);
  }

  toJSON(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

/** If the query string has a `diag` parameter, open with diagnostics shown (`viewer.html?diag`, `?file=…&diag`). */
export function diagRequested(search: string): boolean {
  return new URLSearchParams(search).has('diag');
}

export interface ShortcutKeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}

/**
 * Shortcut Ctrl+Alt+Shift+D to toggle the diagnostics display. Uses the physical key (`code`), independent of keyboard layout and Korean input state. While an IME composition is in progress, it is
 * ignored.
 */
export function isDiagShortcut(e: ShortcutKeyLike): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && !e.isComposing && e.code === 'KeyD';
}
