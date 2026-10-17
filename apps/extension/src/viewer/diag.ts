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
