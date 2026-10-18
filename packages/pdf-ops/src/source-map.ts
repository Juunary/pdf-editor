/**
 * 원본 연결 정보 생성과 PageModel 매칭(PLAN.md 3.4, docs/m1-contract.md).
 *
 * 이 파일의 두 함수는 M1 계약 커밋에서 시그니처만 고정했다. 구현은 M1 pdf-ops 작업
 * (콘텐츠 스트림 인터프리터)이 채운다. 시그니처 변경은 메인 세션만 한다.
 */
import type * as mupdf from 'mupdf';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';

export interface SourceMapOptions {
  /** Form XObject 재귀 깊이 상한(기본 8). 넘으면 form-depth-exceeded(L5). */
  maxFormDepth?: number;
}

export interface LinkOptions {
  /** 매칭으로 인정할 원점 오차(pt, 페이지 공간, 기본 1). */
  originTolerance?: number;
}

/** 페이지 콘텐츠(Form XObject 재귀 포함)를 실행 순서대로 해석해 원본 연결 정보를 만든다. */
export function buildSourceMap(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: SourceMapOptions = {},
): SourceMap {
  void doc;
  void pageIndex;
  void options;
  throw new Error('M1 미구현: pdf-ops buildSourceMap');
}

/** glyphSeq·paintSeq 와 원점으로 PageModel 의 글자·도형을 SourceMap 연산에 연결한다. */
export function linkPage(model: PageModel, map: SourceMap, options: LinkOptions = {}): PageLinkage {
  void model;
  void map;
  void options;
  throw new Error('M1 미구현: pdf-ops linkPage');
}
