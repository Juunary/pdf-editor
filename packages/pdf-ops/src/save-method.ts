import type { ChangeKind, JournalAdvice, SaveMethod } from '@pdf-editor/shared-types';

export type HeapLevel = 'ok' | 'warn' | 'over-limit';

/** Expected peak WASM heap before saving (PLAN.md 3.1, 5.4, docs/m0-day1-log.md A4, docs/m5-heap.md). */
export interface HeapEstimate {
  inputBytes: number;
  /** Ratio model: the ratio applied. Coefficient model: estimatedPeakBytes ÷ inputBytes (reference value) */
  ratio: number;
  estimatedPeakBytes: number;
  limitBytes: number;
  /** estimatedPeakBytes ÷ limitBytes */
  fraction: number;
  level: HeapLevel;
  /** User message when level is not ok */
  message: string | null;
  /** Coefficient model input (same names as shared-types `SaveHeapEstimate`). Absent for the ratio model */
  objectCount?: number;
  rawStreamBytes?: number;
  journalBytes?: number;
  /** Model applied (`ratio-v0` ratio, `SAVE_HEAP_MODEL_ID` coefficient) */
  model?: string;
  /** Coefficient model: used-heap estimate used for the prediction (`usedHeapAfterSave` if there was a previous save, otherwise the current heap) */
  usedHeapBytes?: number;
  /** Coefficient model: WASM heap right after this session's previous save (measured peak). Absent if never saved */
  priorSavePeakBytes?: number;
  /**
   * Coefficient model: the warn / over-limit classification is due to an already grown heap. Computing from base + journal instead of the used-heap estimate gives a lower level.
   * WASM linear memory does not shrink, so a grown heap contains free space that can be reused; the viewer therefore allows "save anyway"
   * even at over-limit (on failure, the Worker recovery path applies)
   */
  grownHeapBasis?: boolean;
}

export interface SaveDecision {
  method: SaveMethod;
  /** MuPDF `PDFDocument.saveToBuffer` option string. */
  options: string;
  reason: string;
  /** Only when `size` is passed */
  heap?: HeapEstimate;
}

/**
 * Full-save options: remove unused objects (keep numbering) + stream compression (A3-6) + object streams and xref streams (A3-7, decided 2026-10-19).
 * `garbage=compact` (renumbering) and `deduplicate` are not used. MuPDF 1.28.x loses image streams when a document whose image XObject was `resolve()`d
 * is saved with compact (ArtifexSoftware/mupdf.js#201). `garbage=yes` does not take this path,
 * the peak WASM heap is the same as compact, and the output is only tens of bytes larger. Without `objstms`, the original's object stream structure is saved
 * unpacked and the output becomes up to 6.12 times the input. Output with `objstms` added is the same at the object level and in 3-engine rendering, and
 * raises the header of a PDF-1.4 original to 1.5 (docs/m0-dod-xobject-redact-save.md 3.3).
 */
export const FULL_SAVE_OPTIONS = 'garbage=yes,compress,objstms';
export const INCREMENTAL_SAVE_OPTIONS = 'incremental';

/**
 * Measured ratio of peak WASM heap during save ÷ input file size. The larger values of docs/m0-day1-log.md 6.5 (measured 2026-10-18, server Node,
 * synthetic 100 and 300 pages, `openDocument(bytes)` path that copies the input into the WASM heap).
 * Full 4.48 (100 pages), 2.85 (300 pages); incremental 3.98 (100 pages), 3.50 (300 pages).
 */
export const MEASURED_PEAK_HEAP_RATIO: Readonly<Record<SaveMethod, number>> = Object.freeze({
  full: 4.48,
  incremental: 3.98,
});

/**
 * Measured ratio for the `new Stream(handle)` open path that does not copy the input into the WASM heap (measured 2026-10-18, server Node,
 * docs/m0-dod-xobject-redact-save.md 3.3). Maximum on synthetic 100 pages: full 3.48, incremental 2.98.
 * Pass it as `SaveSizeInput.ratio` once core switches to Stream input.
 */
export const STREAM_INPUT_PEAK_HEAP_RATIO: Readonly<Record<SaveMethod, number>> = Object.freeze({
  full: 3.48,
  incremental: 2.98,
});

/** mupdf 1.28.1 WASM linear memory limit (emscripten max heap 2,147,483,648 B, `mupdf-wasm.js`). */
export const WASM_HEAP_LIMIT_BYTES = 2 ** 31;

/** Warn if the expected peak exceeds this fraction of the limit. */
export const HEAP_WARN_FRACTION = 0.75;

export interface SaveSizeInput {
  /** Input (original) file size in bytes */
  inputBytes: number;
  limitBytes?: number;
  warnFraction?: number;
  /** Ratio model ratio (used only when `model` is absent) */
  ratio?: Partial<Record<SaveMethod, number>>;
  /** Coefficient model input. If present, computed with the coefficient model (`estimateSaveHeapModel`) */
  model?: SaveModelInput;
}

/**
 * Coefficient model input (docs/m5-contract.md D5, docs/m5-heap.md section 3). Document statistics are computed once when idle after the first page is displayed
 * (core `computeDocumentStats`), and the heap values are read at planSave time.
 */
export interface SaveModelInput {
  objectCount: number;
  /** Sum of original stream /Length (not decoded) */
  rawStreamBytes: number;
  /** Sum of unpacked sizes of object streams (/ObjStm) */
  objectStreamBytes: number;
  /**
   * The object count and the original stream sum are sample estimates. A sample can miss a few large streams and understate the original stream sum, so the increase is
   * computed with original stream = max(sample value, input size). This correction only moves the (input − original stream) share from the object-size coefficient to the original-stream coefficient
   * (since c > e that share grows) and does not cover the unpacked object-stream size. So `objectStreamBytes` must be
   * the exhaustive value regardless of sampling (core `computeDocumentStats`)
   */
  approximate?: boolean;
  /** Current WASM linear memory size */
  currentHeapBytes: number;
  /**
   * Used-heap estimate. `currentHeapBytes` if omitted. WASM linear memory does not shrink, so after a save the current heap includes the free space the save used and released.
   * If there was a previous save, the session computes it as `usedHeapAfterSave` and passes it
   */
  usedHeapBytes?: number;
  /** WASM heap right after this session's previous save (for result display) */
  priorSavePeakBytes?: number;
  /** WASM linear memory size right after the document finished opening */
  baseHeapBytes: number;
  /** Journal retention estimate (sum of replaced stream lengths, D4) */
  journalBytes: number;
}

/** Save increase coefficients (bytes per byte, bytes per object). Fit result of docs/m5-heap.md section 3. */
export interface SaveHeapCoefficients {
  /** Fixed part in bytes */
  intercept: number;
  inputBytes: number;
  objectCount: number;
  rawStreamBytes: number;
  /** (input − original stream) + unpacked object-stream size: approximate size of object dictionary/array text */
  objectBytes: number;
}

/** Coefficient model identifier. Bump it when the coefficients or formula change. */
export const SAVE_HEAP_MODEL_ID = 'step-v2';

/**
 * Per-save-path coefficients (docs/m5-heap.md sections 3 and 4, `tools/bench/heap-fit.mjs` form `lp/objbytes/step+d/prior`). Coefficients that minimize the sum of relative overestimates
 * under the constraint of covering all fit samples (zero misses) (linear programming, lower bounds: object count ≥ 400 B/object, object size ≥ 1.5),
 * with a safety margin added (full: increase × 1.05 + 4 MiB, incremental: × 1.1) and rounded up. Measured on: server Node 22, mupdf 1.28.1, Stream input,
 * 24 corpus cases + synthetic images at 100–1,200 pages + synthetic objects at 500–2,000 pages, with 0/3/10/30 pages viewed before saving (304 runs).
 */
export const SAVE_HEAP_COEFFICIENTS: Readonly<Record<SaveMethod, Readonly<SaveHeapCoefficients>>> =
  Object.freeze({
    full: Object.freeze({
      intercept: 8.2 * 2 ** 20,
      inputBytes: 0,
      objectCount: 420,
      rawStreamBytes: 2.43,
      objectBytes: 1.58,
    }),
    incremental: Object.freeze({
      intercept: 0,
      inputBytes: 0,
      objectCount: 440,
      rawStreamBytes: 2.57,
      objectBytes: 1.65,
    }),
  });

/**
 * emscripten heap growth rule (docs/m0-dod-xobject-redact-save.md 3.1): new size = max(requested, current × 1.2), but at most requested + 96 MiB.
 * If the need exceeds the current heap, linear memory grows to at most 1.2 times the need (or + 96 MiB).
 */
export const HEAP_GROWTH_FACTOR = 1.2;
export const HEAP_GROWTH_CAP_BYTES = 96 * 2 ** 20;

/** Save increase (bytes): coefficient × model input. */
export function saveHeapIncrement(
  method: SaveMethod,
  inputBytes: number,
  m: Pick<SaveModelInput, 'objectCount' | 'rawStreamBytes' | 'objectStreamBytes' | 'approximate'>,
  coefficients: Readonly<
    Record<SaveMethod, Readonly<SaveHeapCoefficients>>
  > = SAVE_HEAP_COEFFICIENTS,
): number {
  const c = coefficients[method];
  const raw = m.approximate ? Math.max(m.rawStreamBytes, inputBytes) : m.rawStreamBytes;
  const objectBytes = Math.max(0, inputBytes - raw) + m.objectStreamBytes;
  return (
    c.intercept +
    c.inputBytes * inputBytes +
    c.objectCount * m.objectCount +
    c.rawStreamBytes * raw +
    c.objectBytes * objectBytes
  );
}

const MIB = 2 ** 20;
const mib = (n: number) => `${(n / MIB).toFixed(0)} MiB`;

/** Expected peak heap. The coefficient model if `size.model` is present, otherwise the ratio model (the previous method). */
export function estimateSaveHeap(method: SaveMethod, size: SaveSizeInput): HeapEstimate {
  return size.model ? estimateSaveHeapModel(method, size) : estimateSaveHeapRatio(method, size);
}

const LEVEL_RANK: Readonly<Record<HeapLevel, number>> = { ok: 0, warn: 1, 'over-limit': 2 };

/** Determines the level from the ratio to the limit. */
function levelOf(fraction: number, warnFraction: number): HeapLevel {
  return fraction > 1 ? 'over-limit' : fraction > warnFraction ? 'warn' : 'ok';
}

/**
 * Used-heap estimate for a session with a previous save: the used estimate just before that save + the heap growth after the save. The space the save used and released, such as the save output buffer,
 * stays in linear memory (it does not shrink) but the next save reuses it. Only the share that grew after the save (rendering, editing) is treated as newly used.
 * Objects the save read in stay in the heap, but the previous save's increase already covered that share (docs/m5-heap.md 4.4).
 */
export function usedHeapAfterSave(
  prior: { usedHeapBytes: number; heapAfterBytes: number },
  currentHeapBytes: number,
): number {
  return prior.usedHeapBytes + Math.max(0, currentHeapBytes - prior.heapAfterBytes);
}

/** Peak obtained by adding the heap growth step to the need (`HEAP_GROWTH_FACTOR`, `HEAP_GROWTH_CAP_BYTES`). */
function grownPeak(need: number): number {
  return Math.min(need * HEAP_GROWTH_FACTOR, need + HEAP_GROWTH_CAP_BYTES);
}

/**
 * Coefficient model (D5): need = max(used heap, base + journal) + save increase, expected peak = max(current heap, min(need × 1.2, need +
 * 96 MiB)). The second expression covers the heap growth step (`HEAP_GROWTH_FACTOR`): even the same document had a peak that varied 938 → 1,430 MiB depending on pre-save history
 * (docs/m5-heap.md section 2). The used heap is the current heap on the first save, and `usedHeapAfterSave` if there was a previous save (4.4: using the current heap as is
 * would make the second save of a 525 MiB document an expected 2,279 MiB over-limit, while the measured value was 898 MiB).
 */
export function estimateSaveHeapModel(method: SaveMethod, size: SaveSizeInput): HeapEstimate {
  const m = size.model;
  if (!m) throw new Error('계수 모델 입력 없음');
  const limitBytes = size.limitBytes ?? WASM_HEAP_LIMIT_BYTES;
  const warnFraction = size.warnFraction ?? HEAP_WARN_FRACTION;
  const increment = saveHeapIncrement(method, size.inputBytes, m);
  const used = m.usedHeapBytes ?? m.currentHeapBytes;
  const docHeap = m.baseHeapBytes + m.journalBytes;
  const need = Math.max(used, docHeap) + increment;
  const estimatedPeakBytes = Math.ceil(Math.max(m.currentHeapBytes, grownPeak(need)));
  const fraction = estimatedPeakBytes / limitBytes;
  const level = levelOf(fraction, warnFraction);
  // If the level computed excluding the grown heap (base + journal) is lower, the grown heap is the basis of the classification.
  const docLevel = levelOf(grownPeak(docHeap + increment) / limitBytes, warnFraction);
  const grownHeapBasis = level !== 'ok' && LEVEL_RANK[docLevel] < LEVEL_RANK[level];
  const basis = `예상 피크 WASM 힙 ${mib(estimatedPeakBytes)}`;
  const message =
    level === 'over-limit'
      ? `${basis} 가 상한 ${mib(limitBytes)} 를 넘습니다. 저장이 메모리 부족으로 실패할 가능성이 높습니다.`
      : level === 'warn'
        ? `${basis} 가 상한 ${mib(limitBytes)} 의 ${Math.round(fraction * 100)}% 입니다. 저장이 실패할 수 있습니다.`
        : null;
  return {
    inputBytes: size.inputBytes,
    ratio: size.inputBytes > 0 ? estimatedPeakBytes / size.inputBytes : 0,
    estimatedPeakBytes,
    limitBytes,
    fraction,
    level,
    message,
    objectCount: m.objectCount,
    rawStreamBytes: m.rawStreamBytes,
    journalBytes: m.journalBytes,
    model: SAVE_HEAP_MODEL_ID,
    usedHeapBytes: used,
    ...(m.priorSavePeakBytes !== undefined ? { priorSavePeakBytes: m.priorSavePeakBytes } : {}),
    grownHeapBasis,
  };
}

/** Journal limit classification result (shared-types `JournalAdvice`, same shape as the Worker RPC `journalAdvice` response). */
export type { JournalAdvice };

/**
 * Journal limit classification (D4): if journal retention estimate + expected save increase > warning line, recommends "save, then reopen" (the wording is the viewer's; it is not attached to
 * the heap classification `message`). The warning line is the same as the warn boundary of the save heap classification.
 * MuPDF has no API to discard old steps from the journal, so it is classified by retained amount instead of step count (docs/m5-heap.md section 5).
 */
export function journalAdvice(method: SaveMethod, size: SaveSizeInput): JournalAdvice {
  const m = size.model;
  const limitBytes = size.limitBytes ?? WASM_HEAP_LIMIT_BYTES;
  const thresholdBytes = (size.warnFraction ?? HEAP_WARN_FRACTION) * limitBytes;
  const journalBytes = m?.journalBytes ?? 0;
  const incrementBytes = m ? saveHeapIncrement(method, size.inputBytes, m) : 0;
  return {
    advised: journalBytes > 0 && journalBytes + incrementBytes > thresholdBytes,
    journalBytes,
    incrementBytes,
    thresholdBytes,
  };
}

/**
 * Supported document size limit guidance value (bytes, PLAN.md section 7 risk 8). The input size at which, for an image-heavy document (original streams ≈ input, ignoring object count and object size),
 * the expected peak starts to exceed the limit when editing and then fully saving right after opening. For a larger document, opening notifies that "editing and saving may fail"
 * (the wording is the viewer's). The actual classification uses the expected peak from planSave.
 */
export function supportedInputBytes(
  method: SaveMethod = 'full',
  baseHeapBytes = BASE_HEAP_BYTES,
  limitBytes = WASM_HEAP_LIMIT_BYTES,
): number {
  const peak = (x: number) =>
    estimateSaveHeapModel(method, {
      inputBytes: x,
      limitBytes,
      model: {
        objectCount: 0,
        rawStreamBytes: x,
        objectStreamBytes: 0,
        currentHeapBytes: baseHeapBytes,
        baseHeapBytes,
        journalBytes: 0,
      },
    }).estimatedPeakBytes;
  let lo = 0;
  let hi = limitBytes;
  if (peak(hi) <= limitBytes) return hi;
  while (hi - lo > MIB) {
    const mid = Math.floor((lo + hi) / 2);
    if (peak(mid) <= limitBytes) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** mupdf 1.28.1 WASM initial linear memory (measured 22.0 MiB right after opening a document, docs/m5-heap.md section 2). */
export const BASE_HEAP_BYTES = 22 * MIB;

/** Expected peak heap = file size × measured ratio (ratio model `ratio-v0`, M0–M4). The level is determined from the ratio to the limit. */
export function estimateSaveHeapRatio(method: SaveMethod, size: SaveSizeInput): HeapEstimate {
  const ratio = size.ratio?.[method] ?? MEASURED_PEAK_HEAP_RATIO[method];
  const limitBytes = size.limitBytes ?? WASM_HEAP_LIMIT_BYTES;
  const warnFraction = size.warnFraction ?? HEAP_WARN_FRACTION;
  const estimatedPeakBytes = Math.ceil(size.inputBytes * ratio);
  const fraction = estimatedPeakBytes / limitBytes;
  const level = levelOf(fraction, warnFraction);
  const basis = `예상 피크 WASM 힙 ${mib(estimatedPeakBytes)}(파일 ${mib(size.inputBytes)} × ${ratio})`;
  const message =
    level === 'over-limit'
      ? `${basis} 가 상한 ${mib(limitBytes)} 를 넘습니다. 저장이 메모리 부족으로 실패할 가능성이 높습니다.`
      : level === 'warn'
        ? `${basis} 가 상한 ${mib(limitBytes)} 의 ${Math.round(fraction * 100)}% 입니다. 저장이 실패할 수 있습니다.`
        : null;
  return {
    inputBytes: size.inputBytes,
    ratio,
    estimatedPeakBytes,
    limitBytes,
    fraction,
    level,
    message,
    model: 'ratio-v0',
  };
}

/** Change types that allow incremental saving. Text and stream replacement are excluded because the original text remains in the earlier revision. */
const INCREMENTAL_SAFE: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['annotation', 'metadata']);

/**
 * Decides the save method from the change types and the `canBeSavedIncrementally()` result (PLAN.md 3.1).
 * - includes redaction → full save
 * - engine judges incremental save impossible → full save
 * - only annotation/metadata changes → incremental save
 * - otherwise (content stream replacement, font embedding) → full save
 *
 * If `size` is passed, also returns the expected peak heap (`heap`) for the chosen method. The save method is not changed
 * (incremental saving of a text replacement would leave the original text, so the caller warns/aborts before saving when over the limit).
 */
export function decideSaveMethod(
  changes: readonly ChangeKind[],
  canBeSavedIncrementally: boolean,
  size?: SaveSizeInput,
): SaveDecision {
  const withHeap = (d: SaveDecision): SaveDecision =>
    size ? { ...d, heap: estimateSaveHeap(d.method, size) } : d;
  const full = (reason: string): SaveDecision =>
    withHeap({ method: 'full', options: FULL_SAVE_OPTIONS, reason });
  if (changes.includes('redaction')) return full('redaction 적용 문서는 증분 저장 불가');
  if (!canBeSavedIncrementally) return full('canBeSavedIncrementally() = false');
  const unsafe = changes.filter((c) => !INCREMENTAL_SAFE.has(c));
  if (unsafe.length > 0) return full(`증분 저장 비대상 변경: ${unsafe.join(', ')}`);
  return withHeap({
    method: 'incremental',
    options: INCREMENTAL_SAVE_OPTIONS,
    reason: changes.length === 0 ? '변경 없음' : '주석·메타데이터 변경만 포함',
  });
}

/**
 * Supported document size limit guidance value (bytes): `supportedInputBytes('full')`. 790 MiB for an image-heavy document (828,375,040 B, docs/m5-heap.md section 6).
 * The viewer notifies that "editing and saving may fail" when the open document's `OpenResult.byteLength` exceeds this value.
 */
export const SUPPORTED_INPUT_BYTES = supportedInputBytes('full');
