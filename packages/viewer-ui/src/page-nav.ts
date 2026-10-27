/** 페이지 이동 계산(순수 함수). 페이지 번호는 화면에서 1부터, 내부 인덱스는 0부터. */

export function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(pageCount - 1, Math.max(0, Math.trunc(index)));
}

/** 이전·다음 이동. 범위를 벗어나면 제자리. */
export function stepPage(current: number, delta: number, pageCount: number): number {
  return clampPage(current + delta, pageCount);
}

/**
 * 입력창 문자열(1부터)을 페이지 인덱스로. 정수가 아니거나 1–pageCount 밖이면 null.
 * 공백은 허용하고, 부호·소수점·문자가 섞인 입력은 거부한다.
 */
export function parsePageInput(text: string, pageCount: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < 1 || n > pageCount) return null;
  return n - 1;
}

export function canStep(current: number, delta: number, pageCount: number): boolean {
  const next = current + delta;
  return next >= 0 && next < pageCount;
}

/** 좌우 화살표·툴바 버튼의 비활성 상태. 첫 쪽은 이전, 마지막 쪽은 다음이 비활성이다. */
export function navDisabled(current: number, pageCount: number): { prev: boolean; next: boolean } {
  return { prev: !canStep(current, -1, pageCount), next: !canStep(current, 1, pageCount) };
}

/**
 * 좌우 화살표 한 줄의 가로 자리(CSS px). 칸은 버튼 너비 48 + 양옆 간격 3·3 = 54(style.css `.pe-arrow-slot`)이고, 쪽
 * 비트맵 폭 올림(최대 1 px)으로 가로 넘침이 생기지 않게 2 px 여유를 더한다. 뷰어는 가용 너비에서 양쪽 몫을 뺀다.
 */
export const PAGE_ARROW_GUTTER = 56;

/** 쪽 최소 CSS 폭(`fitWidthScale` 의 minWidth 기본값과 같다). */
export const MIN_PAGE_CSS_WIDTH = 320;
/** 문서 영역 좌우 여백 합(`fitWidthScale` 의 margin 기본값 = 문서 영역 안쪽 여백 16·16). */
export const PAGE_AREA_MARGIN = 32;

/**
 * 화살표 자리. side: 쪽 좌우 바깥 칸(쪽과 겹치지 않는다). overlay: 좌우 칸 자리가 없는 좁은 창에서 칸을 레이아웃에서
 * 빼고(폭 0) 두 화살표를 문서 영역 좌우 가장자리 안쪽, 쪽 가장자리 위에 겹쳐 띄운다(사용자 결정 2026-10-26 변경:
 * 겹칠 수밖에 없으면 겹친다, docs/m5-release.md 10.3).
 */
export type PageArrowPlacement = 'side' | 'overlay';

export interface PageArrowLayout {
  placement: PageArrowPlacement;
  /** 쪽 맞춤에 쓸 가용 폭(`ViewerEnvironment.availableWidth`). side 면 좌우 칸 몫을 뺀다. */
  availableWidth: number;
}

/**
 * 문서 영역 폭(스크롤 상자의 clientWidth, 안쪽 여백 포함·스크롤바 제외)으로 화살표 자리와 쪽 맞춤 폭을 정한다.
 * 좌우 칸 두 몫과 여백을 빼고도 쪽 최소 폭이 남으면(폭 ≥ 320 + 2×56 + 32 = 464) side, 아니면 overlay(칸 몫을 빼지 않아
 * 쪽이 그만큼 넓어진다). 표시(마운트가 `data-pe-arrows` 로 붙임)와 쪽 맞춤(호스트의 getEnvironment)이 같은 함수를 쓴다.
 */
export function pageArrowLayout(containerWidth: number): PageArrowLayout {
  const side = containerWidth - 2 * PAGE_ARROW_GUTTER - PAGE_AREA_MARGIN >= MIN_PAGE_CSS_WIDTH;
  return side
    ? { placement: 'side', availableWidth: containerWidth - 2 * PAGE_ARROW_GUTTER }
    : { placement: 'overlay', availableWidth: containerWidth };
}
