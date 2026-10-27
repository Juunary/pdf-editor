/** Document text search (viewer Ctrl+F, PLAN.md section 6 M1). */
import type { Quad } from './geometry.js';

export interface SearchRequest {
  query: string;
  /** Default false. */
  caseSensitive?: boolean;
  /** Search start page (inclusive, default 0). The viewer passes the current page to search from it. */
  startPage?: number;
  /** Maximum number of pages (default: all). Goes from the start page to the end, then wraps around to page 0 and continues counting. */
  pageLimit?: number;
  /** Maximum number of results (default 1000). truncated if exceeded. */
  maxHits?: number;
}

export interface SearchHit {
  pageIndex: number;
  /** Rectangles of one result (several if it spans lines), page space. */
  quads: Quad[];
}

export interface SearchResult {
  query: string;
  /** In searched-page order; within a page, in MuPDF result order. */
  hits: SearchHit[];
  truncated: boolean;
  pagesSearched: number;
  searchMs: number;
}
