/**
 * 편집 제한 사유·편집 경고 문구를 화면 언어로 고른다. 표는 labels-data.ts, 언어는 `ViewerStrings`(strings.ts).
 *
 * core·pdf-ops 가 만드는 사유 설명(`ParagraphLimit.detail`·`PathLimit.detail`)과 경고 문장(`EditWarning.message`)은
 * 한국어다. 한국어 화면은 그 문장을 그대로 쓰고(더 구체적인 진단 정보 포함), 영어 화면은 사유 코드·경고 종류·수치로
 * 표에서 문장을 만든다(사용자 결정 2026-10-26).
 */
import type { EditWarning } from '@pdf-editor/shared-types';
import type { WarningTextKey } from './labels-data.js';
import { VIEWER_STRINGS, type ViewerStrings } from './strings.js';

export * from './labels-data.js';

/** 사유 코드 → 화면 언어 문구. 표에 없는 코드는 "편집할 수 없습니다 (코드)". */
export function limitLabel(reason: string, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  return (t.limitLabels as Record<string, string>)[reason] ?? t.limitUnknown(reason);
}

/**
 * 제한 목록 → 팝오버·패스 패널 문구(중복 제거). 한국어 화면은 core 설명(detail)이 있으면 그것을, 영어 화면은 사유 코드
 * 문구를 쓴다. 비어 있으면 fallback 한 줄.
 */
export function limitItems(
  limits: readonly { reason: string; detail: string }[],
  fallback: string,
  t: ViewerStrings = VIEWER_STRINGS.ko,
): string[] {
  const items = limits.map((l) =>
    t.lang === 'ko' && l.detail !== '' ? l.detail : limitLabel(l.reason, t),
  );
  return items.length > 0 ? [...new Set(items)] : [fallback];
}

/** 편집 경고 → 화면 언어 문장. 한국어 화면은 core 문장(message)이 있으면 그대로, 영어 화면은 종류·수치로 만든다. */
export function warningText(w: EditWarning, t: ViewerStrings = VIEWER_STRINGS.ko): string {
  if (t.lang === 'ko' && w.message !== '') return w.message;
  const key = (w.variant ? `${w.kind}:${w.variant}` : w.kind) as WarningTextKey;
  const text = t.warningTexts[key] ?? t.warningTexts[w.kind];
  return text ? text(w.count ?? w.rects.length, w.chars ?? '') : w.message || w.kind;
}
