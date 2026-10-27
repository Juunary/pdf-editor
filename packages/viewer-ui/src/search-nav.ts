/**
 * 검색 탐색 상태(순수 함수). `searchText` 결과의 결과 순서는 "시작 페이지부터 문서 끝, 이어서 0 페이지부터"
 * 이므로 0번 결과가 현재 페이지에서 처음 만나는 결과다. 이전·다음은 결과 목록을 순환한다.
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
  /** hits 인덱스. 결과가 없으면 -1. */
  current: number;
  /** 마지막으로 검색을 시작한 페이지. */
  startPage: number;
  /** status 가 unavailable·error 일 때 표시 문구. */
  message: string | null;
  /** 증가할 때마다 검색창이 입력란에 포커스·전체 선택한다(Ctrl+F 재입력 포함). */
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

/** 검색 결과를 반영한다. 0번 결과(시작 페이지에서 처음 만나는 결과)를 현재 결과로 둔다. */
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

/** 결과 지우기(질의 변경·창 닫기). 질의·옵션·열림 상태는 유지한다. */
export function clearResults(state: FindState): FindState {
  return { ...state, status: 'idle', hits: [], truncated: false, current: -1, message: null };
}

/** 이전(-1)·다음(+1). 결과 목록을 순환한다. 결과가 없으면 그대로. */
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
  /** FindState.hits 인덱스. */
  index: number;
  hit: SearchHit;
  current: boolean;
}

/** 한 페이지에 있는 결과들(하이라이트용). */
export function hitsOnPage(state: FindState, pageIndex: number): PageHit[] {
  const out: PageHit[] = [];
  state.hits.forEach((hit, index) => {
    if (hit.pageIndex === pageIndex) out.push({ index, hit, current: index === state.current });
  });
  return out;
}

/** "3 / 12", 잘렸으면 "3 / 1000+", 결과가 없으면 "결과 없음"(`t.findNoResults`). */
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
