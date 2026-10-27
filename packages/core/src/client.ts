// Entry point on the viewer (main thread) side. Does not import MuPDF.
import * as Comlink from 'comlink';
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

/**
 * Advisory upper bound on supported document size (bytes, M5 C7 and risk 8, docs/m5-heap.md section 6). For larger documents, opening warns that "editing and saving may
 * fail". Imported from a subpath that does not import MuPDF (`@pdf-editor/pdf-ops/save-method`).
 */
export {
  SUPPORTED_INPUT_BYTES,
  HEAP_WARN_FRACTION,
  WASM_HEAP_LIMIT_BYTES,
} from '@pdf-editor/pdf-ops/save-method';

export type PdfWorkerClient = Comlink.Remote<PdfWorkerApi>;

export function wrapPdfWorker(worker: Worker): PdfWorkerClient {
  return Comlink.wrap<PdfWorkerApi>(worker);
}

/** Used to hand bytes to the Worker without copying. After the call, the original ArrayBuffer is emptied. */
export function transferBytes(bytes: ArrayBuffer): ArrayBuffer {
  return Comlink.transfer(bytes, [bytes]);
}
