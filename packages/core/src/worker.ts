// Worker 쪽 진입점. MuPDF 를 로드하므로 뷰어 메인 스레드에서 import 하지 않는다.
import './wasm-module.js';
import * as Comlink from 'comlink';
import type { OpenResult, PdfWorkerApi, SaveRequest, SaveResult } from '@pdf-editor/shared-types';
import { PdfSession } from './session.js';

/** Worker RPC 구현. 저장 결과의 버퍼는 복사 없이 transfer 한다. */
export function createPdfWorkerApi(session = new PdfSession()): PdfWorkerApi {
  return {
    async open(bytes: ArrayBuffer): Promise<OpenResult> {
      return session.open(bytes);
    },
    async renderPage(): Promise<never> {
      throw new Error('3단계에서 구현');
    },
    async save(request: SaveRequest): Promise<SaveResult> {
      const result = session.save(request);
      return Comlink.transfer(result, [result.bytes.buffer]);
    },
    async close(): Promise<void> {
      session.close();
    },
  };
}

export function exposePdfWorker(endpoint: Comlink.Endpoint): void {
  Comlink.expose(createPdfWorkerApi(), endpoint);
}
