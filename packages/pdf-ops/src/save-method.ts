import type { ChangeKind, JournalAdvice, SaveMethod } from '@pdf-editor/shared-types';

export type HeapLevel = 'ok' | 'warn' | 'over-limit';

/** 저장 전 예상 피크 WASM 힙(PLAN.md 3.1·5.4, docs/m0-day1-log.md A4, docs/m5-heap.md). */
export interface HeapEstimate {
  inputBytes: number;
  /** 배율 모델: 적용한 배율. 계수 모델: estimatedPeakBytes ÷ inputBytes(참고값) */
  ratio: number;
  estimatedPeakBytes: number;
  limitBytes: number;
  /** estimatedPeakBytes ÷ limitBytes */
  fraction: number;
  level: HeapLevel;
  /** level 이 ok 가 아니면 사용자 메시지 */
  message: string | null;
  /** 계수 모델 입력(shared-types `SaveHeapEstimate` 와 같은 이름). 배율 모델이면 없음 */
  objectCount?: number;
  rawStreamBytes?: number;
  journalBytes?: number;
  /** 적용한 모델(`ratio-v0` 배율, `SAVE_HEAP_MODEL_ID` 계수) */
  model?: string;
  /** 계수 모델: 예상에 쓴 사용 중 힙 추정(직전 저장이 있으면 `usedHeapAfterSave`, 없으면 현재 힙) */
  usedHeapBytes?: number;
  /** 계수 모델: 이 세션 직전 저장 직후 WASM 힙(실측 피크). 저장한 적이 없으면 없음 */
  priorSavePeakBytes?: number;
  /**
   * 계수 모델: warn·over-limit 판정이 이미 커진 힙 때문이다. 사용 중 힙 추정 대신 기본 + 저널로 계산하면 수준이 더 낮다.
   * WASM 선형 메모리는 줄지 않아 커진 힙에는 다시 쓸 수 있는 빈 공간이 섞여 있으므로, 뷰어는 over-limit 이라도 "그래도 저장
   * 시도" 를 허용한다(실패하면 Worker 복구 경로)
   */
  grownHeapBasis?: boolean;
}

export interface SaveDecision {
  method: SaveMethod;
  /** MuPDF `PDFDocument.saveToBuffer` 옵션 문자열. */
  options: string;
  reason: string;
  /** `size` 를 넘긴 경우에만 */
  heap?: HeapEstimate;
}

/**
 * 전체 저장 옵션: 미사용 객체 제거(번호 유지) + 스트림 압축(A3-6) + 객체 스트림·xref 스트림(A3-7, 2026-10-19 결정).
 * `garbage=compact`(번호 압축)·`deduplicate` 는 쓰지 않는다. MuPDF 1.28.x 는 이미지 XObject 를 `resolve()` 한
 * 문서를 compact 저장하면 그 이미지 스트림을 잃는다(ArtifexSoftware/mupdf.js#201). `garbage=yes` 는 이 경로를
 * 타지 않고, 피크 WASM 힙은 compact 와 같으며 출력만 수십 바이트 크다. `objstms` 가 없으면 객체 스트림 구조 원본이
 * 풀린 채 저장되어 출력이 입력의 최대 6.12배가 된다. `objstms` 를 더한 출력은 객체 단위·3개 엔진 렌더가 같고
 * PDF-1.4 원본의 헤더를 1.5 로 올린다(docs/m0-dod-xobject-redact-save.md 3.3).
 */
export const FULL_SAVE_OPTIONS = 'garbage=yes,compress,objstms';
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
  /** 배율 모델 배율(`model` 이 없을 때만 쓴다) */
  ratio?: Partial<Record<SaveMethod, number>>;
  /** 계수 모델 입력. 있으면 계수 모델(`estimateSaveHeapModel`)로 계산한다 */
  model?: SaveModelInput;
}

/**
 * 계수 모델 입력(docs/m5-contract.md D5, docs/m5-heap.md 3절). 문서 통계는 첫 쪽 표시 뒤 유휴 시 한 번 계산하고
 * (core `computeDocumentStats`), 힙 값은 planSave 시점에 읽는다.
 */
export interface SaveModelInput {
  objectCount: number;
  /** 원 스트림 /Length 합(디코드 안 함) */
  rawStreamBytes: number;
  /** 객체 스트림(/ObjStm)을 푼 크기 합 */
  objectStreamBytes: number;
  /**
   * 객체 수·원 스트림 합이 표본 추정이다. 표본은 큰 스트림 몇 개를 놓쳐 원 스트림 합을 크게 줄여 볼 수 있으므로, 증가분은
   * 원 스트림 = max(표본 값, 입력 크기)로 계산한다. 이 보정은 (입력 − 원 스트림) 몫을 객체 크기 계수에서 원 스트림 계수로
   * 옮길 뿐이고(c > e 라 그 몫은 커진다) 객체 스트림 푼 크기는 덮지 않는다. 그래서 `objectStreamBytes` 는 표본과 무관하게
   * 전수 값이어야 한다(core `computeDocumentStats`)
   */
  approximate?: boolean;
  /** 지금 WASM 선형 메모리 크기 */
  currentHeapBytes: number;
  /**
   * 사용 중 힙 추정. 생략하면 `currentHeapBytes`. WASM 선형 메모리는 줄지 않아 저장 뒤 현재 힙은 저장이 쓰고 놓은 빈 공간을
   * 포함한다. 세션은 직전 저장이 있으면 `usedHeapAfterSave` 로 계산해 넣는다
   */
  usedHeapBytes?: number;
  /** 이 세션 직전 저장 직후 WASM 힙(결과 표시용) */
  priorSavePeakBytes?: number;
  /** 문서 열기 완료 직후 WASM 선형 메모리 크기 */
  baseHeapBytes: number;
  /** 저널 보유 추정(교체한 스트림 길이 합, D4) */
  journalBytes: number;
}

/** 저장 증가분 계수(byte 당 byte, 객체 1개당 byte). docs/m5-heap.md 3절 적합 결과. */
export interface SaveHeapCoefficients {
  /** 고정분 byte */
  intercept: number;
  inputBytes: number;
  objectCount: number;
  rawStreamBytes: number;
  /** (입력 − 원 스트림) + 객체 스트림을 푼 크기: 객체 사전·배열 텍스트의 대략 크기 */
  objectBytes: number;
}

/** 계수 모델 식별자. 계수나 식을 바꾸면 올린다. */
export const SAVE_HEAP_MODEL_ID = 'step-v2';

/**
 * 저장 경로별 계수(docs/m5-heap.md 3·4절, `tools/bench/heap-fit.mjs` 형태 `lp/objbytes/step+d/prior`). 적합 표본 전부를
 * 덮는다는 제약(미탐 0) 아래 상대 과대 추정 합을 최소화한 계수(선형 계획, 객체 수 ≥ 400 B/개·객체 크기 ≥ 1.5 하한)에
 * 안전 여유(전체: 증가분 × 1.05 + 4 MiB, 증분: × 1.1)를 더하고 올림했다. 측정: 서버 Node 22, mupdf 1.28.1, Stream 입력,
 * 코퍼스 24건 + 합성 이미지 100–1,200쪽 + 합성 객체 500–2,000쪽, 저장 전 보기 0·3·10·30쪽(304회).
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
 * emscripten 힙 확장 규칙(docs/m0-dod-xobject-redact-save.md 3.1): 새 크기 = max(요청, 현재 × 1.2), 단 요청 + 96 MiB 이하.
 * 필요량이 현재 힙을 넘으면 선형 메모리가 필요량의 최대 1.2배(또는 + 96 MiB)까지 커진다.
 */
export const HEAP_GROWTH_FACTOR = 1.2;
export const HEAP_GROWTH_CAP_BYTES = 96 * 2 ** 20;

/** 저장 증가분(byte): 계수 × 모델 입력. */
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

/** 예상 피크 힙. `size.model` 이 있으면 계수 모델, 없으면 배율 모델(이전 방식). */
export function estimateSaveHeap(method: SaveMethod, size: SaveSizeInput): HeapEstimate {
  return size.model ? estimateSaveHeapModel(method, size) : estimateSaveHeapRatio(method, size);
}

const LEVEL_RANK: Readonly<Record<HeapLevel, number>> = { ok: 0, warn: 1, 'over-limit': 2 };

/** 상한 대비 비율로 수준을 정한다. */
function levelOf(fraction: number, warnFraction: number): HeapLevel {
  return fraction > 1 ? 'over-limit' : fraction > warnFraction ? 'warn' : 'ok';
}

/**
 * 직전 저장이 있는 세션의 사용 중 힙 추정: 그 저장 직전 사용 추정 + 저장 뒤 늘어난 힙. 저장 출력 버퍼 등 저장이 쓰고 놓은
 * 공간은 선형 메모리에 남지만(줄지 않음) 다음 저장이 다시 쓴다. 저장 뒤 커진 몫(렌더·편집)만 새로 쓰는 것으로 본다.
 * 저장이 읽어 들인 객체는 계속 힙에 남지만 직전 저장 증가분이 이미 그 몫을 덮었다(docs/m5-heap.md 4.4).
 */
export function usedHeapAfterSave(
  prior: { usedHeapBytes: number; heapAfterBytes: number },
  currentHeapBytes: number,
): number {
  return prior.usedHeapBytes + Math.max(0, currentHeapBytes - prior.heapAfterBytes);
}

/** 필요량에 힙 확장 계단을 더한 피크(`HEAP_GROWTH_FACTOR`·`HEAP_GROWTH_CAP_BYTES`). */
function grownPeak(need: number): number {
  return Math.min(need * HEAP_GROWTH_FACTOR, need + HEAP_GROWTH_CAP_BYTES);
}

/**
 * 계수 모델(D5): 필요량 = max(사용 중 힙, 기본 + 저널) + 저장 증가분, 예상 피크 = max(현재 힙, min(필요량 × 1.2, 필요량 +
 * 96 MiB)). 둘째 식은 힙 확장 계단(`HEAP_GROWTH_FACTOR`)을 덮는다: 같은 문서도 저장 전 이력에 따라 피크가 938 → 1,430 MiB 로
 * 달라졌다(docs/m5-heap.md 2절). 사용 중 힙은 처음 저장이면 현재 힙, 직전 저장이 있으면 `usedHeapAfterSave`(4.4: 현재 힙을 그대로
 * 쓰면 525 MiB 문서 두 번째 저장이 예상 2,279 MiB over-limit, 실측 898 MiB 였다).
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
  // 커진 힙을 빼고(기본 + 저널) 계산한 수준이 더 낮으면 판정 근거가 커진 힙이다.
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

/** 저널 상한 판정 결과(shared-types `JournalAdvice`, Worker RPC `journalAdvice` 응답과 같은 모양). */
export type { JournalAdvice };

/**
 * 저널 상한 판정(D4): 저널 보유 추정 + 예상 저장 증가분 > 경고선이면 "저장 후 다시 열기" 를 권한다(문구는 뷰어, 힙 판정
 * `message` 에는 붙이지 않는다). 경고선은 저장 힙 판정의
 * warn 경계와 같다. 저널은 MuPDF 에 오래된 단계를 버리는 API 가 없어 단계 수 대신 보유량으로 판정한다(docs/m5-heap.md 5절).
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
 * 지원 문서 크기 상한 안내 값(byte, PLAN.md 7절 리스크 8). 이미지 위주 문서(원 스트림 ≈ 입력, 객체 수·객체 크기 무시)를
 * 열자마자 편집 후 전체 저장할 때 예상 피크가 상한을 넘기 시작하는 입력 크기. 이보다 큰 문서는 열 때 "편집·저장이 실패할 수
 * 있음" 을 알린다(문구는 뷰어). 실제 판정은 planSave 의 예상 피크로 한다.
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

/** mupdf 1.28.1 WASM 초기 선형 메모리(문서 열기 직후 실측 22.0 MiB, docs/m5-heap.md 2절). */
export const BASE_HEAP_BYTES = 22 * MIB;

/** 예상 피크 힙 = 파일 크기 × 실측 배율(배율 모델 `ratio-v0`, M0–M4). 상한 대비 비율로 수준을 정한다. */
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

/**
 * 지원 문서 크기 상한 안내 값(byte): `supportedInputBytes('full')`. 이미지 위주 문서 기준 790 MiB(828,375,040 B, docs/m5-heap.md 6절).
 * 뷰어는 열린 문서의 `OpenResult.byteLength` 가 이 값을 넘으면 "편집·저장이 실패할 수 있음" 을 알린다.
 */
export const SUPPORTED_INPUT_BYTES = supportedInputBytes('full');
