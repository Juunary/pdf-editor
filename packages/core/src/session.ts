import * as mupdf from 'mupdf';
import { buildSourceMap, decideSaveMethod, linkPage } from '@pdf-editor/pdf-ops';
import type {
  ExtractRequest,
  InputMode,
  OpenResult,
  PageInfo,
  PageLinkage,
  PageModel,
  Rect,
  RenderRequest,
  RenderedPage,
  SavePlan,
  SaveRequest,
  SaveResult,
  SearchRequest,
  SearchResult,
  SourceMap,
} from '@pdf-editor/shared-types';
import { openPdf } from './open.js';
import { renderPageRgba } from './render.js';
import { wasmHeapBytes } from './wasm-module.js';

/**
 * 문서 1개의 상태. 뷰어 소유 Worker 안에서만 생성한다(PLAN.md 5.2).
 * 원본 바이트는 편집 로그 재적용(PLAN.md 3.2)을 위해 보관한다.
 */
export class PdfSession {
  #original: Uint8Array | null = null;
  #doc: mupdf.PDFDocument | null = null;
  #inputMode: InputMode = 'buffer';

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
    this.#inputMode = 'buffer';
    const page = doc.loadPage(0);
    const [x0, y0, x1, y1] = page.getBounds();
    page.destroy();
    return {
      pageCount: doc.countPages(),
      firstPage: { width: x1 - x0, height: y1 - y0 },
      byteLength: original.byteLength,
      openMs: performance.now() - t0,
      inputMode: this.#inputMode,
    };
  }

  getPageInfo(pageIndex: number): PageInfo {
    const page = this.document.loadPage(pageIndex);
    try {
      const bounds = page.getBounds() as Rect;
      const rotate = page.getObject().getInheritable('Rotate');
      const rotation = rotate.isNumber() ? ((rotate.asNumber() % 360) + 360) % 360 : 0;
      return {
        pageIndex,
        bounds,
        size: { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] },
        rotation,
      };
    } finally {
      page.destroy();
    }
  }

  renderPage({ pageIndex, scale }: RenderRequest): RenderedPage {
    const page = this.document.loadPage(pageIndex);
    try {
      const t0 = performance.now();
      const { width, height, rgba } = renderPageRgba(page, scale);
      return { pageIndex, width, height, rgba, renderMs: performance.now() - t0 };
    } finally {
      page.destroy();
    }
  }

  /** M1 core 작업이 구현한다(docs/m1-contract.md 5.2). */
  extractPage(request: ExtractRequest): PageModel {
    void request;
    throw new Error('M1 미구현: core extractPage');
  }

  getSourceMap(pageIndex: number): SourceMap {
    return buildSourceMap(this.document, pageIndex);
  }

  linkPage(pageIndex: number): PageLinkage {
    return linkPage(this.extractPage({ pageIndex }), this.getSourceMap(pageIndex));
  }

  /** M1 core 작업이 구현한다(docs/m1-contract.md 5.2). */
  searchText(request: SearchRequest): SearchResult {
    void request;
    throw new Error('M1 미구현: core searchText');
  }

  planSave({ changes }: SaveRequest): SavePlan {
    const canBeSavedIncrementally = this.document.canBeSavedIncrementally();
    const decision = decideSaveMethod(changes, canBeSavedIncrementally, {
      inputBytes: this.originalBytes.byteLength,
    });
    if (!decision.heap) throw new Error('예상 피크 힙 계산 실패');
    return {
      method: decision.method,
      options: decision.options,
      reason: decision.reason,
      canBeSavedIncrementally,
      heap: decision.heap,
    };
  }

  save(request: SaveRequest): SaveResult {
    const doc = this.document;
    const plan = this.planSave(request);
    const t0 = performance.now();
    const buffer = doc.saveToBuffer(plan.options);
    const bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    return {
      bytes,
      method: plan.method,
      canBeSavedIncrementally: plan.canBeSavedIncrementally,
      options: plan.options,
      saveMs: performance.now() - t0,
      wasmHeapBytes: wasmHeapBytes(),
      heap: plan.heap,
    };
  }

  close(): void {
    this.#doc?.destroy();
    this.#doc = null;
    this.#original = null;
  }
}
