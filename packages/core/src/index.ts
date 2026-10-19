// 첫 import 유지: mupdf 초기화 전에 Module 설정 객체를 등록한다.
export { wasmHeapBytes, libmupdfModule, type LibMupdfModuleConfig } from './wasm-module.js';
export { openPdf, type OpenPdfOptions } from './open.js';
export {
  extractPageDetailed,
  extractPageModel,
  type ExtractResult,
  type ExtractStats,
} from './extract.js';
export { searchDocument } from './search.js';
export { assembleReadingText, foldWhitespace } from './reading-text.js';
export { renderPageRegionRgba, renderPageRgba, type RgbaImage, type RgbaRegion } from './render.js';
export { defaultEditAdapter, type EditAdapter } from './edit-adapter.js';
export { EditStateError, StaleRevisionError } from './edit-engine.js';
export { PdfSession, type PdfSessionOptions } from './session.js';
export { createPdfWorkerApi } from './worker-api.js';
