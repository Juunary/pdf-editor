// Worker 쪽 진입점. 뷰어 메인 스레드에서 import 하지 않는다.
//
// module Worker 는 top-level await(MuPDF wasm 로드) 중에 도착한 메시지를 리스너가 없으면
// 잃는다. 그래서 Comlink 리스너를 먼저 동기 등록하고, MuPDF 는 동적 import 로 불러온다.
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';
import type { PdfSessionOptions } from './session.js';

export function exposePdfWorker(endpoint: Comlink.Endpoint, options: PdfSessionOptions = {}): void {
  let api: Promise<PdfWorkerApi> | null = null;
  const load = (): Promise<PdfWorkerApi> =>
    (api ??= Promise.all([import('./worker-api.js'), import('./session.js')]).then(([m, s]) =>
      m.createPdfWorkerApi(new s.PdfSession(options)),
    ));
  const lazy: PdfWorkerApi = {
    open: async (bytes) => (await load()).open(bytes),
    getPageInfo: async (pageIndex) => (await load()).getPageInfo(pageIndex),
    renderPage: async (request) => (await load()).renderPage(request),
    extractPage: async (request) => (await load()).extractPage(request),
    getSourceMap: async (pageIndex) => (await load()).getSourceMap(pageIndex),
    linkPage: async (pageIndex) => (await load()).linkPage(pageIndex),
    searchText: async (request) => (await load()).searchText(request),
    getPageLayout: async (pageIndex) => (await load()).getPageLayout(pageIndex),
    planSave: async (request) => (await load()).planSave(request),
    save: async (request) => (await load()).save(request),
    close: async () => (await load()).close(),
    getPageEditability: async (pageIndex) => (await load()).getPageEditability(pageIndex),
    planParagraphEdit: async (pageIndex, paragraphId) =>
      (await load()).planParagraphEdit(pageIndex, paragraphId),
    getPageEdits: async (pageIndex) => (await load()).getPageEdits(pageIndex),
    beginParagraphEdit: async (pageIndex, paragraphId, revision, renderScale) =>
      (await load()).beginParagraphEdit(pageIndex, paragraphId, revision, renderScale),
    listRedactAnnots: async () => (await load()).listRedactAnnots(),
    updateParagraphDraft: async (draftId, input) =>
      (await load()).updateParagraphDraft(draftId, input),
    commitParagraphEdit: async (draftId) => (await load()).commitParagraphEdit(draftId),
    cancelParagraphEdit: async (draftId) => (await load()).cancelParagraphEdit(draftId),
    planPathEdit: async (pageIndex, paintSeqs) => (await load()).planPathEdit(pageIndex, paintSeqs),
    beginPathEdit: async (pageIndex, paintSeqs, revision) =>
      (await load()).beginPathEdit(pageIndex, paintSeqs, revision),
    updatePathDraft: async (draftId, edit, renderScale) =>
      (await load()).updatePathDraft(draftId, edit, renderScale),
    commitPathEdit: async (draftId) => (await load()).commitPathEdit(draftId),
    cancelPathEdit: async (draftId) => (await load()).cancelPathEdit(draftId),
    undo: async () => (await load()).undo(),
    redo: async () => (await load()).redo(),
    getEditHistory: async () => (await load()).getEditHistory(),
    replayEdits: async (ops) => (await load()).replayEdits(ops),
  };
  Comlink.expose(lazy, endpoint);
  void load();
}
