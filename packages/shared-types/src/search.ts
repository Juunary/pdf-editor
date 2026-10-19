/** 문서 텍스트 검색(뷰어 Ctrl+F, PLAN.md 6절 M1). */
import type { Quad } from './geometry.js';

export interface SearchRequest {
  query: string;
  /** 기본 false. */
  caseSensitive?: boolean;
  /** 검색 시작 페이지(포함, 기본 0). 뷰어는 현재 페이지를 넘겨 현재 페이지부터 찾는다. */
  startPage?: number;
  /** 최대 페이지 수(기본 전체). 시작 페이지부터 끝까지 간 뒤 0 페이지로 돌아 이어 센다. */
  pageLimit?: number;
  /** 최대 결과 수(기본 1000). 넘으면 truncated. */
  maxHits?: number;
}

export interface SearchHit {
  pageIndex: number;
  /** 한 결과의 사각형들(줄이 바뀌면 여러 개), 페이지 공간. */
  quads: Quad[];
}

export interface SearchResult {
  query: string;
  /** 검색한 페이지 순서대로, 페이지 안에서는 MuPDF 결과 순서. */
  hits: SearchHit[];
  truncated: boolean;
  pagesSearched: number;
  searchMs: number;
}
