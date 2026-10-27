import type * as mupdf from 'mupdf';
import type { Quad, SearchHit, SearchRequest, SearchResult } from '@pdf-editor/shared-types';

export const DEFAULT_MAX_HITS = 1000;

/** Upper bound on the number of rectangles (quads) mupdf.js `runSearch` returns for one page. If exceeded, that page's results may be truncated. */
export const MUPDF_PAGE_QUAD_CAP = 500;

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} 는 ${min} 이상의 정수여야 함: ${value}`);
  }
}

/**
 * Document text search. Goes from `startPage` to the last page, wraps around to page 0, and looks through `pageLimit` pages.
 * Results are in the order of pages searched, and within a page in MuPDF result order. Case-sensitive by default.
 *
 * `truncated` is true when there are more results beyond maxHits, or when a page's results
 * may have been cut off at MuPDF's per-page limit (500 quads).
 */
export function searchDocument(doc: mupdf.PDFDocument, request: SearchRequest): SearchResult {
  const t0 = performance.now();
  const { query } = request;
  const pageCount = doc.countPages();
  const startPage = request.startPage ?? 0;
  const maxHits = request.maxHits ?? DEFAULT_MAX_HITS;
  assertInteger('maxHits', maxHits, 1);
  if (pageCount > 0) {
    assertInteger('startPage', startPage, 0);
    if (startPage >= pageCount) {
      throw new RangeError(`startPage 가 쪽 수(${pageCount}) 밖: ${startPage}`);
    }
  }
  const pageLimit = Math.min(request.pageLimit ?? pageCount, pageCount);
  assertInteger('pageLimit', pageLimit, 0);

  const result: SearchResult = { query, hits: [], truncated: false, pagesSearched: 0, searchMs: 0 };
  if (query.length > 0) {
    // MuPDF search option: the default (no option) is case-sensitive, 'ignore-case' ignores case.
    const options = request.caseSensitive ? undefined : 'ignore-case';
    search: for (let k = 0; k < pageLimit; k++) {
      const pageIndex = (startPage + k) % pageCount;
      const page = doc.loadPage(pageIndex);
      let found: Quad[][];
      try {
        found = page.search(query, options) as Quad[][];
      } finally {
        page.destroy();
      }
      result.pagesSearched++;
      const quadCount = found.reduce((n, quads) => n + quads.length, 0);
      if (quadCount >= MUPDF_PAGE_QUAD_CAP) result.truncated = true;
      for (const quads of found) {
        if (result.hits.length >= maxHits) {
          result.truncated = true;
          break search;
        }
        const hit: SearchHit = { pageIndex, quads };
        result.hits.push(hit);
      }
    }
  }
  result.searchMs = performance.now() - t0;
  return result;
}
