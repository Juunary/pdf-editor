/**
 * 뷰어 UI 가 뷰어 소유 Worker 에 요구하는 호출 집합. `PdfWorkerApi`(Comlink 원격)가 그대로 만족한다.
 * UI 패키지는 Worker·MuPDF 를 직접 알지 못하므로 테스트에서는 가짜 구현을 넘긴다.
 */
import type { PdfWorkerApi } from '@pdf-editor/shared-types';

/** 편집(M3) RPC. 호스트가 모두 주면 편집 기능이 켜지고, 하나라도 없으면 편집만 꺼진다. */
export type EditHostApi = Pick<
  PdfWorkerApi,
  | 'getPageEditability'
  | 'planParagraphEdit'
  | 'beginParagraphEdit'
  | 'updateParagraphDraft'
  | 'commitParagraphEdit'
  | 'cancelParagraphEdit'
  | 'undo'
  | 'redo'
  | 'getEditHistory'
>;

export const EDIT_HOST_METHODS = [
  'getPageEditability',
  'planParagraphEdit',
  'beginParagraphEdit',
  'updateParagraphDraft',
  'commitParagraphEdit',
  'cancelParagraphEdit',
  'undo',
  'redo',
  'getEditHistory',
] as const satisfies readonly (keyof EditHostApi)[];

/** 벡터 패스 편집(M4) RPC. 하나라도 없으면 패스 편집만 꺼진다(문단 편집과 별개). */
export type PathHostApi = Pick<
  PdfWorkerApi,
  'planPathEdit' | 'beginPathEdit' | 'updatePathDraft' | 'commitPathEdit' | 'cancelPathEdit'
>;

export const PATH_HOST_METHODS = [
  'planPathEdit',
  'beginPathEdit',
  'updatePathDraft',
  'commitPathEdit',
  'cancelPathEdit',
] as const satisfies readonly (keyof PathHostApi)[];

export type ViewerHost = Pick<
  PdfWorkerApi,
  | 'getPageInfo'
  | 'renderPage'
  | 'extractPage'
  | 'getSourceMap'
  | 'linkPage'
  | 'searchText'
  | 'getPageLayout'
> &
  Partial<EditHostApi> &
  Partial<PathHostApi> & {
    /** 진단 로그(예: 확장 뷰어의 DiagLog). 기능 비활성화·오류를 여기에 남긴다. */
    log(event: string, data?: unknown): void;
  };

/** 렌더 배율 계산에 쓰는 환경 값. */
export interface ViewerEnvironment {
  devicePixelRatio: number;
  /** 뷰어가 쓸 수 있는 CSS 폭. */
  availableWidth: number;
}

/** 호스트가 편집 RPC 를 모두 제공하는지. */
export function hasEditHost(host: ViewerHost): host is ViewerHost & EditHostApi {
  return EDIT_HOST_METHODS.every((m) => typeof host[m] === 'function');
}

/** 호스트가 패스 편집 RPC 를 모두 제공하는지. */
export function hasPathHost(host: ViewerHost): host is ViewerHost & PathHostApi {
  return PATH_HOST_METHODS.every((m) => typeof host[m] === 'function');
}
