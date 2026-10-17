import type { ChangeKind, SaveMethod } from '@pdf-editor/shared-types';

export interface SaveDecision {
  method: SaveMethod;
  /** MuPDF `PDFDocument.saveToBuffer` 옵션 문자열. */
  options: string;
  reason: string;
}

/** 전체 저장 옵션. 미사용 객체 제거·번호 압축 + 스트림 압축. */
export const FULL_SAVE_OPTIONS = 'garbage=compact,compress';
export const INCREMENTAL_SAVE_OPTIONS = 'incremental';

/** 증분 저장을 허용하는 변경 유형. 텍스트·스트림 교체는 이전 리비전에 원문이 남으므로 제외한다. */
const INCREMENTAL_SAFE: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['annotation', 'metadata']);

/**
 * 변경 유형과 `canBeSavedIncrementally()` 결과로 저장 방식을 정한다(PLAN.md 3.1).
 * - redaction 포함 → 전체 저장
 * - 엔진이 증분 저장 불가로 판단 → 전체 저장
 * - 주석·메타데이터만 변경 → 증분 저장
 * - 그 외(콘텐츠 스트림 교체, 폰트 임베딩) → 전체 저장
 */
export function decideSaveMethod(
  changes: readonly ChangeKind[],
  canBeSavedIncrementally: boolean,
): SaveDecision {
  const full = (reason: string): SaveDecision => ({
    method: 'full',
    options: FULL_SAVE_OPTIONS,
    reason,
  });
  if (changes.includes('redaction')) return full('redaction 적용 문서는 증분 저장 불가');
  if (!canBeSavedIncrementally) return full('canBeSavedIncrementally() = false');
  const unsafe = changes.filter((c) => !INCREMENTAL_SAFE.has(c));
  if (unsafe.length > 0) return full(`증분 저장 비대상 변경: ${unsafe.join(', ')}`);
  return {
    method: 'incremental',
    options: INCREMENTAL_SAVE_OPTIONS,
    reason: changes.length === 0 ? '변경 없음' : '주석·메타데이터 변경만 포함',
  };
}
