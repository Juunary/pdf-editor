/**
 * Search navigation state (pure functions). The result order of `searchText` is "from the start page to the end of the document, then from page 0",
 * so result 0 is the first result encountered from the current page. Previous/next cycle through the result list.
 */
import type { SearchHit, SearchResult } from '@pdf-editor/shared-types';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';

export type FindStatus = 'idle' | 'searching' | 'done' | 'unavailable' | 'error';

export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  status: FindStatus;
  hits: SearchHit[];
  truncated: boolean;
  /** hits index. -1 if there are no results. */
  current: number;
  /** The page where the search was last started. */
  startPage: number;
  /** Text to show when status is unavailable or error. */
  message: string | null;
  /** Each time it increases, the search bar focuses and selects all of the input field (including a repeated Ctrl+F). */
  focusToken: number;
}

export function initialFindState(): FindState {
  return {
    open: false,
    query: '',
    caseSensitive: false,
    status: 'idle',
    hits: [],
    truncated: false,
    current: -1,
    startPage: 0,
    message: null,
    focusToken: 0,
  };
}

/** Applies search results. Sets result 0 (the first result encountered from the start page) as the current result. */
export function applySearchResult(
  state: FindState,
  result: SearchResult,
  startPage: number,
): FindState {
  return {
    ...state,
    status: 'done',
    hits: result.hits,
    truncated: result.truncated,
    current: result.hits.length > 0 ? 0 : -1,
    startPage,
    message: null,
  };
}

/** Clears results (query change, closing the bar). The query, options and open state are kept. */
export function clearResults(state: FindState): FindState {
  return { ...state, status: 'idle', hits: [], truncated: false, current: -1, message: null };
}

/** Previous (-1) / next (+1). Cycles through the result list. Unchanged if there are no results. */
export function stepHit(state: FindState, delta: number): FindState {
  const n = state.hits.length;
  if (n === 0) return state;
  const base = state.current < 0 ? (delta > 0 ? -1 : 0) : state.current;
  const next = (((base + delta) % n) + n) % n;
  return { ...state, current: next };
}

export function currentHit(state: FindState): SearchHit | null {
  return state.hits[state.current] ?? null;
}

export interface PageHit {
  /** FindState.hits index. */
  index: number;
  hit: SearchHit;
  current: boolean;
}

/** Results on one page (for highlighting). */
export function hitsOnPage(state: FindState, pageIndex: number): PageHit[] {
  const out: PageHit[] = [];
  state.hits.forEach((hit, index) => {
    if (hit.pageIndex === pageIndex) out.push({ index, hit, current: index === state.current });
  });
  return out;
}

/** "3 / 12", "3 / 1000+" if truncated, and "결과 없음" (`t.findNoResults`) if there are no results. */
export function findLabel(state: FindState, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  switch (state.status) {
    case 'searching':
      return t.findSearching;
    case 'unavailable':
      return state.message ?? t.findUnavailable;
    case 'error':
      return state.message ?? t.findFailed;
    case 'done':
      return state.hits.length === 0
        ? t.findNoResults
        : `${state.current + 1} / ${state.hits.length}${state.truncated ? '+' : ''}`;
    default:
      return '';
  }
}
