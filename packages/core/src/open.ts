import * as mupdf from 'mupdf';
import type { DocumentStats, InputMode } from '@pdf-editor/shared-types';

export interface OpenPdfOptions {
  /**
   * buffer(기본): 입력을 WASM 힙으로 복사한다. 호출 뒤 `bytes` 를 바꿔도 된다.
   * stream: MuPDF 가 필요한 구간만 `bytes` 에서 읽는다(A3-1). 문서를 닫을 때까지 `bytes` 를 바꾸거나
   * 해제하면 안 된다.
   */
  inputMode?: InputMode;
  /** stream 에서 MuPDF 가 한 번 읽을 때마다 읽은 바이트 수로 호출한다(계측·테스트용). */
  onRead?: (length: number) => void;
}

/** JS 쪽 바이트를 MuPDF 읽기 콜백으로 연다. 입력이 WASM 힙에 복사되지 않는다. */
function openFromStream(bytes: Uint8Array, onRead?: (length: number) => void): mupdf.Document {
  const stream = new mupdf.Stream({
    fileSize: () => bytes.byteLength,
    read: (memory, offset, length, position) => {
      const n = Math.max(0, Math.min(length, bytes.byteLength - position));
      if (n > 0) memory.set(bytes.subarray(position, position + n), offset);
      onRead?.(n);
      return n;
    },
    close: () => {},
  });
  try {
    return mupdf.Document.openDocument(stream, 'application/pdf');
  } finally {
    // 문서가 자기 참조를 따로 갖는다. JS 래퍼의 참조는 바로 놓는다.
    stream.destroy();
  }
}

/**
 * 바이트를 WASM 버퍼로 복사해 연다. mupdf.js 1.28.1 `Document.openDocument` 는 Uint8Array·ArrayBuffer 를 받으면 임시
 * Buffer 를 만들고 문서를 연 직후 스스로 해제한다(문서는 버퍼 참조를 따로 잡는다). 그래서 여기서 래퍼를 따로 만들지 않는다.
 */
function openFromBuffer(bytes: Uint8Array | ArrayBuffer): mupdf.Document {
  return mupdf.Document.openDocument(bytes, 'application/pdf');
}

/** PDF 바이트를 연다. PDF 가 아니면 예외. */
export function openPdf(
  bytes: Uint8Array | ArrayBuffer,
  options: OpenPdfOptions = {},
): mupdf.PDFDocument {
  const mode = options.inputMode ?? 'buffer';
  const doc =
    mode === 'stream'
      ? openFromStream(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), options.onRead)
      : openFromBuffer(bytes);
  const pdf = doc.asPDF();
  if (!pdf) {
    doc.destroy();
    throw new Error('PDF 문서가 아님');
  }
  return pdf;
}

/** 문서 통계 계산 시간 예산(ms). 넘으면 남은 객체를 고정 간격 표본으로 환산한다(docs/m5-contract.md D5). */
export const DOCUMENT_STATS_BUDGET_MS = 1000;

/** 시험 표본 간격(객체 번호). 이 간격으로 먼저 훑어 객체당 시간을 잰다. */
const STATS_PILOT_STRIDE = 64;
/** 층화 표본 위치를 고르는 의사난수 시드. */
const STATS_SAMPLE_SEED = 0x2545f491;

/**
 * 저장 힙 모델 입력 전체. shared-types `DocumentStats` 에 core 내부 값 `objectStreamBytes` 를 더한다(공개 응답에는 앞의 네
 * 필드만 쓴다).
 */
export interface DocumentStatsDetail extends DocumentStats {
  /**
   * 객체 스트림(/Type /ObjStm)을 푼 크기 합(byte). 전체 저장은 모든 객체를 읽어 들이므로 저장 힙이 압축된 객체 스트림
   * 크기가 아니라 푼 크기를 따른다(nasa-se-handbook: 압축 0.38 MiB → 풀면 18.4 MiB, docs/m5-heap.md 3절).
   */
  objectStreamBytes: number;
}

export interface DocumentStatsOptions {
  budgetMs?: number;
  /** 시각(ms). 시험에서 바꾼다. 기본 `performance.now`. */
  now?: () => number;
}

/**
 * 저장 힙 모델 입력(D5): 객체 수, 스트림 수, 원 스트림 /Length 합, 객체 스트림을 푼 크기. 객체 번호마다 간접 참조를 만들어
 * `isStream()` 을 확인하고 사전의 /Length 를 더한다. 객체 스트림만 풀어서 길이를 재고(한 번에 하나, 바로 해제) 나머지
 * 스트림(이미지·콘텐츠)은 읽지 않는다.
 *
 * 먼저 `STATS_PILOT_STRIDE` 개 구간마다 하나씩 훑어 객체당 시간을 재고, 전수 계산이 예산 안이면 전부 센다. 넘으면 예산에
 * 맞춘 `stride` 개 구간마다 하나씩 층화 표본을 뽑고 표본 값에 구간 크기를 곱한다(`approximate: true`). 앞에서부터 세다 예산에서 멈추지 않는
 * 이유: 앞쪽 번호만 읽어 둔 문서는 뒤이은 저장의 피크가 크게 뛴다(합성 객체 2,000쪽 284 → 1,389 MiB, 간격 표본은 그대로,
 * docs/m5-heap.md 2.3).
 */
export function computeDocumentStats(
  doc: mupdf.PDFDocument,
  options: DocumentStatsOptions = {},
): DocumentStatsDetail {
  const budget = options.budgetMs ?? DOCUMENT_STATS_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const objectCount = doc.countObjects();
  const sum = { streams: 0, bytes: 0, objstm: 0 };
  const visit = (num: number, weight: number): void => {
    const ref = doc.newIndirect(num);
    try {
      if (!ref.isStream()) return;
      sum.streams += weight;
      const length = ref.get('Length');
      if (length.isNumber()) sum.bytes += Math.max(0, length.asNumber()) * weight;
      length.destroy();
      const type = ref.get('Type');
      if (type.isName() && type.asName() === 'ObjStm') {
        const decoded = ref.readStream();
        sum.objstm += decoded.getLength() * weight;
        decoded.destroy();
      }
      type.destroy();
    } catch {
      // 손상된 객체는 세지 않는다(MuPDF 가 xref 복구로 연 문서).
    } finally {
      ref.destroy();
    }
  };
  // 층화 표본: 1 번부터 `stride` 개씩 구간을 나눠 구간마다 한 객체를 고른다(0 번은 xref 자유 목록 머리라 객체가 아니다).
  // 고르는 위치는 고정 시드 의사난수라 같은 문서는 같은 표본이다. 구간 첫 객체만 고르면 문서의 객체 배치 주기와 맞물려
  // 한 종류(예: 쪽마다 콘텐츠 스트림)를 통째로 놓친다(docs/m5-heap.md 2.4). 마지막 구간은 남은 수만큼만 센다.
  const pass = (stride: number): void => {
    sum.streams = sum.bytes = sum.objstm = 0;
    let seed = STATS_SAMPLE_SEED;
    for (let start = 1; start < objectCount; start += stride) {
      const width = Math.min(stride, objectCount - start);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      visit(stride === 1 ? start : start + (seed % width), width);
    }
  };
  const t0 = now();
  pass(STATS_PILOT_STRIDE);
  const pilotMs = now() - t0;
  const pilotCount = Math.max(1, Math.ceil((objectCount - 1) / STATS_PILOT_STRIDE));
  const predictedMs = (pilotMs / pilotCount) * Math.max(0, objectCount - 1);
  const stride =
    predictedMs <= budget
      ? 1
      : Math.min(STATS_PILOT_STRIDE, Math.max(2, Math.ceil(predictedMs / budget)));
  if (stride !== STATS_PILOT_STRIDE) pass(stride);
  return {
    objectCount,
    streamCount: Math.round(sum.streams),
    rawStreamBytes: Math.round(sum.bytes),
    objectStreamBytes: Math.round(sum.objstm),
    approximate: stride > 1,
  };
}
