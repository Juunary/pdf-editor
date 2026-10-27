import { SUPPORTED_INPUT_BYTES } from '@pdf-editor/core/client';
import type { JournalAdvice, SaveHeapEstimate } from '@pdf-editor/shared-types';
import { APP_STRINGS, type AppStrings } from './strings.js';

/**
 * Builds the text of viewer notices (reports and guidance right after opening a document) (pure). Display is done by the notice row in main.ts. Text comes from `t` (default Korean,
 * strings.ts).
 */
const KO = APP_STRINGS.ko;

export interface RedactReportLike {
  total: number;
  /** Pages that have Redact annotations (0-based). */
  pages: number[];
}

/** Report of Redact annotations on open (A2-2): a notice that pending redaction marks exist. null if none. */
export function redactNotice(report: RedactReportLike | null, t: AppStrings = KO): string | null {
  if (!report || report.total <= 0) return null;
  const pages = report.pages.map((p) => p + 1).join(', ');
  return t.redactNotice(report.total, pages);
}

export interface FileAccessInput {
  /** Interception mode: the MIME handler is independent of the file:// access setting. */
  mode: 'mime-handler' | 'dnr-fallback' | 'unsupported';
  /** Result of `chrome.extension.isAllowedFileSchemeAccess()`. null if unknown. */
  fileAccessAllowed: boolean | null;
  /** Display URL of the opened document (null: viewer opened directly). */
  displayUrl: string | null;
  extensionId: string;
}

/**
 * The DNR fallback (Chrome 128–149) intercepts a file:// PDF only when "파일 URL에 대한 액세스 허용" (Allow access to file URLs) is on (A5-3, corpus C10).
 * When it is off, a file:// PDF opens in Chrome's default viewer, so this viewer shows guidance.
 * Shown when the viewer was opened directly or a file:// document is opened. null if not applicable.
 */
export function fileAccessNotice(input: FileAccessInput, t: AppStrings = KO): string | null {
  if (input.mode !== 'dnr-fallback' || input.fileAccessAllowed !== false) return null;
  if (input.displayUrl !== null && !input.displayUrl.startsWith('file:')) return null;
  return t.fileAccessNotice(input.extensionId);
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

/**
 * Supported document size limit notice (PLAN.md section 7, risk 8). When the estimated save peak exceeds the warning line or limit set by core,
 * it notifies that "editing and saving may fail". The values (warning line, limit) use core's `SaveHeapEstimate` as is.
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
 * Supported document size limit notice (risk 8, docs/m5-heap.md section 6): notifies when the opened document's byte count exceeds core's `SUPPORTED_INPUT_BYTES`
 * (the size at which the estimated peak starts to exceed the limit when an image-heavy document is edited right after opening and then fully saved). null if not exceeded.
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
 * Journal limit notice (contract D4): after an edit commit, if core `journalAdvice` is `advised`, recommends "저장 후 다시 열기" (save and reopen). The check is made by core
 * (estimated journal retention + estimated save increase > warning line); only the text is built here. null if there is no advice.
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

/** Notice that redo is lost after saving (contract D9, Korean). Shown once after a document with edits is first saved. */
export const HISTORY_AFTER_SAVE_NOTICE = KO.historyAfterSave;

/** Progress during Worker recovery (contract D4 user decision 2026-10-21): number of reapplied edits / total. */
export function recoveryProgressNotice(done: number, total: number, t: AppStrings = KO): string {
  return total > 0 ? t.recoveryProgress(done, total) : t.recoveryProgressNoTotal;
}

/** Worker recovery complete. If recovered from a save checkpoint, notifies that only the edits after the last save were reapplied. */
export function recoveredNotice(
  replayedEdits: number,
  fromSavedBaseline: boolean,
  t: AppStrings = KO,
): string {
  return t.recovered(replayedEdits, fromSavedBaseline);
}
