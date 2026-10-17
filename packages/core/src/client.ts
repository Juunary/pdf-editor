// 뷰어(메인 스레드) 쪽 진입점. MuPDF 를 import 하지 않는다.
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

export type PdfWorkerClient = Comlink.Remote<PdfWorkerApi>;

export function wrapPdfWorker(worker: Worker): PdfWorkerClient {
  return Comlink.wrap<PdfWorkerApi>(worker);
}

/** 바이트를 복사 없이 Worker 로 넘길 때 사용한다. 호출 후 원본 ArrayBuffer 는 비워진다. */
export function transferBytes(bytes: ArrayBuffer): ArrayBuffer {
  return Comlink.transfer(bytes, [bytes]);
}
