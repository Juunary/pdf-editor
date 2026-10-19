/** 뷰어 → 뷰어 소유 module Worker RPC 계약(Comlink, PLAN.md 5.2). */
import type { Rect } from './geometry.js';
import type { ExtractRequest, PageModel } from './page-model.js';
import type { PageLayout } from './page-layout.js';
import type { SaveRequest, SavePlan, SaveResult } from './save.js';
import type { SearchRequest, SearchResult } from './search.js';
import type { PageLinkage, SourceMap } from './source-map.js';

export interface PageSize {
  /** pt */
  width: number;
  /** pt */
  height: number;
}

/** 원본을 WASM 에 넘긴 방식. stream 은 열기 시 WASM 힙에 입력을 복사하지 않는다(A3-1). */
export type InputMode = 'buffer' | 'stream';

export interface OpenResult {
  pageCount: number;
  /** 첫 페이지 크기. 나머지는 getPageInfo 로 지연 조회한다. */
  firstPage: PageSize;
  byteLength: number;
  openMs: number;
  inputMode: InputMode;
}

export interface PageInfo {
  pageIndex: number;
  /** `Page.getBounds()`, 페이지 공간. */
  bounds: Rect;
  size: PageSize;
  /** 상속 반영한 /Rotate. */
  rotation: number;
}

export interface RenderRequest {
  pageIndex: number;
  /** 1 = 72dpi. 뷰어는 devicePixelRatio 를 곱해 넘긴다. */
  scale: number;
}

export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  /** RGBA, 불투명 흰 배경. 길이 = width * height * 4. Worker 에서 transfer 로 넘긴다. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  renderMs: number;
}

export interface PdfWorkerApi {
  open(bytes: ArrayBuffer): Promise<OpenResult>;
  getPageInfo(pageIndex: number): Promise<PageInfo>;
  renderPage(request: RenderRequest): Promise<RenderedPage>;
  /** 추출 모델. 같은 페이지는 문서가 바뀌기 전까지 캐시해도 된다. */
  extractPage(request: ExtractRequest): Promise<PageModel>;
  /** 원본 연결 정보(디버그 오버레이·편집 계획용). */
  getSourceMap(pageIndex: number): Promise<SourceMap>;
  /** extractPage + getSourceMap 결과의 매칭. */
  linkPage(pageIndex: number): Promise<PageLinkage>;
  searchText(request: SearchRequest): Promise<SearchResult>;
  /** 쪽 레이아웃(문단·열·표·도형·읽기 순서, M2). 같은 쪽은 문서가 바뀌기 전까지 캐시해도 된다. */
  getPageLayout(pageIndex: number): Promise<PageLayout>;
  /** 저장 전 판정(방식·옵션·예상 피크 힙). 저장하지 않는다. */
  planSave(request: SaveRequest): Promise<SavePlan>;
  save(request: SaveRequest): Promise<SaveResult>;
  close(): Promise<void>;
}
