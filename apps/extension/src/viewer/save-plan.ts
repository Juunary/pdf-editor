/**
 * 저장 전 판정 해석(계약 5.8, A3-2). `planSave` 결과로 저장을 막을지, 확인을 받을지 정한다.
 *
 * - 힙 `over-limit`: 저장하지 않고 안내(중단). 할 수 있는 일(다시 열면 메모리가 정리되지만 저장하지 않은 편집은 사라짐)을 함께
 *   알린다. 저장할 수 없는 상태이므로 "저장 후 다시 열기" 는 권하지 않는다.
 * - 힙 `over-limit` 이라도 판정 근거가 이미 커진 힙(`heap.grownHeapBasis`)이면 "그래도 저장 시도" 확인 창. WASM 선형 메모리는
 *   줄지 않아 그 안의 빈 공간을 다시 쓰므로 실제 저장은 성공할 수 있고, 실패하면 Worker 복구 뒤 다시 묻는다.
 * - 힙 `warn`: 확인 창.
 * - 태그 쪽 편집에서 구조 연결이 끊긴 문단이 있으면 확인 창(D1).
 * - PDF/A 선언 문서의 편집은 "적합성이 깨질 수 있음" 확인 창(5.6).
 * - core 저장 경고(`SavePlan.warnings`, 편집 엔진 실패 상태 저장 등)는 확인 창(맨 앞).
 * - 편집이 있으면 "편집한 쪽 번호가 파일 정보에 기록됨" 안내(확인 창이 뜰 때 함께 보인다).
 * - core 저널 상한 판정(`journalAdvice` RPC, 계약 D4)이 `advised` 이면 저장할 수 있을 때는 "저장 후 다시 열기" 권고를,
 *   중단할 때는 편집 기록 크기를 붙인다. 경고선은 core 가 정하고(저장 힙 warn 경계), 여기서는 따로 값을 두지 않는다.
 *   힙 판정 문구(`heap.message`)에는 권고가 없다(core 가 붙이지 않음).
 */
import type { JournalAdvice, SavePlan } from '@pdf-editor/shared-types';

export interface SaveDecision {
  /** 중단 사유(있으면 저장하지 않는다). */
  block: string | null;
  /** 확인이 필요한 경고. 비어 있지 않으면 확인 창을 띄운다. */
  warnings: string[];
  /** 확인 창에 함께 보여 주는 안내(그것만으로는 확인 창을 띄우지 않는다). */
  infos: string[];
  /** 확인 창의 확인 버튼 이름. 없으면 "저장". */
  confirmLabel?: string;
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

/** 편집 기록(저널)이 메모리를 차지해 한계에 가까울 때의 권고(D4). 저장할 수 있는 상태에서만 쓴다. */
export const JOURNAL_REOPEN_ADVICE =
  '편집 기록이 메모리를 많이 차지하고 있습니다. 먼저 저장하고 파일을 다시 열면 편집 기록이 정리되어 메모리가 줄어듭니다(다시 연 뒤에는 이전 편집을 되돌릴 수 없습니다).';

/** 저장을 중단할 때 할 수 있는 일. */
export const BLOCKED_SAVE_OPTIONS =
  '저장하지 않았습니다. 파일을 다시 열면 메모리가 정리되지만 저장하지 않은 편집은 모두 사라집니다.';

/** over-limit 의 근거가 이미 커진 힙일 때 "그래도 저장 시도" 확인 창 안내. */
export const GROWN_HEAP_RETRY_NOTE =
  '예상이 큰 주된 이유는 앞선 저장·쪽 보기로 이미 커진 작업 메모리입니다. 작업 메모리는 줄지 않지만 그 안의 빈 공간을 다시 쓰므로 실제로는 저장될 수 있습니다. 저장 중 메모리가 부족하면 작업 모듈을 복구하고 다시 저장할지 묻습니다(복구 전 되돌리기 기록은 사라집니다).';

/** "그래도 저장 시도" 버튼 이름. */
export const RETRY_SAVE_LABEL = '그래도 저장 시도';

/**
 * 저장 전 판정. `journal` 은 core 저널 상한 판정(`journalAdvice` RPC) 결과이며, 받지 못했으면 null(권고 없음).
 */
export function decideSave(plan: SavePlan, journal: JournalAdvice | null = null): SaveDecision {
  const warnings: string[] = [...(plan.warnings ?? [])];
  const infos: string[] = [];
  const { heap, edits } = plan;
  const advised = journal?.advised === true;
  let confirmLabel: string | undefined;
  if (heap.level === 'over-limit') {
    const base =
      heap.message ??
      `저장 중 메모리가 한계(${mib(heap.limitBytes)})를 넘을 것으로 예상됩니다 (예상 피크 ${mib(heap.estimatedPeakBytes)}).`;
    if (heap.grownHeapBasis) {
      warnings.unshift(base, GROWN_HEAP_RETRY_NOTE);
      confirmLabel = RETRY_SAVE_LABEL;
    } else {
      const journalNote = advised
        ? ` 편집 기록이 약 ${mib(journal?.journalBytes ?? 0)} 를 차지하고 있습니다.`
        : '';
      return { block: `${base}${journalNote} ${BLOCKED_SAVE_OPTIONS}`, warnings, infos };
    }
  }
  if (heap.level === 'warn') {
    warnings.push(
      heap.message ??
        `저장 중 메모리를 많이 쓸 것으로 예상됩니다 (예상 피크 ${mib(heap.estimatedPeakBytes)} / 한계 ${mib(heap.limitBytes)}). 저장이 실패하면 작업 모듈을 복구하고 다시 저장할지 묻습니다.`,
    );
  }
  const advice = advised ? JOURNAL_REOPEN_ADVICE : null;
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
  return { block: null, warnings, infos, ...(confirmLabel ? { confirmLabel } : {}) };
}
