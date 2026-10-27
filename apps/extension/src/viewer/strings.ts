/**
 * 확장 뷰어 문자열 표(한국어·영어, 사용자 요청 2026-10-23): 머리 영역(저장 메뉴·정보 버튼·상태 줄·알림 줄)과 정보·저장 확인
 * 대화상자. 툴바 컨트롤·검색창·쪽 화살표 문자열은 viewer-ui `VIEWER_STRINGS` 에 있다.
 *
 * 언어 판정: `chrome.i18n.getUILanguage()`(브라우저 UI 언어, 권한 불필요), 없으면 `navigator.language`. 주 언어가 ko 이면
 * 한국어, 그 밖은 영어(viewer-ui `resolveUiLang`). 방식 선택 근거는 docs/m5-release.md 10.2.
 */
import type { SaveWarningCode } from '@pdf-editor/shared-types';
import {
  resolveUiLang,
  VIEWER_STRINGS,
  type UiLang,
  type ViewerStrings,
} from '@pdf-editor/viewer-ui';
import type { SaveErrorCode } from './save-target.js';

export interface AppStrings {
  lang: UiLang;
  /** viewer-ui 문자열 표(같은 언어). */
  viewer: ViewerStrings;
  // 머리 영역
  openPdf: string;
  save: string;
  saveAs: string;
  saveDownloads: string;
  saveDownloadsTitle: string;
  about: string;
  aboutTitle: string;
  close: string;
  // 상태 줄
  statusIdle: string;
  statusChoosePdf: string;
  statusOpening(label: string): string;
  statusOpenFailed(error: string): string;
  statusRendered(pageCount: number, page: number): string;
  statusRecovering(done: number, total: number): string;
  statusWorkerError(message: string): string;
  statusEditNotFinished: string;
  statusPlanFailed(error: string): string;
  statusSaveBlocked(reason: string): string;
  statusSaveCancelled: string;
  statusSaving: string;
  statusSaved(where: string, reused: boolean): string;
  statusSaveFailed(error: string): string;
  statusRecoveredDuringSave: string;
  statusBenchSaving: string;
  statusBenchResult(saveMs: number, heapMiB: number): string;
  savedToFile(name: string): string;
  savedToDownloads: string;
  /**
   * 상태 줄 오류 상세(콜론 뒤). 한국어는 이전처럼 `String(e)`, 영어는 viewer-ui `errorDetail`(오류 이름·알려진 형태·한글 없는
   * 메시지, 그 밖은 일반 문장, 사용자 결정 2026-10-26).
   */
  errorText(error: unknown): string;
  /** 저장 대상(save-target.ts)이 정한 실패 원인. */
  saveErrors: Record<SaveErrorCode, string>;
  // 알림 줄
  redactNotice(total: number, pages: string): string;
  fileAccessNotice(extensionId: string): string;
  sizeFigures(peak: string, limit: string): string;
  sizeOverLimitNotice(figures: string): string;
  sizeWarnNotice(figures: string): string;
  supportedSizeNotice(doc: string, limit: string): string;
  journalNotice(advice: string, journal: string, threshold: string): string;
  historyAfterSave: string;
  recoveryProgress(done: number, total: number): string;
  recoveryProgressNoTotal: string;
  recovered(replayed: number, fromSavedBaseline: boolean): string;
  // 대화상자
  dialogOk: string;
  dialogCancel: string;
  cannotSaveTitle: string;
  confirmSaveTitle: string;
  saveFailedTitle: string;
  saveFailedLines: string[];
  saveAgain: string;
  later: string;
  // 저장 전 판정(save-plan.ts)
  journalReopenAdvice: string;
  blockedSaveOptions: string;
  grownHeapRetryNote: string;
  retrySaveLabel: string;
  /** 힙 over-limit 문구. 한국어는 core 문구(`heap.message`)가 있으면 그것을 쓴다. */
  heapOverLimit(limit: string, peak: string): string;
  heapWarn(peak: string, limit: string): string;
  journalHeld(size: string): string;
  structureUnlinked(count: number): string;
  pdfaDeclared: string;
  editPagesRecorded(pages: string): string;
  /** core 저장 경고 코드(`SavePlan.warningCodes`) → 문장. 한국어는 core 문장(`SavePlan.warnings`)을 그대로 쓴다. */
  saveWarnings: Record<SaveWarningCode, string[]>;
  /** 코드 없는 core 저장 경고(영어 화면). */
  saveWarningUnknown: string;
  // 정보 대화상자(about.ts)
  aboutDialogTitle: string;
  aboutVersion(version: string): string;
  aboutLicense: string;
  aboutSupportedSize(size: string): string;
  aboutJournal: string;
  aboutUndo: string;
  aboutHeapNow(peak: string, limit: string): string;
  aboutSourceLink(version: string): string;
  aboutNoticesLink: string;
}

const KO: AppStrings = {
  lang: 'ko',
  viewer: VIEWER_STRINGS.ko,
  openPdf: 'PDF 열기',
  save: '저장',
  saveAs: '다른 이름으로 저장',
  saveDownloads: 'downloads 저장',
  saveDownloadsTitle: 'M0 진단: chrome.downloads 경로 강제(개발 빌드 전용)',
  about: '정보',
  aboutTitle: '버전·라이선스·소스 코드',
  close: '닫기',
  statusIdle: '대기',
  statusChoosePdf: 'PDF 파일을 선택하세요',
  statusOpening: (label) => `여는 중: ${label}`,
  statusOpenFailed: (e) => `열기 실패: ${e}`,
  statusRendered: (n, p) => `${n} 페이지 · ${p}페이지 렌더 완료`,
  statusRecovering: (done, total) => `문서 복구 중: 편집 ${done}/${total}`,
  statusWorkerError: (m) => `Worker 오류: ${m}`,
  statusEditNotFinished: '편집을 마치지 못해 저장하지 않았습니다',
  statusPlanFailed: (e) => `저장 전 판정 실패: ${e}`,
  statusSaveBlocked: (r) => `저장 중단: ${r}`,
  statusSaveCancelled: '저장을 취소했습니다',
  statusSaving: '저장 중',
  statusSaved: (where, reused) => `저장됨: ${where}${reused ? ' (같은 대상 재저장)' : ''}`,
  statusSaveFailed: (e) => `저장 실패: ${e}`,
  statusRecoveredDuringSave: '저장 중 작업 모듈이 중단되어 문서를 복구했습니다',
  statusBenchSaving: '전체 저장 측정 중',
  statusBenchResult: (ms, mib) => `전체 저장 ${ms.toFixed(0)} ms, WASM 힙 ${mib.toFixed(1)} MiB`,
  savedToFile: (name) => `파일 ${name}`,
  savedToDownloads: '다운로드',
  errorText: (e) => String(e),
  saveErrors: {
    'write-permission-denied': '파일 쓰기 권한이 없습니다. 다른 이름으로 저장하세요.',
    'no-downloads': '다운로드로 저장할 수 없습니다(chrome.downloads 없음).',
  },
  redactNotice: (total, pages) =>
    `이 문서에는 적용되지 않은 Redact(가림) 주석 ${total}개가 있습니다(${pages}쪽). 이 뷰어는 적용하지 않으며, 저장 후에도 표시로 남습니다.`,
  fileAccessNotice: (id) =>
    `로컬 파일(file://) PDF 를 이 뷰어로 자동으로 열려면 chrome://extensions/?id=${id} 에서 "파일 URL에 대한 액세스 허용" 을 켜세요. 꺼져 있으면 로컬 PDF 는 Chrome 기본 뷰어로 열립니다.`,
  sizeFigures: (peak, limit) => `예상 저장 피크 ${peak} / 한계 ${limit}`,
  sizeOverLimitNotice: (f) =>
    `이 문서는 지원 크기를 넘습니다(${f}). 열람은 되지만 편집한 뒤 저장할 수 없습니다.`,
  sizeWarnNotice: (f) =>
    `이 문서는 큰 편이라 편집·저장이 실패할 수 있습니다(${f}). 저장이 실패하면 작업 모듈을 복구하고 다시 저장할지 묻습니다.`,
  supportedSizeNotice: (doc, limit) =>
    `이 문서(${doc})는 지원 크기 ${limit} 를 넘습니다. 열람은 되지만 편집·저장이 실패할 수 있습니다.`,
  journalNotice: (advice, journal, threshold) =>
    `${advice} (편집 기록 약 ${journal}, 경고선 ${threshold})`,
  historyAfterSave:
    '저장한 뒤에도 되돌리기(Ctrl+Z)는 됩니다. 다만 폴백 글꼴을 쓴 편집을 되돌린 직후에 저장하면 다시 실행(Ctrl+Shift+Z) 기록이 사라질 수 있습니다.',
  recoveryProgress: (done, total) =>
    `작업 모듈이 중단되어 문서를 복구하는 중입니다: 편집 ${done}/${total} 다시 적용`,
  recoveryProgressNoTotal: '작업 모듈이 중단되어 문서를 복구하는 중입니다',
  recovered: (n, fromSaved) =>
    `작업 모듈이 중단되어 문서를 복구했습니다(${fromSaved ? '마지막 저장 시점에서 ' : ''}편집 ${n}건 다시 적용). 복구 전 되돌리기 이력은 사라졌습니다.`,
  dialogOk: '확인',
  dialogCancel: '취소',
  cannotSaveTitle: '저장할 수 없습니다',
  confirmSaveTitle: '저장 전 확인',
  saveFailedTitle: '저장하지 못했습니다',
  saveFailedLines: [
    '저장하는 동안 작업 모듈이 중단되어 문서를 복구했습니다. 편집 내용은 복구되었지만 복구 전 되돌리기 이력은 사라졌습니다.',
    '다시 저장할까요?',
  ],
  saveAgain: '다시 저장',
  later: '나중에',
  journalReopenAdvice:
    '편집 기록이 메모리를 많이 차지하고 있습니다. 먼저 저장하고 파일을 다시 열면 편집 기록이 정리되어 메모리가 줄어듭니다(다시 연 뒤에는 이전 편집을 되돌릴 수 없습니다).',
  blockedSaveOptions:
    '저장하지 않았습니다. 파일을 다시 열면 메모리가 정리되지만 저장하지 않은 편집은 모두 사라집니다.',
  grownHeapRetryNote:
    '예상이 큰 주된 이유는 앞선 저장·쪽 보기로 이미 커진 작업 메모리입니다. 작업 메모리는 줄지 않지만 그 안의 빈 공간을 다시 쓰므로 실제로는 저장될 수 있습니다. 저장 중 메모리가 부족하면 작업 모듈을 복구하고 다시 저장할지 묻습니다(복구 전 되돌리기 기록은 사라집니다).',
  retrySaveLabel: '그래도 저장 시도',
  heapOverLimit: (limit, peak) =>
    `저장 중 메모리가 한계(${limit})를 넘을 것으로 예상됩니다 (예상 피크 ${peak}).`,
  heapWarn: (peak, limit) =>
    `저장 중 메모리를 많이 쓸 것으로 예상됩니다 (예상 피크 ${peak} / 한계 ${limit}). 저장이 실패하면 작업 모듈을 복구하고 다시 저장할지 묻습니다.`,
  journalHeld: (size) => ` 편집 기록이 약 ${size} 를 차지하고 있습니다.`,
  structureUnlinked: (n) =>
    `태그된 PDF 쪽에서 편집한 문단 ${n}개는 구조(읽기 순서·태그)와의 연결이 끊어집니다.`,
  pdfaDeclared: '이 문서는 PDF/A 로 선언되어 있어 편집하면 PDF/A 적합성이 깨질 수 있습니다.',
  editPagesRecorded: (pages) =>
    `저장하면 편집한 쪽 번호(${pages}쪽)가 파일 정보(PdfEditorEdits)에 기록됩니다.`,
  saveWarnings: {
    'edit-engine-failed': [
      '편집 엔진 오류 상태에서 저장합니다. 저널 보호 없이 현재 문서를 그대로 내보냅니다.',
      '마지막 편집이 빠졌거나 일부만 반영됐을 수 있고, 취소한 초안의 변경이 저장 파일에 들어갈 수 있습니다. 저장 뒤 파일을 확인하고 문서를 다시 여세요.',
    ],
  },
  saveWarningUnknown: '저장 전에 확인할 경고가 있습니다.',
  aboutDialogTitle: 'PDF Editor 정보',
  aboutVersion: (v) => `버전 ${v}`,
  aboutLicense:
    '라이선스: GNU Affero General Public License v3.0 이상(AGPL-3.0-or-later). 이 프로그램은 보증 없이 제공됩니다. 소스 코드는 아래 링크에서 받을 수 있습니다.',
  aboutSupportedSize: (size) =>
    `지원 문서 크기: 약 ${size} 까지입니다(이미지 위주 문서 기준). 저장할 때 필요한 메모리를 미리 계산해, 한계에 가까우면 경고하고 한계를 넘으면 저장하지 않고 안내합니다. 이보다 큰 문서는 열람만 되고 편집·저장이 실패할 수 있습니다.`,
  aboutJournal:
    '편집 기록: 편집한 내용은 메모리에 기록(저널)으로 쌓입니다. 편집이 많아 메모리가 부족해지면 먼저 저장한 뒤 파일을 다시 여세요(다시 연 뒤에는 이전 편집을 되돌릴 수 없습니다).',
  aboutUndo:
    '되돌리기·다시 실행: 작업 모듈이 중단되어 복구되면 되돌리기 기록이 사라집니다. 되돌린 뒤 새 편집을 시작하면 다시 실행 기록이 사라집니다. 폴백 글꼴을 쓴 편집을 되돌린 직후 저장해도 다시 실행 기록이 사라집니다.',
  aboutHeapNow: (peak, limit) => `이 문서의 저장 예상 메모리: ${peak} / 한계 ${limit}`,
  aboutSourceLink: (v) => `소스 코드 (v${v})`,
  aboutNoticesLink: '서드파티 라이선스 고지',
};

const EN: AppStrings = {
  lang: 'en',
  viewer: VIEWER_STRINGS.en,
  openPdf: 'Open PDF',
  save: 'Save',
  saveAs: 'Save as',
  saveDownloads: 'Save via downloads',
  saveDownloadsTitle: 'M0 diagnostics: force the chrome.downloads path (development build only)',
  about: 'About',
  aboutTitle: 'Version, license, source code',
  close: 'Close',
  statusIdle: 'Idle',
  statusChoosePdf: 'Choose a PDF file',
  statusOpening: (label) => `Opening: ${label}`,
  statusOpenFailed: (e) => `Could not open: ${e}`,
  statusRendered: (n, p) => `${n} pages · page ${p} rendered`,
  statusRecovering: (done, total) => `Recovering document: edit ${done}/${total}`,
  statusWorkerError: (m) => `Worker error: ${m}`,
  statusEditNotFinished: 'Not saved: the edit could not be finished',
  statusPlanFailed: (e) => `Pre-save check failed: ${e}`,
  statusSaveBlocked: (r) => `Save stopped: ${r}`,
  statusSaveCancelled: 'Save cancelled',
  statusSaving: 'Saving…',
  statusSaved: (where, reused) => `Saved: ${where}${reused ? ' (same file)' : ''}`,
  statusSaveFailed: (e) => `Save failed: ${e}`,
  statusRecoveredDuringSave: 'The worker stopped while saving; the document was recovered',
  statusBenchSaving: 'Measuring full save',
  statusBenchResult: (ms, mib) => `Full save ${ms.toFixed(0)} ms, WASM heap ${mib.toFixed(1)} MiB`,
  savedToFile: (name) => name,
  savedToDownloads: 'Downloads',
  errorText: (e) => VIEWER_STRINGS.en.errorDetail(e),
  saveErrors: {
    'write-permission-denied': 'No permission to write the file. Use Save as.',
    'no-downloads': 'Cannot save to Downloads (chrome.downloads is unavailable).',
  },
  redactNotice: (total, pages) =>
    `This document has ${total} unapplied Redact annotation(s) (page ${pages}). This viewer does not apply them; they remain as marks after saving.`,
  fileAccessNotice: (id) =>
    `To open local (file://) PDFs in this viewer automatically, turn on "Allow access to file URLs" at chrome://extensions/?id=${id}. While it is off, local PDFs open in Chrome's built-in viewer.`,
  sizeFigures: (peak, limit) => `estimated save peak ${peak} / limit ${limit}`,
  sizeOverLimitNotice: (f) =>
    `This document exceeds the supported size (${f}). You can view it, but it cannot be saved after editing.`,
  sizeWarnNotice: (f) =>
    `This document is large; editing or saving may fail (${f}). If saving fails, the worker is recovered and you are asked whether to save again.`,
  supportedSizeNotice: (doc, limit) =>
    `This document (${doc}) exceeds the supported size of ${limit}. You can view it, but editing or saving may fail.`,
  journalNotice: (advice, journal, threshold) =>
    `${advice} (edit history about ${journal}, warning level ${threshold})`,
  historyAfterSave:
    'Undo (Ctrl+Z) still works after saving. However, saving right after undoing an edit that used the fallback font may clear the redo (Ctrl+Shift+Z) history.',
  recoveryProgress: (done, total) =>
    `The worker stopped; recovering the document: re-applying edit ${done}/${total}`,
  recoveryProgressNoTotal: 'The worker stopped; recovering the document',
  recovered: (n, fromSaved) =>
    `The worker stopped and the document was recovered (${n} edit(s) re-applied${fromSaved ? ' from the last save' : ''}). Undo history from before the recovery is lost.`,
  dialogOk: 'OK',
  dialogCancel: 'Cancel',
  cannotSaveTitle: 'Cannot save',
  confirmSaveTitle: 'Before saving',
  saveFailedTitle: 'Could not save',
  saveFailedLines: [
    'The worker stopped while saving and the document was recovered. Your edits were restored, but undo history from before the recovery is lost.',
    'Save again?',
  ],
  saveAgain: 'Save again',
  later: 'Later',
  journalReopenAdvice:
    'The edit history is using a lot of memory. Save first and reopen the file to clear the edit history and reduce memory use (after reopening, earlier edits cannot be undone).',
  blockedSaveOptions:
    'Nothing was saved. Reopening the file frees memory, but all unsaved edits will be lost.',
  grownHeapRetryNote:
    'The estimate is high mainly because the working memory has already grown from earlier saves and page views. Working memory does not shrink, but its free space is reused, so the save may still succeed. If memory runs out while saving, the worker is recovered and you are asked whether to save again (undo history from before the recovery is lost).',
  retrySaveLabel: 'Try saving anyway',
  heapOverLimit: (limit, peak) =>
    `Saving is expected to exceed the memory limit (${limit}) (estimated peak ${peak}).`,
  heapWarn: (peak, limit) =>
    `Saving is expected to use a lot of memory (estimated peak ${peak} / limit ${limit}). If saving fails, the worker is recovered and you are asked whether to save again.`,
  journalHeld: (size) => ` The edit history is using about ${size}.`,
  structureUnlinked: (n) =>
    `${n} edited paragraph(s) on tagged PDF pages will lose their link to the structure (reading order, tags).`,
  pdfaDeclared: 'This document declares PDF/A conformance; editing may break PDF/A conformance.',
  editPagesRecorded: (pages) =>
    `Saving records the edited page numbers (${pages}) in the file info (PdfEditorEdits).`,
  saveWarnings: {
    'edit-engine-failed': [
      'Saving while the edit engine is in an error state. The current document is written as is, without journal protection.',
      'The last edit may be missing or only partly applied, and changes from a cancelled draft may be included. Check the saved file after saving and reopen the document.',
    ],
  },
  saveWarningUnknown: 'There is a warning to review before saving.',
  aboutDialogTitle: 'About PDF Editor',
  aboutVersion: (v) => `Version ${v}`,
  aboutLicense:
    'License: GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). This program comes with no warranty. The source code is available at the link below.',
  aboutSupportedSize: (size) =>
    `Supported document size: up to about ${size} (image-heavy documents). The memory needed for saving is estimated in advance: you are warned near the limit, and saving is stopped above it. Larger documents can be viewed, but editing or saving may fail.`,
  aboutJournal:
    'Edit history: edits are kept in memory as a journal. If many edits make memory run low, save first and then reopen the file (after reopening, earlier edits cannot be undone).',
  aboutUndo:
    'Undo and redo: undo history is lost when the worker is recovered after a crash. Redo history is lost when you start a new edit after undoing, and also when you save right after undoing an edit that used the fallback font.',
  aboutHeapNow: (peak, limit) =>
    `Estimated save memory for this document: ${peak} / limit ${limit}`,
  aboutSourceLink: (v) => `Source code (v${v})`,
  aboutNoticesLink: 'Third-party license notices',
};

export const APP_STRINGS: Readonly<Record<UiLang, AppStrings>> = { ko: KO, en: EN };

export interface LanguageSources {
  /** `chrome.i18n.getUILanguage()` 결과(없으면 null). */
  uiLanguage: string | null;
  /** `navigator.language`. */
  navigatorLanguage: string | null;
}

/** 브라우저 UI 언어를 먼저, 없으면 navigator.language 를 본다. */
export function detectLang(src: LanguageSources): UiLang {
  return resolveUiLang(src.uiLanguage, src.navigatorLanguage);
}

/** 이 페이지의 언어 출처를 읽는다(확장 API 가 없거나 실패하면 null). */
export function readLanguageSources(): LanguageSources {
  return {
    uiLanguage: chromeUiLanguage(),
    navigatorLanguage: typeof navigator === 'object' ? (navigator.language ?? null) : null,
  };
}

function chromeUiLanguage(): string | null {
  try {
    return typeof chrome === 'object' ? (chrome.i18n?.getUILanguage?.() ?? null) : null;
  } catch {
    return null;
  }
}

/** 문자열 값인 키(viewer.html 의 `data-i18n*` 속성 값). */
export type AppTextKey = {
  [K in keyof AppStrings]: AppStrings[K] extends string ? K : never;
}[keyof AppStrings];

const DOM_TARGETS = [
  ['data-i18n', null],
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
] as const;

/**
 * viewer.html 의 고정 문자열을 바꾼다: `data-i18n` 은 글자, `data-i18n-title`·`data-i18n-aria-label` 은 그 속성. 값은
 * `AppTextKey`. 모르는 키는 그대로 둔다(HTML 의 한국어 기본값).
 */
export function applyDomStrings(root: ParentNode, t: AppStrings): void {
  for (const [attr, target] of DOM_TARGETS) {
    for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
      const value = (t as unknown as Record<string, unknown>)[el.getAttribute(attr) ?? ''];
      if (typeof value !== 'string') continue;
      if (target === null) el.textContent = value;
      else el.setAttribute(target, value);
    }
  }
}
