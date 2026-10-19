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
