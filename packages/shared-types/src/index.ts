/**
 * 패키지 간 공통 타입과 Worker RPC 계약.
 *
 * M0 Day 1 범위: 문서 열기·페이지 렌더·저장. PageModel/DocumentModel/SourceMap/EditOp/EditPlan 은
 * M1 설계 시 이 패키지에 추가하고, 병렬 구현 전에 커밋·고정한다(PLAN.md 4·10절).
 */

/** MuPDF 페이지 좌표계(원점 좌상단, y 아래 방향) 사각형 [x0, y0, x1, y1]. 단위 pt. */
export type Rect = [number, number, number, number];

/** 저장 방식. redaction 이 포함되면 증분 저장은 불가하다(PLAN.md 3.1). */
export type SaveMethod = 'incremental' | 'full';

/** 저장 방식 결정에 쓰는 변경 유형. */
export type ChangeKind = 'annotation' | 'metadata' | 'redaction' | 'content-stream' | 'font-embed';

export interface PageSize {
  /** pt */
  width: number;
  /** pt */
  height: number;
}

export interface OpenResult {
  pageCount: number;
  /** 첫 페이지 크기. 나머지는 지연 조회한다. */
  firstPage: PageSize;
  byteLength: number;
  openMs: number;
}

export interface RenderRequest {
  pageIndex: number;
  /** 1 = 72dpi. 뷰어는 devicePixelRatio 를 곱해 넘긴다. */
  scale: number;
}

export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  /** RGBA, 불투명 흰 배경. 길이 = width * height * 4. Worker 에서 transfer 로 넘긴다. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  renderMs: number;
}

export interface SaveRequest {
  /** 마지막 저장 이후 적용된 변경 유형. */
  changes: ChangeKind[];
}

export interface SaveResult {
  bytes: Uint8Array<ArrayBuffer>;
  method: SaveMethod;
  /** 저장 직전 `PDFDocument.canBeSavedIncrementally()` 값. */
  canBeSavedIncrementally: boolean;
  /** MuPDF `saveToBuffer` 옵션 문자열. */
  options: string;
  saveMs: number;
  /** 저장 직후 WASM 선형 메모리 크기(byte). 선형 메모리는 줄지 않으므로 그 시점까지의 최대치다. */
  wasmHeapBytes: number;
}

/** 뷰어 → 뷰어 소유 module Worker RPC 계약(Comlink). */
export interface PdfWorkerApi {
  open(bytes: ArrayBuffer): Promise<OpenResult>;
  renderPage(request: RenderRequest): Promise<RenderedPage>;
  save(request: SaveRequest): Promise<SaveResult>;
  close(): Promise<void>;
}
