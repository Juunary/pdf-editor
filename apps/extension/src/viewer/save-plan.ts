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
 * - core 저장 경고(`SavePlan.warnings`, 편집 엔진 실패 상태 저장 등)는 확인 창(맨 앞). 한국어는 core 문장 그대로, 영어는
 *   원인 코드(`SavePlan.warningCodes`)로 문장을 만든다(코드가 없으면 일반 문장, 사용자 결정 2026-10-26).
 * - 편집이 있으면 "편집한 쪽 번호가 파일 정보에 기록됨" 안내(확인 창이 뜰 때 함께 보인다).
 * - core 저널 상한 판정(`journalAdvice` RPC, 계약 D4)이 `advised` 이면 저장할 수 있을 때는 "저장 후 다시 열기" 권고를,
 *   중단할 때는 편집 기록 크기를 붙인다. 경고선은 core 가 정하고(저장 힙 warn 경계), 여기서는 따로 값을 두지 않는다.
 *   힙 판정 문구(`heap.message`)에는 권고가 없다(core 가 붙이지 않음).
 */
import type { JournalAdvice, SavePlan } from '@pdf-editor/shared-types';
import { APP_STRINGS, type AppStrings } from './strings.js';

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

const KO = APP_STRINGS.ko;

/** 편집 기록(저널)이 메모리를 차지해 한계에 가까울 때의 권고(D4, 한국어). 저장할 수 있는 상태에서만 쓴다. */
export const JOURNAL_REOPEN_ADVICE = KO.journalReopenAdvice;

/** 저장을 중단할 때 할 수 있는 일(한국어). */
export const BLOCKED_SAVE_OPTIONS = KO.blockedSaveOptions;

/** over-limit 의 근거가 이미 커진 힙일 때 "그래도 저장 시도" 확인 창 안내(한국어). */
export const GROWN_HEAP_RETRY_NOTE = KO.grownHeapRetryNote;

/** "그래도 저장 시도" 버튼 이름(한국어). */
export const RETRY_SAVE_LABEL = KO.retrySaveLabel;

/**
 * 저장 전 판정. `journal` 은 core 저널 상한 판정(`journalAdvice` RPC) 결과이며, 받지 못했으면 null(권고 없음).
 * 문구는 `t`(기본 한국어). core 힙 문구(`heap.message`)는 한국어라 한국어일 때만 쓰고, 영어는 수치로 문구를 만든다.
 */
export function decideSave(
  plan: SavePlan,
  journal: JournalAdvice | null = null,
  t: AppStrings = KO,
): SaveDecision {
  const coreMessage = t.lang === 'ko' ? plan.heap.message : null;
  const warnings: string[] = coreSaveWarnings(plan, t);
  const infos: string[] = [];
  const { heap, edits } = plan;
  const advised = journal?.advised === true;
  let confirmLabel: string | undefined;
  if (heap.level === 'over-limit') {
    const base = coreMessage ?? t.heapOverLimit(mib(heap.limitBytes), mib(heap.estimatedPeakBytes));
    if (heap.grownHeapBasis) {
      warnings.unshift(base, t.grownHeapRetryNote);
      confirmLabel = t.retrySaveLabel;
    } else {
      const journalNote = advised ? t.journalHeld(mib(journal?.journalBytes ?? 0)) : '';
      return { block: `${base}${journalNote} ${t.blockedSaveOptions}`, warnings, infos };
    }
  }
  if (heap.level === 'warn') {
    warnings.push(coreMessage ?? t.heapWarn(mib(heap.estimatedPeakBytes), mib(heap.limitBytes)));
  }
  const advice = advised ? t.journalReopenAdvice : null;
  if (advice) infos.push(advice);
  if (edits) {
    if (edits.structureUnlinked > 0) {
      warnings.push(t.structureUnlinked(edits.structureUnlinked));
    }
    if (edits.pdfaDeclared) {
      warnings.push(t.pdfaDeclared);
    }
    if (edits.pages.length > 0) {
      infos.push(t.editPagesRecorded(edits.pages.map((p) => p + 1).join(', ')));
    }
  }
  return { block: null, warnings, infos, ...(confirmLabel ? { confirmLabel } : {}) };
}

/** core 저장 경고 문장. 한국어는 `warnings` 그대로, 영어는 `warningCodes` 로 만든다. */
function coreSaveWarnings(plan: SavePlan, t: AppStrings): string[] {
  const core = plan.warnings ?? [];
  if (t.lang === 'ko' || core.length === 0) return [...core];
  const codes = plan.warningCodes ?? [];
  return codes.length > 0 ? codes.flatMap((c) => t.saveWarnings[c]) : [t.saveWarningUnknown];
}
