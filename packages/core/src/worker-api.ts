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
    async getPageLayout(pageIndex) {
      return session.getPageLayout(pageIndex);
    },
    async planSave(request) {
      return session.planSave(request);
    },
    async save(request) {
      const result = session.save(request);
      return Comlink.transfer(result, [result.bytes.buffer]);
    },
    async journalAdvice() {
      return session.journalAdvice();
    },
    async close() {
      session.close();
    },
    getPageEditability: (pageIndex) => session.getPageEditability(pageIndex),
    planParagraphEdit: (pageIndex, paragraphId) =>
      session.planParagraphEdit(pageIndex, paragraphId),
    getPageEdits: (pageIndex) => session.getPageEdits(pageIndex),
    async beginParagraphEdit(pageIndex, paragraphId, revision, renderScale) {
      const result = await session.beginParagraphEdit(
        pageIndex,
        paragraphId,
        revision,
        renderScale,
      );
      return Comlink.transfer(result, [result.first.region.rgba.buffer]);
    },
    async updateParagraphDraft(draftId, input) {
      const update = await session.updateParagraphDraft(draftId, input);
      return Comlink.transfer(update, [update.region.rgba.buffer]);
    },
    commitParagraphEdit: (draftId) => session.commitParagraphEdit(draftId),
    cancelParagraphEdit: (draftId) => session.cancelParagraphEdit(draftId),
    planPathEdit: (pageIndex, paintSeqs) => session.planPathEdit(pageIndex, paintSeqs),
    beginPathEdit: (pageIndex, paintSeqs, revision) =>
      session.beginPathEdit(pageIndex, paintSeqs, revision),
    async updatePathDraft(draftId, edit, renderScale) {
      const update = await session.updatePathDraft(draftId, edit, renderScale);
      return Comlink.transfer(update, [update.region.rgba.buffer]);
    },
    commitPathEdit: (draftId) => session.commitPathEdit(draftId),
    cancelPathEdit: (draftId) => session.cancelPathEdit(draftId),
    undo: () => session.undo(),
    redo: () => session.redo(),
    getEditHistory: () => session.getEditHistory(),
    replayEdits: (ops, options) => session.replayEdits(ops, options),
    listRedactAnnots: async () => session.listRedactAnnots(),
  };
}
