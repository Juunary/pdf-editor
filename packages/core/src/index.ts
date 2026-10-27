// Keep as the first import: registers the Module settings object before mupdf initializes.
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
// Save-heap advisory values (M5 C7, docs/m5-heap.md section 6). The main thread (viewer) uses `@pdf-editor/core/client`, which does not pull in MuPDF.
export {
  SUPPORTED_INPUT_BYTES,
  supportedInputBytes,
  HEAP_WARN_FRACTION,
  WASM_HEAP_LIMIT_BYTES,
  type JournalAdvice,
} from '@pdf-editor/pdf-ops';
