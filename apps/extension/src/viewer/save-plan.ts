/**
 * Interpretation of the pre-save check (contract 5.8, A3-2). Decides from the `planSave` result whether to block the save or ask for confirmation.
 *
 * - Heap `over-limit`: do not save; show a notice (abort). It also states what can be done (reopening frees memory, but unsaved edits are lost).
 *   Since saving is not possible, "저장 후 다시 열기" (save and reopen) is not recommended.
 * - Even with heap `over-limit`, if the check is based on an already-grown heap (`heap.grownHeapBasis`), show a "그래도 저장 시도" (save anyway) confirmation. WASM linear memory
 *   does not shrink and the free space inside it is reused, so the actual save may succeed; if it fails, ask again after Worker recovery.
 * - Heap `warn`: confirmation dialog.
 * - Tagged-page edits where a paragraph has lost its structure link: confirmation dialog (D1).
 * - Edits to a PDF/A-declared document: "may break conformance" confirmation dialog (5.6).
 * - core save warnings (`SavePlan.warnings`, e.g. saving in an edit-engine failure state): confirmation dialog (placed first). Korean uses the core sentence as is; English
 *   builds the sentence from the cause code (`SavePlan.warningCodes`) (a generic sentence if there is no code, user decision 2026-10-26).
 * - If there are edits, a notice that "edited page numbers are recorded in the file info" (shown together when a confirmation dialog appears).
 * - If the core journal limit check (`journalAdvice` RPC, contract D4) is `advised`, add a "저장 후 다시 열기" (save and reopen) recommendation when saving is possible,
 *   and the edit history size when aborting. The warning line is set by core (the save-heap warn boundary); no separate value is kept here.
 *   The heap check message (`heap.message`) carries no recommendation (core does not add one).
 */
import type { JournalAdvice, SavePlan } from '@pdf-editor/shared-types';
import { APP_STRINGS, type AppStrings } from './strings.js';

export interface SaveDecision {
  /** Reason for abort (if present, do not save). */
  block: string | null;
  /** Warnings that need confirmation. If non-empty, show a confirmation dialog. */
  warnings: string[];
  /** Notices shown together in the confirmation dialog (they alone do not trigger a confirmation dialog). */
  infos: string[];
  /** Label of the confirmation dialog's OK button. "저장" (Save) if absent. */
  confirmLabel?: string;
}

const mib = (bytes: number) => `${(bytes / 2 ** 20).toFixed(0)} MiB`;

const KO = APP_STRINGS.ko;

/** Recommendation when the edit history (journal) takes up memory and nears the limit (D4, Korean). Used only when saving is possible. */
export const JOURNAL_REOPEN_ADVICE = KO.journalReopenAdvice;

/** What can be done when aborting a save (Korean). */
export const BLOCKED_SAVE_OPTIONS = KO.blockedSaveOptions;

/** Notice for the "그래도 저장 시도" (save anyway) confirmation when the basis of over-limit is an already-grown heap (Korean). */
export const GROWN_HEAP_RETRY_NOTE = KO.grownHeapRetryNote;

/** Label of the "그래도 저장 시도" (save anyway) button (Korean). */
export const RETRY_SAVE_LABEL = KO.retrySaveLabel;

/**
 * Pre-save check. `journal` is the result of the core journal limit check (`journalAdvice` RPC); null if it was not received (no recommendation).
 * Text comes from `t` (default Korean). The core heap message (`heap.message`) is Korean, so it is used only in Korean; for English the text is built from the numbers.
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

/** core save warning sentences. Korean uses `warnings` as is; English builds them from `warningCodes`. */
function coreSaveWarnings(plan: SavePlan, t: AppStrings): string[] {
  const core = plan.warnings ?? [];
  if (t.lang === 'ko' || core.length === 0) return [...core];
  const codes = plan.warningCodes ?? [];
  return codes.length > 0 ? codes.flatMap((c) => t.saveWarnings[c]) : [t.saveWarningUnknown];
}
