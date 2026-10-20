/** 저장(PLAN.md 3.1). */

/** 저장 방식. 텍스트·스트림 교체는 항상 전체 저장(PLAN.md 3.1). */
export type SaveMethod = 'incremental' | 'full';

/** 저장 방식 결정에 쓰는 변경 유형. */
export type ChangeKind = 'annotation' | 'metadata' | 'redaction' | 'content-stream' | 'font-embed';

export type HeapLevel = 'ok' | 'warn' | 'over-limit';

/** 저장 전 예상 피크 WASM 힙(PLAN.md 3.1·5.4). pdf-ops `HeapEstimate` 와 같은 모양이다. */
export interface SaveHeapEstimate {
  inputBytes: number;
  /** 적용한 배율(피크 WASM 힙 ÷ 입력 파일 크기). */
  ratio: number;
  estimatedPeakBytes: number;
  limitBytes: number;
  /** estimatedPeakBytes ÷ limitBytes. */
  fraction: number;
  level: HeapLevel;
  /** level 이 ok 가 아니면 사용자 메시지. */
  message: string | null;
}

export interface SaveRequest {
  /** 마지막 저장 이후 적용된 변경 유형. */
  changes: ChangeKind[];
}

/** 저장할 편집 요약(M3, docs/m3-contract.md 5.8). */
export interface SaveEditSummary {
  /** 편집한 쪽(0부터). */
  pages: number[];
  /** 태그 쪽에서 구조 연결이 끊긴 편집 문단 수. */
  structureUnlinked: number;
  /** /Metadata 에 PDF/A 선언이 있음. */
  pdfaDeclared: boolean;
}

/** 저장 전 판정(뷰어가 경고·중단을 결정한다). */
export interface SavePlan {
  method: SaveMethod;
  /** MuPDF `saveToBuffer` 옵션 문자열. */
  options: string;
  reason: string;
  canBeSavedIncrementally: boolean;
  heap: SaveHeapEstimate;
  /** 편집이 없으면 null. */
  edits: SaveEditSummary | null;
  /**
   * 저장 전에 사용자에게 보이고 확인을 받을 경고(편집 엔진 실패 상태 저장 등, M4 R-M4). 없거나 비어 있으면 경고 없음.
   * 뷰어는 비어 있지 않으면 확인 창을 띄운 뒤 저장한다.
   */
  warnings?: string[];
}

export interface SaveResult {
  bytes: Uint8Array<ArrayBuffer>;
  method: SaveMethod;
  /** 저장 직전 `PDFDocument.canBeSavedIncrementally()` 값. */
  canBeSavedIncrementally: boolean;
  /** MuPDF `saveToBuffer` 옵션 문자열. */
  options: string;
  saveMs: number;
  /**
   * 저장 직후 WASM 선형 메모리 크기(byte). 선형 메모리는 줄지 않으므로 그 시점까지의 최대치다.
   * 측정 객체가 연결되지 않은 환경이면 null.
   */
  wasmHeapBytes: number | null;
  /** 저장 전에 계산한 예상 피크 힙. 계산하지 못했으면 null. */
  heap: SaveHeapEstimate | null;
  /** 이 저장에 해당한 경고(`SavePlan.warnings` 와 같음). */
  warnings?: string[];
}
