// 뷰어(메인 스레드) 쪽 진입점. MuPDF 를 import 하지 않는다.
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

/**
 * 지원 문서 크기 상한 안내 값(byte, M5 C7·리스크 8, docs/m5-heap.md 6절). 이보다 큰 문서는 열 때 "편집·저장이 실패할 수
 * 있음" 을 알린다. MuPDF 를 import 하지 않는 하위 경로(`@pdf-editor/pdf-ops/save-method`)에서 가져온다.
 */
export {
  SUPPORTED_INPUT_BYTES,
  HEAP_WARN_FRACTION,
  WASM_HEAP_LIMIT_BYTES,
} from '@pdf-editor/pdf-ops/save-method';

export type PdfWorkerClient = Comlink.Remote<PdfWorkerApi>;

export function wrapPdfWorker(worker: Worker): PdfWorkerClient {
  return Comlink.wrap<PdfWorkerApi>(worker);
}

/** 바이트를 복사 없이 Worker 로 넘길 때 사용한다. 호출 후 원본 ArrayBuffer 는 비워진다. */
export function transferBytes(bytes: ArrayBuffer): ArrayBuffer {
  return Comlink.transfer(bytes, [bytes]);
}
