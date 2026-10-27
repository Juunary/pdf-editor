/** Save (PLAN.md 3.1). */

/** Save mode. Text and stream replacement always use a full save (PLAN.md 3.1). */
export type SaveMethod = 'incremental' | 'full';

/** Change types used to decide the save mode. */
export type ChangeKind = 'annotation' | 'metadata' | 'redaction' | 'content-stream' | 'font-embed';

export type HeapLevel = 'ok' | 'warn' | 'over-limit';

/** Expected peak WASM heap before saving (PLAN.md 3.1, 5.4). Same shape as pdf-ops `HeapEstimate`. */
export interface SaveHeapEstimate {
  inputBytes: number;
  /** Scale factor applied (peak WASM heap ÷ input file size). */
  ratio: number;
  estimatedPeakBytes: number;
  limitBytes: number;
  /** estimatedPeakBytes ÷ limitBytes. */
  fraction: number;
  level: HeapLevel;
  /** User message if level is not ok. */
  message: string | null;
  /** Model input: number of document objects (M5 D5, `docs/m5-contract.md` section 3). The scale model is used if absent. */
  objectCount?: number;
  /** Model input: sum of original stream /Length (not decoded, byte). */
  rawStreamBytes?: number;
  /** Model input: estimate of journal holdings (sum of replaced stream lengths, byte). */
  journalBytes?: number;
  /** Identifier of the model applied (e.g. `ratio-v0`, `linear-v1`). */
  model?: string;
  /** Coefficient model: in-use heap estimate used for the prediction (byte). If a previous save exists, the value minus the space the save used and released. */
  usedHeapBytes?: number;
  /** Coefficient model: WASM heap right after the previous save in this session (measured peak, byte). Absent if never saved. */
  priorSavePeakBytes?: number;
  /**
   * Coefficient model: the warn and over-limit classification is caused by an already grown heap (WASM linear memory never shrinks). Computing from base + journal would give a lower
   * level. The viewer allows "그래도 저장 시도" ("save anyway") even at over-limit (if it fails, it asks again after Worker recovery).
   */
  grownHeapBasis?: boolean;
}

/**
 * Journal limit check (M5 D4, `docs/m5-heap.md` 5.3). `advised` if the journal holdings estimate + the expected full-save increase exceeds the warning line (save heap warn boundary =
 * `HEAP_WARN_FRACTION` × limit). The viewer asks after an edit commit and recommends "저장 후 다시 열기" ("save and reopen").
 * Same shape as pdf-ops `JournalAdvice`.
 */
export interface JournalAdvice {
  /** Whether save-and-reopen should be recommended. */
  advised: boolean;
  /** Journal holdings estimate (byte). 0 in environments where the coefficient model is unavailable (Buffer input, no heap measurement). */
  journalBytes: number;
  /** Expected increase from a full save (byte). */
  incrementBytes: number;
  /** Warning line (byte). */
  thresholdBytes: number;
}

export interface SaveRequest {
  /** Change types applied since the last save. */
  changes: ChangeKind[];
}

/** Summary of edits to save (M3, docs/m3-contract.md 5.8). */
export interface SaveEditSummary {
  /** Edited pages (0-based). */
  pages: number[];
  /** Number of edited paragraphs whose structure link broke on tagged pages. */
  structureUnlinked: number;
  /** /Metadata contains a PDF/A declaration. */
  pdfaDeclared: boolean;
}

/** Pre-save classification (the viewer decides on warning or abort). */
export interface SavePlan {
  method: SaveMethod;
  /** MuPDF `saveToBuffer` option string. */
  options: string;
  reason: string;
  canBeSavedIncrementally: boolean;
  heap: SaveHeapEstimate;
  /** null if there are no edits. */
  edits: SaveEditSummary | null;
  /**
   * Warnings to show the user and confirm before saving (saving in an edit-engine failure state, etc., M4 R-M4). No warning if absent or empty.
   * If non-empty, the viewer shows a confirmation dialog and then saves.
   */
  warnings?: string[];
  /**
   * Cause codes for `warnings` (2026-10-26). The Korean UI uses the `warnings` sentences as is; other-language UIs have the viewer build the sentence
   * from this code. edit-engine-failed: saving in an edit-engine failure state without journal protection (R-M4).
   */
  warningCodes?: SaveWarningCode[];
}

export type SaveWarningCode = 'edit-engine-failed';

export interface SaveResult {
  bytes: Uint8Array<ArrayBuffer>;
  method: SaveMethod;
  /** Value of `PDFDocument.canBeSavedIncrementally()` right before saving. */
  canBeSavedIncrementally: boolean;
  /** MuPDF `saveToBuffer` option string. */
  options: string;
  saveMs: number;
  /**
   * WASM linear memory size right after saving (byte). Linear memory never shrinks, so this is the maximum up to that point.
   * null in environments where no measurement object is attached.
   */
  wasmHeapBytes: number | null;
  /** Expected peak heap computed before saving. null if it could not be computed. */
  heap: SaveHeapEstimate | null;
  /** Warnings that applied to this save (same as `SavePlan.warnings`). */
  warnings?: string[];
}
