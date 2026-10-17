// Worker 쪽 진입점. 뷰어 메인 스레드에서 import 하지 않는다.
//
// module Worker 는 top-level await(MuPDF wasm 로드) 중에 도착한 메시지를 리스너가 없으면
// 잃는다. 그래서 Comlink 리스너를 먼저 동기 등록하고, MuPDF 는 동적 import 로 불러온다.
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

export function exposePdfWorker(endpoint: Comlink.Endpoint): void {
  let api: Promise<PdfWorkerApi> | null = null;
  const load = (): Promise<PdfWorkerApi> =>
    (api ??= import('./worker-api.js').then((m) => m.createPdfWorkerApi()));
  const lazy: PdfWorkerApi = {
    open: async (bytes) => (await load()).open(bytes),
    renderPage: async (request) => (await load()).renderPage(request),
    save: async (request) => (await load()).save(request),
    close: async () => (await load()).close(),
  };
  Comlink.expose(lazy, endpoint);
  void load();
}
