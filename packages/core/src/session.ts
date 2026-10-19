import * as mupdf from 'mupdf';
import {
  STREAM_INPUT_PEAK_HEAP_RATIO,
  buildSourceMap,
  decideSaveMethod,
  linkPage,
} from '@pdf-editor/pdf-ops';
import { reconstructPage } from '@pdf-editor/layout-recon';
import type {
  ExtractRequest,
  InputMode,
  OpenResult,
  PageInfo,
  PageLayout,
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
import { extractPageModel } from './extract.js';
import { openPdf } from './open.js';
import { pageRotation } from './page-geometry.js';
import { renderPageRgba } from './render.js';
import { searchDocument } from './search.js';
import { wasmHeapBytes } from './wasm-module.js';

/** 추출 모델·원본 연결 정보를 캐시하는 최대 쪽 수(추출 모델은 요청 종류별로 센다). */
const PAGE_CACHE_LIMIT = 16;

/** 최근 사용 순 캐시에서 꺼내며 순서를 올린다. */
function touch<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** 넣고, 상한을 넘으면 가장 오래된 항목을 뺀다. */
function remember<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.set(key, value);
  if (cache.size > PAGE_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/**
 * 문서 1개의 상태. 뷰어 소유 Worker 안에서만 생성한다(PLAN.md 5.2).
 * 원본 바이트는 편집 로그 재적용(PLAN.md 3.2)을 위해 보관한다.
 */
export class PdfSession {
  #original: Uint8Array | null = null;
  #doc: mupdf.PDFDocument | null = null;
  #inputMode: InputMode = 'buffer';
  #pageCache = new Map<string, PageModel>();
  #sourceMapCache = new Map<number, SourceMap>();
  #layoutCache = new Map<number, PageLayout>();

  get document(): mupdf.PDFDocument {
    if (!this.#doc) throw new Error('열린 문서 없음');
    return this.#doc;
  }

  get originalBytes(): Uint8Array {
    if (!this.#original) throw new Error('열린 문서 없음');
    return this.#original;
  }

  /**
   * 문서를 연다. 기본은 Stream 입력(A3-1): 보관 중인 원본 바이트를 MuPDF 가 필요한 구간만 읽어
   * 입력 크기만큼의 WASM 힙을 쓰지 않는다. `buffer` 는 비교·측정용이다.
   */
  open(bytes: ArrayBuffer | Uint8Array, inputMode: InputMode = 'stream'): OpenResult {
    this.close();
    const t0 = performance.now();
    const original = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const doc = openPdf(original, { inputMode });
    this.#original = original;
    this.#doc = doc;
    this.#inputMode = inputMode;
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
      return {
        pageIndex,
        bounds,
        size: { width: bounds[2] - bounds[0], height: bounds[3] - bounds[1] },
        rotation: pageRotation(page),
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

  /**
   * 페이지 추출 모델. 같은 요청은 문서가 바뀌기 전까지 캐시하고(최근 사용 순 최대 PAGE_CACHE_LIMIT 쪽),
   * 같은 객체를 돌려준다. 호출자는 바꾸지 않는다. 문서를 편집하면 `invalidatePageCache` 를 부른다.
   */
  extractPage(request: ExtractRequest): PageModel {
    const key = `${request.pageIndex}:${request.includePathSegments === true ? 1 : 0}`;
    const cached = touch(this.#pageCache, key);
    if (cached) return cached;
    const page = this.document.loadPage(request.pageIndex);
    let model: PageModel;
    try {
      model = extractPageModel(page, request);
    } finally {
      page.destroy();
    }
    remember(this.#pageCache, key, model);
    return model;
  }

  /**
   * 추출·원본 연결 정보·레이아웃 캐시를 비운다. 쪽을 지정하면 그 쪽만. 문서 내용(콘텐츠·리소스·쪽 순서)이 바뀐
   * 뒤에 부른다.
   */
  invalidatePageCache(pageIndex?: number): void {
    if (pageIndex === undefined) {
      this.#pageCache.clear();
      this.#sourceMapCache.clear();
      this.#layoutCache.clear();
      return;
    }
    this.#layoutCache.delete(pageIndex);
    for (const key of [...this.#pageCache.keys()]) {
      if (key.startsWith(`${pageIndex}:`)) this.#pageCache.delete(key);
    }
    this.#sourceMapCache.delete(pageIndex);
  }

  /**
   * 쪽 레이아웃(M2, docs/m2-contract.md). 경로 세그먼트를 포함한 추출 모델로 복원하고, 추출 캐시와 같은
   * 규칙(최근 사용 순 최대 PAGE_CACHE_LIMIT 쪽)으로 캐시한다. 호출자는 결과를 바꾸지 않는다.
   */
  getPageLayout(pageIndex: number): PageLayout {
    const cached = touch(this.#layoutCache, pageIndex);
    if (cached) return cached;
    // 이웃 쪽(±1·±2) 추출 모델: 러닝헤드·쪽 번호 반복 판정용(계약 2.5). 추출 캐시를 거친다.
    const count = this.document.countPages();
    const neighbors = [-2, -1, 1, 2]
      .map((k) => pageIndex + k)
      .filter((n) => n >= 0 && n < count)
      .map((n) => this.extractPage({ pageIndex: n }));
    const layout = reconstructPage(this.extractPage({ pageIndex, includePathSegments: true }), {
      neighbors,
    });
    remember(this.#layoutCache, pageIndex, layout);
    return layout;
  }

  /**
   * 쪽의 원본 연결 정보. extractPage 와 같이 쪽마다 캐시하고 같은 객체를 돌려준다. `linkPage` 가 이 객체의
   * `ops[].limits` 에 `unmatched` 를 더하므로, linkPage 뒤의 getSourceMap 은 그 표시를 담는다.
   */
  getSourceMap(pageIndex: number): SourceMap {
    const cached = touch(this.#sourceMapCache, pageIndex);
    if (cached) return cached;
    const map = buildSourceMap(this.document, pageIndex);
    remember(this.#sourceMapCache, pageIndex, map);
    return map;
  }

  /** 캐시한 추출 모델과 원본 연결 정보를 매칭한다(원본 연결 정보에 `unmatched` 표시). */
  linkPage(pageIndex: number): PageLinkage {
    return linkPage(this.extractPage({ pageIndex }), this.getSourceMap(pageIndex));
  }

  searchText(request: SearchRequest): SearchResult {
    return searchDocument(this.document, request);
  }

  planSave({ changes }: SaveRequest): SavePlan {
    const canBeSavedIncrementally = this.document.canBeSavedIncrementally();
    const decision = decideSaveMethod(changes, canBeSavedIncrementally, {
      inputBytes: this.originalBytes.byteLength,
      // Stream 입력은 입력 크기만큼의 힙을 쓰지 않으므로 실측 배율이 낮다(docs/m0-dod-xobject-redact-save.md 3.3).
      ...(this.#inputMode === 'stream' ? { ratio: STREAM_INPUT_PEAK_HEAP_RATIO } : {}),
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
    this.#pageCache.clear();
    this.#sourceMapCache.clear();
    this.#layoutCache.clear();
    this.#doc?.destroy();
    this.#doc = null;
    this.#original = null;
  }
}
