/** M0 수동 검증용 진단 기록. "진단 결과 복사" 로 JSON 을 꺼내 docs 에 붙인다. */
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

/** 주소 검색 부분에 `diag` 매개변수가 있으면 진단 표시를 켠 채로 연다(`viewer.html?diag`, `?file=…&diag`). */
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
 * 진단 표시 켜고 끄기 단축키 Ctrl+Alt+Shift+D. 자판 배치·한글 입력 상태와 무관하게 물리 키(`code`)로 본다. IME 조합 중은
 * 제외한다.
 */
export function isDiagShortcut(e: ShortcutKeyLike): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && !e.isComposing && e.code === 'KeyD';
}
