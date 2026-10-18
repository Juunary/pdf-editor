import type * as mupdf from 'mupdf';
import type { Quad, SearchHit, SearchRequest, SearchResult } from '@pdf-editor/shared-types';

export const DEFAULT_MAX_HITS = 1000;

/** mupdf.js `runSearch` 가 한 쪽에서 돌려주는 사각형(quad) 수의 상한. 넘으면 그 쪽 결과는 잘렸을 수 있다. */
export const MUPDF_PAGE_QUAD_CAP = 500;

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} 는 ${min} 이상의 정수여야 함: ${value}`);
  }
}

/**
 * 문서 텍스트 검색. `startPage` 부터 끝 쪽까지 간 뒤 0 쪽으로 돌아 `pageLimit` 쪽까지 본다.
 * 결과는 검색한 쪽 순서이고, 한 쪽 안에서는 MuPDF 결과 순서다. 기본은 대소문자를 구분한다.
 *
 * `truncated` 는 maxHits 를 넘는 결과가 더 있거나, 한 쪽의 결과가 MuPDF 쪽 상한(500 quad)에
 * 닿아 잘렸을 수 있을 때 true 다.
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
    // MuPDF 검색 옵션: 기본(옵션 없음)이 대소문자 구분, 'ignore-case' 가 무시.
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
