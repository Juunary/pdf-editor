import { SUPPORTED_INPUT_BYTES } from '@pdf-editor/core/client';
import type { JournalAdvice, SaveHeapEstimate } from '@pdf-editor/shared-types';
import { APP_STRINGS, type AppStrings } from './strings.js';

/**
 * 뷰어 알림(문서 열기 직후 보고·안내) 문구 구성(순수). 표시는 main.ts 의 알림 줄이 한다. 문구는 `t`(기본 한국어,
 * strings.ts)에서 온다.
 */
const KO = APP_STRINGS.ko;

export interface RedactReportLike {
  total: number;
  /** Redact 주석이 있는 쪽(0부터). */
  pages: number[];
}

/** 열기 시 Redact 주석 보고(A2-2): 적용 대기 중인 가림 표시가 있다는 안내. 없으면 null. */
export function redactNotice(report: RedactReportLike | null, t: AppStrings = KO): string | null {
  if (!report || report.total <= 0) return null;
  const pages = report.pages.map((p) => p + 1).join(', ');
  return t.redactNotice(report.total, pages);
}

export interface FileAccessInput {
  /** 가로채기 방식: MIME handler 는 file:// 접근 설정과 무관하다. */
  mode: 'mime-handler' | 'dnr-fallback' | 'unsupported';
  /** `chrome.extension.isAllowedFileSchemeAccess()` 결과. 알 수 없으면 null. */
  fileAccessAllowed: boolean | null;
  /** 열린 문서의 표시 URL(없으면 null: 직접 연 뷰어). */
  displayUrl: string | null;
  extensionId: string;
}

/**
 * DNR 폴백(Chrome 128–149)은 file:// PDF 를 "파일 URL에 대한 액세스 허용" 이 켜져 있어야 가로챈다(A5-3, 코퍼스 C10).
 * 꺼져 있으면 file:// PDF 는 Chrome 기본 뷰어로 열리므로, 이 뷰어에서 안내한다.
 * 직접 연 뷰어이거나 file:// 문서를 열 때 보여 준다. 해당 없으면 null.
 */
export function fileAccessNotice(input: FileAccessInput, t: AppStrings = KO): string | null {
  if (input.mode !== 'dnr-fallback' || input.fileAccessAllowed !== false) return null;
  if (input.displayUrl !== null && !input.displayUrl.startsWith('file:')) return null;
  return t.fileAccessNotice(input.extensionId);
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

/**
 * 지원 문서 크기 상한 안내(PLAN.md 7절 리스크 8). 예상 저장 피크가 core 가 정한 경고선·한계를 넘으면
 * "편집·저장이 실패할 수 있음" 을 알린다. 값(경고선·한계)은 core 의 `SaveHeapEstimate` 를 그대로 쓴다.
 */
export function sizeLimitNotice(
  heap: SaveHeapEstimate | null | undefined,
  t: AppStrings = KO,
): string | null {
  if (!heap || heap.level === 'ok') return null;
  const figures = t.sizeFigures(mib(heap.estimatedPeakBytes), mib(heap.limitBytes));
  return heap.level === 'over-limit' ? t.sizeOverLimitNotice(figures) : t.sizeWarnNotice(figures);
}

/**
 * 지원 문서 크기 상한 안내(리스크 8, docs/m5-heap.md 6절): 열린 문서의 바이트 수가 core 의 `SUPPORTED_INPUT_BYTES`
 * (이미지 위주 문서를 열자마자 편집 후 전체 저장할 때 예상 피크가 상한을 넘기 시작하는 크기)를 넘으면 알린다. 넘지 않으면 null.
 */
export function supportedSizeNotice(
  byteLength: number,
  limitBytes: number = SUPPORTED_INPUT_BYTES,
  t: AppStrings = KO,
): string | null {
  if (!(byteLength > limitBytes)) return null;
  return t.supportedSizeNotice(mib(byteLength), mib(limitBytes));
}

/**
 * 저널 상한 안내(계약 D4): 편집 커밋 뒤 core `journalAdvice` 가 `advised` 이면 "저장 후 다시 열기" 를 권한다. 판정은 core
 * (저널 보유 추정 + 예상 저장 증가분 > 경고선)가 하고, 여기서는 문구만 만든다. 권고가 아니면 null.
 */
export function journalNotice(
  advice: JournalAdvice | null | undefined,
  t: AppStrings = KO,
): string | null {
  if (!advice?.advised) return null;
  return t.journalNotice(
    t.journalReopenAdvice,
    mib(advice.journalBytes),
    mib(advice.thresholdBytes),
  );
}

/** 저장 직후 다시 실행 소실 조건 안내(계약 D9, 한국어). 편집이 있는 문서를 처음 저장한 뒤 한 번 보인다. */
export const HISTORY_AFTER_SAVE_NOTICE = KO.historyAfterSave;

/** Worker 복구 중 진행(계약 D4 사용자 결정 2026-10-21): 다시 적용한 편집 수 / 전체. */
export function recoveryProgressNotice(done: number, total: number, t: AppStrings = KO): string {
  return total > 0 ? t.recoveryProgress(done, total) : t.recoveryProgressNoTotal;
}

/** Worker 복구 완료. 저장 기준점에서 복구했으면 마지막 저장 뒤 편집만 다시 적용했다고 알린다. */
export function recoveredNotice(
  replayedEdits: number,
  fromSavedBaseline: boolean,
  t: AppStrings = KO,
): string {
  return t.recovered(replayedEdits, fromSavedBaseline);
}
