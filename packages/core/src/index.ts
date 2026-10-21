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
// 저장 힙 안내 값(M5 C7, docs/m5-heap.md 6절). 메인 스레드(뷰어)는 MuPDF 를 끌어오지 않는 `@pdf-editor/core/client` 를 쓴다.
export {
  SUPPORTED_INPUT_BYTES,
  supportedInputBytes,
  HEAP_WARN_FRACTION,
  WASM_HEAP_LIMIT_BYTES,
  type JournalAdvice,
} from '@pdf-editor/pdf-ops';
