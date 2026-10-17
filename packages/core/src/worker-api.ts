// Worker RPC 구현. MuPDF 를 로드한다. Worker 에서는 ./worker.ts 가 동적 import 한다.
import './wasm-module.js';
import * as Comlink from 'comlink';
import type {
  OpenResult,
  PdfWorkerApi,
  RenderRequest,
  RenderedPage,
  SaveRequest,
  SaveResult,
} from '@pdf-editor/shared-types';
import { PdfSession } from './session.js';

/** Worker RPC 구현. 렌더·저장 결과의 버퍼는 복사 없이 transfer 한다. */
export function createPdfWorkerApi(session = new PdfSession()): PdfWorkerApi {
  return {
    async open(bytes: ArrayBuffer): Promise<OpenResult> {
      return session.open(bytes);
    },
    async renderPage(request: RenderRequest): Promise<RenderedPage> {
      const page = session.renderPage(request);
      return Comlink.transfer(page, [page.rgba.buffer]);
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
