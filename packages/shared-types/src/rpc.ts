/** 뷰어 → 뷰어 소유 module Worker RPC 계약(Comlink, PLAN.md 5.2). */
import type { Rect } from './geometry.js';
import type {
  BeginEditResult,
  BeginPathEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
} from './edit.js';
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

/** 기존 Redact 주석 요약(pdf-ops listRedactAnnots 의 수·쪽). */
export interface RedactAnnotSummary {
  total: number;
  /** Redact 주석이 있는 쪽(0부터). */
  pages: number[];
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
  /** 이 영역(페이지 공간)만 렌더한다(M3 편집 미리보기). 없으면 쪽 전체. */
  clip?: Rect;
}

export interface RenderedPage {
  pageIndex: number;
  width: number;
  height: number;
  /** RGBA, 불투명 흰 배경. 길이 = width * height * 4. Worker 에서 transfer 로 넘긴다. */
  rgba: Uint8ClampedArray<ArrayBuffer>;
  renderMs: number;
  /** 실제로 렌더한 영역(페이지 공간, 픽셀 격자에 맞춘 값). 쪽 전체면 null. */
  clip: Rect | null;
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

  // M3 문단 편집(docs/m3-contract.md 4절). 초안은 문서당 최대 1개.
  /** 쪽의 흐름 문단별 편집 가능 여부(마우스 오버 표시용 일괄 판정). */
  getPageEditability(pageIndex: number): Promise<PageEditability>;
  /** 편집 가능 판정·시작 텍스트·영역. 문서를 바꾸지 않는다. */
  planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan>;
  /** 이 쪽의 편집 블록. */
  getPageEdits(pageIndex: number): Promise<PageEditInfo>;
  /**
   * 저널 작업을 열고 제거·삽입을 적용한 초안을 만든다. revision 이 현재와 다르거나 편집할 수 없으면 예외.
   */
  beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
    /** first.region 렌더 배율. 없으면 마지막 쪽 전체 렌더 배율, 그것도 없으면 2(계약 수정 4). */
    renderScale?: number,
  ): Promise<BeginEditResult>;
  /** 리플로우 → 편집 블록 교체 → 변경 영역 렌더. */
  updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate>;
  /** 저널 작업을 닫고 EditOp 를 로그에 넣는다. */
  commitParagraphEdit(draftId: string): Promise<CommitResult>;
  /** 초안을 버린다. */
  cancelParagraphEdit(draftId: string): Promise<EditHistoryState>;
  // M4 벡터 패스 편집(docs/m4-contract.md). 패스 초안과 문단 초안은 동시에 열 수 없다.
  planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan>;
  beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult>;
  updatePathDraft(draftId: string, edit: PathEdit, renderScale: number): Promise<PathDraftUpdate>;
  commitPathEdit(draftId: string): Promise<CommitResult>;
  cancelPathEdit(draftId: string): Promise<EditHistoryState>;
  undo(): Promise<EditHistoryState>;
  redo(): Promise<EditHistoryState>;
  getEditHistory(): Promise<EditHistoryState>;
  /** 문서의 기존 Redact 주석 수·쪽(A2-2 열기 시 보고, 계약 수정 4). */
  listRedactAnnots(): Promise<RedactAnnotSummary>;
  /** 새로 연 문서에 로그를 다시 적용한다(Worker 복구, 계약 D6). */
  replayEdits(ops: EditOp[]): Promise<EditHistoryState>;
}
