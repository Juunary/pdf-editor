import type { ChangeKind, SaveMethod } from '@pdf-editor/shared-types';

export type HeapLevel = 'ok' | 'warn' | 'over-limit';

/** 저장 전 예상 피크 WASM 힙(PLAN.md 3.1·5.4, docs/m0-day1-log.md A4). */
export interface HeapEstimate {
  inputBytes: number;
  /** 적용한 배율(피크 WASM 힙 ÷ 입력 파일 크기) */
  ratio: number;
  /** inputBytes × ratio */
  estimatedPeakBytes: number;
  limitBytes: number;
  /** estimatedPeakBytes ÷ limitBytes */
  fraction: number;
  level: HeapLevel;
  /** level 이 ok 가 아니면 사용자 메시지 */
  message: string | null;
}

export interface SaveDecision {
  method: SaveMethod;
  /** MuPDF `PDFDocument.saveToBuffer` 옵션 문자열. */
  options: string;
  reason: string;
  /** `size` 를 넘긴 경우에만 */
  heap?: HeapEstimate;
}

/** 전체 저장 옵션. 미사용 객체 제거·번호 압축 + 스트림 압축. */
export const FULL_SAVE_OPTIONS = 'garbage=compact,compress';
export const INCREMENTAL_SAVE_OPTIONS = 'incremental';

/**
 * 저장 피크 WASM 힙 ÷ 입력 파일 크기 실측 배율. docs/m0-day1-log.md 6.5(실측 2026-10-18, 서버 Node,
 * 합성 100쪽·300쪽, 입력을 WASM 힙에 복사하는 `openDocument(bytes)` 경로)의 큰 값.
 * 전체 4.48(100쪽)·2.85(300쪽), 증분 3.98(100쪽)·3.50(300쪽).
 */
export const MEASURED_PEAK_HEAP_RATIO: Readonly<Record<SaveMethod, number>> = Object.freeze({
  full: 4.48,
  incremental: 3.98,
});

/**
 * 입력을 WASM 힙에 복사하지 않는 `new Stream(handle)` 열기 경로의 실측 배율(실측 2026-10-18, 서버 Node,
 * docs/m0-dod-xobject-redact-save.md 3.3). 합성 100쪽에서 최대: 전체 3.48·증분 2.98.
 * core 가 Stream 입력으로 바뀌면 `SaveSizeInput.ratio` 로 넘긴다.
 */
export const STREAM_INPUT_PEAK_HEAP_RATIO: Readonly<Record<SaveMethod, number>> = Object.freeze({
  full: 3.48,
  incremental: 2.98,
});

/** mupdf 1.28.1 WASM 선형 메모리 상한(emscripten 최대 힙 2,147,483,648 B, `mupdf-wasm.js`). */
export const WASM_HEAP_LIMIT_BYTES = 2 ** 31;

/** 예상 피크가 상한의 이 비율을 넘으면 경고. */
export const HEAP_WARN_FRACTION = 0.75;

export interface SaveSizeInput {
  /** 입력(원본) 파일 크기 byte */
  inputBytes: number;
  limitBytes?: number;
  warnFraction?: number;
  ratio?: Partial<Record<SaveMethod, number>>;
}

const MIB = 2 ** 20;
const mib = (n: number) => `${(n / MIB).toFixed(0)} MiB`;

/** 예상 피크 힙 = 파일 크기 × 실측 배율. 상한 대비 비율로 수준을 정한다. */
export function estimateSaveHeap(method: SaveMethod, size: SaveSizeInput): HeapEstimate {
  const ratio = size.ratio?.[method] ?? MEASURED_PEAK_HEAP_RATIO[method];
  const limitBytes = size.limitBytes ?? WASM_HEAP_LIMIT_BYTES;
  const warnFraction = size.warnFraction ?? HEAP_WARN_FRACTION;
  const estimatedPeakBytes = Math.ceil(size.inputBytes * ratio);
  const fraction = estimatedPeakBytes / limitBytes;
  const level: HeapLevel = fraction > 1 ? 'over-limit' : fraction > warnFraction ? 'warn' : 'ok';
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
  };
}

/** 증분 저장을 허용하는 변경 유형. 텍스트·스트림 교체는 이전 리비전에 원문이 남으므로 제외한다. */
const INCREMENTAL_SAFE: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['annotation', 'metadata']);

/**
 * 변경 유형과 `canBeSavedIncrementally()` 결과로 저장 방식을 정한다(PLAN.md 3.1).
 * - redaction 포함 → 전체 저장
 * - 엔진이 증분 저장 불가로 판단 → 전체 저장
 * - 주석·메타데이터만 변경 → 증분 저장
 * - 그 외(콘텐츠 스트림 교체, 폰트 임베딩) → 전체 저장
 *
 * `size` 를 넘기면 정한 방식의 예상 피크 힙(`heap`)을 함께 돌려준다. 저장 방식은 바꾸지 않는다
 * (텍스트 교체를 증분 저장으로 돌리면 원문이 남으므로, 상한 초과는 호출자가 저장 전 경고·중단한다).
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
