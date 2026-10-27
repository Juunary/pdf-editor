import { describe, expect, it } from 'vitest';
import type { SearchResult } from '@pdf-editor/shared-types';
import {
  applySearchResult,
  clearResults,
  currentHit,
  findLabel,
  hitsOnPage,
  initialFindState,
  stepHit,
} from '../src/search-nav.js';
import { rectQuad } from './fixtures.js';

function result(pages: number[], truncated = false): SearchResult {
  return {
    query: 'q',
    hits: pages.map((pageIndex) => ({ pageIndex, quads: [rectQuad(0, 0, 10, 10)] })),
    truncated,
    pagesSearched: 10,
    searchMs: 1,
  };
}

describe('search navigation state', () => {
  it('after applying results, result 0 is the current result', () => {
    const s = applySearchResult(initialFindState(), result([3, 3, 7, 0]), 3);
    expect(s.status).toBe('done');
    expect(s.current).toBe(0);
    expect(s.startPage).toBe(3);
    expect(currentHit(s)?.pageIndex).toBe(3);
  });

  it('no results: current -1, label "결과 없음", navigation stays in place', () => {
    const s = applySearchResult(initialFindState(), result([]), 0);
    expect(s.current).toBe(-1);
    expect(findLabel(s)).toBe('결과 없음');
    expect(stepHit(s, 1)).toBe(s);
    expect(currentHit(s)).toBeNull();
  });

  it('next and previous wrap around', () => {
    let s = applySearchResult(initialFindState(), result([0, 1, 2]), 0);
    s = stepHit(s, 1);
    expect(s.current).toBe(1);
    s = stepHit(stepHit(s, 1), 1);
    expect(s.current).toBe(0); // 2 → 0
    s = stepHit(s, -1);
    expect(s.current).toBe(2); // 0 → 2
  });

  it('even with no current result (-1), next goes to 0 and previous to the last', () => {
    const base = { ...applySearchResult(initialFindState(), result([0, 1, 2]), 0), current: -1 };
    expect(stepHit(base, 1).current).toBe(0);
    expect(stepHit(base, -1).current).toBe(2);
  });

  it('hitsOnPage returns the global index and whether it is current', () => {
    let s = applySearchResult(initialFindState(), result([3, 3, 7]), 3);
    s = stepHit(s, 1);
    const onThree = hitsOnPage(s, 3);
    expect(onThree.map((h) => [h.index, h.current])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(hitsOnPage(s, 7).map((h) => h.index)).toEqual([2]);
    expect(hitsOnPage(s, 9)).toEqual([]);
  });

  it('label: position/total, + if truncated', () => {
    let s = applySearchResult(initialFindState(), result([0, 1, 2]), 0);
    expect(findLabel(s)).toBe('1 / 3');
    s = stepHit(s, -1);
    expect(findLabel(s)).toBe('3 / 3');
    s = applySearchResult(initialFindState(), result([0, 1], true), 0);
    expect(findLabel(s)).toBe('1 / 2+');
  });

  it('labels per status', () => {
    const base = initialFindState();
    expect(findLabel(base)).toBe('');
    expect(findLabel({ ...base, status: 'searching' })).toBe('검색 중');
    expect(findLabel({ ...base, status: 'unavailable', message: '사용 불가' })).toBe('사용 불가');
    expect(findLabel({ ...base, status: 'error', message: null })).toBe('검색 실패');
  });

  it('clearResults keeps the query, options and open state', () => {
    const open = {
      ...applySearchResult(initialFindState(), result([1]), 0),
      open: true,
      query: 'abc',
      caseSensitive: true,
    };
    const cleared = clearResults(open);
    expect(cleared).toMatchObject({
      open: true,
      query: 'abc',
      caseSensitive: true,
      status: 'idle',
      hits: [],
      current: -1,
    });
  });
});
