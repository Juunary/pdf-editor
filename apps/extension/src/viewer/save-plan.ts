/**
 * 저장 전 판정 해석(계약 5.8, A3-2). `planSave` 결과로 저장을 막을지, 확인을 받을지 정한다.
 *
 * - 힙 `over-limit`: 저장하지 않고 안내(중단).
 * - 힙 `warn`: 확인 창.
 * - 태그 쪽 편집에서 구조 연결이 끊긴 문단이 있으면 확인 창(D1).
 * - PDF/A 선언 문서의 편집은 "적합성이 깨질 수 있음" 확인 창(5.6).
 * - core 저장 경고(`SavePlan.warnings`, 편집 엔진 실패 상태 저장 등)는 확인 창(맨 앞).
 * - 편집이 있으면 "편집한 쪽 번호가 파일 정보에 기록됨" 안내(확인 창이 뜰 때 함께 보인다).
 * - 힙이 ok 가 아닌데 core 가 저널 보유 추정(`journalBytes`)을 주면 "저장 후 다시 열기" 권고를 붙인다(계약 D4).
 *   경고선은 core 의 힙 판정이 정하고, 여기서는 따로 값을 두지 않는다.
 */
import type { SavePlan } from '@pdf-editor/shared-types';

export interface SaveDecision {
  /** 중단 사유(있으면 저장하지 않는다). */
  block: string | null;
  /** 확인이 필요한 경고. 비어 있지 않으면 확인 창을 띄운다. */
  warnings: string[];
  /** 확인 창에 함께 보여 주는 안내(그것만으로는 확인 창을 띄우지 않는다). */
  infos: string[];
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

/** 편집 기록(저널)이 메모리를 차지해 한계에 가까울 때의 권고(D4). */
export const JOURNAL_REOPEN_ADVICE =
  '편집 기록이 메모리를 많이 차지하고 있습니다. 먼저 저장하고 파일을 다시 열면 편집 기록이 정리되어 메모리가 줄어듭니다(다시 연 뒤에는 이전 편집을 되돌릴 수 없습니다).';

function journalAdvice(heap: SavePlan['heap']): string | null {
  return heap.level !== 'ok' && (heap.journalBytes ?? 0) > 0 ? JOURNAL_REOPEN_ADVICE : null;
}

export function decideSave(plan: SavePlan): SaveDecision {
  const warnings: string[] = [...(plan.warnings ?? [])];
  const infos: string[] = [];
  const { heap, edits } = plan;
  const advice = journalAdvice(heap);
  if (heap.level === 'over-limit') {
    const base =
      heap.message ??
      `저장 중 메모리가 한계(${mib(heap.limitBytes)})를 넘을 것으로 예상되어 저장하지 않습니다 (예상 피크 ${mib(heap.estimatedPeakBytes)}).`;
    return { block: advice ? `${base} ${advice}` : base, warnings, infos };
  }
  if (heap.level === 'warn') {
    warnings.push(
      heap.message ??
        `저장 중 메모리를 많이 쓸 것으로 예상됩니다 (예상 피크 ${mib(heap.estimatedPeakBytes)} / 한계 ${mib(heap.limitBytes)}). 저장이 실패하면 작업 모듈을 복구하고 다시 저장할지 묻습니다.`,
    );
  }
  if (advice) infos.push(advice);
  if (edits) {
    if (edits.structureUnlinked > 0) {
      warnings.push(
        `태그된 PDF 쪽에서 편집한 문단 ${edits.structureUnlinked}개는 구조(읽기 순서·태그)와의 연결이 끊어집니다.`,
      );
    }
    if (edits.pdfaDeclared) {
      warnings.push('이 문서는 PDF/A 로 선언되어 있어 편집하면 PDF/A 적합성이 깨질 수 있습니다.');
    }
    if (edits.pages.length > 0) {
      infos.push(
        `저장하면 편집한 쪽 번호(${edits.pages.map((p) => p + 1).join(', ')}쪽)가 파일 정보(PdfEditorEdits)에 기록됩니다.`,
      );
    }
  }
  return { block: null, warnings, infos };
}
