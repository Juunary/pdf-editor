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

describe('검색 탐색 상태', () => {
  it('결과를 반영하면 0번 결과가 현재 결과', () => {
    const s = applySearchResult(initialFindState(), result([3, 3, 7, 0]), 3);
    expect(s.status).toBe('done');
    expect(s.current).toBe(0);
    expect(s.startPage).toBe(3);
    expect(currentHit(s)?.pageIndex).toBe(3);
  });

  it('결과 없음: current -1, 라벨 "결과 없음", 이동은 제자리', () => {
    const s = applySearchResult(initialFindState(), result([]), 0);
    expect(s.current).toBe(-1);
    expect(findLabel(s)).toBe('결과 없음');
    expect(stepHit(s, 1)).toBe(s);
    expect(currentHit(s)).toBeNull();
  });

  it('다음·이전은 순환한다', () => {
    let s = applySearchResult(initialFindState(), result([0, 1, 2]), 0);
    s = stepHit(s, 1);
    expect(s.current).toBe(1);
    s = stepHit(stepHit(s, 1), 1);
    expect(s.current).toBe(0); // 2 → 0
    s = stepHit(s, -1);
    expect(s.current).toBe(2); // 0 → 2
  });

  it('현재 결과가 없는 상태(-1)에서도 다음은 0번, 이전은 마지막', () => {
    const base = { ...applySearchResult(initialFindState(), result([0, 1, 2]), 0), current: -1 };
    expect(stepHit(base, 1).current).toBe(0);
    expect(stepHit(base, -1).current).toBe(2);
  });

  it('hitsOnPage 는 전체 인덱스와 현재 여부를 돌려준다', () => {
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

  it('라벨: 위치/총수, 잘렸으면 +', () => {
    let s = applySearchResult(initialFindState(), result([0, 1, 2]), 0);
    expect(findLabel(s)).toBe('1 / 3');
    s = stepHit(s, -1);
    expect(findLabel(s)).toBe('3 / 3');
    s = applySearchResult(initialFindState(), result([0, 1], true), 0);
    expect(findLabel(s)).toBe('1 / 2+');
  });

  it('상태별 라벨', () => {
    const base = initialFindState();
    expect(findLabel(base)).toBe('');
    expect(findLabel({ ...base, status: 'searching' })).toBe('검색 중');
    expect(findLabel({ ...base, status: 'unavailable', message: '사용 불가' })).toBe('사용 불가');
    expect(findLabel({ ...base, status: 'error', message: null })).toBe('검색 실패');
  });

  it('clearResults 는 질의·옵션·열림 상태를 유지한다', () => {
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
