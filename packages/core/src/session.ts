import * as mupdf from 'mupdf';
import { decideSaveMethod } from '@pdf-editor/pdf-ops';
import type { OpenResult, SaveRequest, SaveResult } from '@pdf-editor/shared-types';
import { openPdf } from './open.js';
import { wasmHeapBytes } from './wasm-module.js';

/**
 * 문서 1개의 상태. 뷰어 소유 Worker 안에서만 생성한다(PLAN.md 5.2).
 * 원본 바이트는 편집 로그 재적용(PLAN.md 3.2)을 위해 보관한다.
 */
export class PdfSession {
  #original: Uint8Array | null = null;
  #doc: mupdf.PDFDocument | null = null;

  get document(): mupdf.PDFDocument {
    if (!this.#doc) throw new Error('열린 문서 없음');
    return this.#doc;
  }

  get originalBytes(): Uint8Array {
    if (!this.#original) throw new Error('열린 문서 없음');
    return this.#original;
  }

  open(bytes: ArrayBuffer | Uint8Array): OpenResult {
    this.close();
    const t0 = performance.now();
    const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = openPdf(original);
    this.#original = original;
    this.#doc = doc;
    const page = doc.loadPage(0);
    const [x0, y0, x1, y1] = page.getBounds();
    page.destroy();
    return {
      pageCount: doc.countPages(),
      firstPage: { width: x1 - x0, height: y1 - y0 },
      byteLength: original.byteLength,
      openMs: performance.now() - t0,
    };
  }

  save({ changes }: SaveRequest): SaveResult {
    const doc = this.document;
    const canBeSavedIncrementally = doc.canBeSavedIncrementally();
    const decision = decideSaveMethod(changes, canBeSavedIncrementally);
    const t0 = performance.now();
    const buffer = doc.saveToBuffer(decision.options);
    const bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    return {
      bytes,
      method: decision.method,
      canBeSavedIncrementally,
      options: decision.options,
      saveMs: performance.now() - t0,
      wasmHeapBytes: wasmHeapBytes(),
    };
  }

  close(): void {
    this.#doc?.destroy();
    this.#doc = null;
    this.#original = null;
  }
}
