// Worker RPC 구현. MuPDF 를 로드한다. Worker 에서는 ./worker.ts 가 동적 import 한다.
import './wasm-module.js';
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';
import { PdfSession } from './session.js';

/** Worker RPC 구현. 렌더·저장 결과의 버퍼는 복사 없이 transfer 한다. */
export function createPdfWorkerApi(session = new PdfSession()): PdfWorkerApi {
  return {
    async open(bytes) {
      return session.open(bytes);
    },
    async getPageInfo(pageIndex) {
      return session.getPageInfo(pageIndex);
    },
    async renderPage(request) {
      const page = session.renderPage(request);
      return Comlink.transfer(page, [page.rgba.buffer]);
    },
    async extractPage(request) {
      return session.extractPage(request);
    },
    async getSourceMap(pageIndex) {
      return session.getSourceMap(pageIndex);
    },
    async linkPage(pageIndex) {
      return session.linkPage(pageIndex);
    },
    async searchText(request) {
      return session.searchText(request);
    },
    async planSave(request) {
      return session.planSave(request);
    },
    async save(request) {
      const result = session.save(request);
      return Comlink.transfer(result, [result.bytes.buffer]);
    },
    async close() {
      session.close();
    },
  };
}
