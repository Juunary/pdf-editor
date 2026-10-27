// Worker RPC implementation. Loads MuPDF. In the Worker, ./worker.ts imports it dynamically.
import './wasm-module.js';
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';
import { PdfSession } from './session.js';

/** Worker RPC implementation. Buffers of render and save results are transferred without copying. */
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
