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
  /**
   * 원본 파일 바이트. 있으면 xref 에서 객체 스트림 번호를 읽어 객체 스트림만 전수로 푼다(`objectStreamNumbers`). 없거나 xref 를
   * 읽지 못하면 객체 스트림 번호를 알 수 없으므로 예산과 무관하게 전수로 센다.
   */
  bytes?: Uint8Array;
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
 *
 * 객체 스트림 푼 크기는 표본으로 세지 않는다(M1): 객체 스트림은 객체 수에 비해 드물어(수백 객체당 1개) 표본이 놓치면 0 에
 * 가깝게 과소 추정하고, 모델의 표본 보정(원 스트림 = 입력)은 이 몫을 덮지 않는다. `options.bytes` 의 xref 에서 객체 스트림
 * 번호를 읽어 그것만 전수로 풀고, 번호를 알 수 없으면 전체를 전수로 센다.
 */
export function computeDocumentStats(
  doc: mupdf.PDFDocument,
  options: DocumentStatsOptions = {},
): DocumentStatsDetail {
  const budget = options.budgetMs ?? DOCUMENT_STATS_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const objectCount = doc.countObjects();
  const objstms = options.bytes ? objectStreamNumbers(doc, options.bytes) : null;
  const sum = { streams: 0, bytes: 0, objstm: 0 };
  const decodedLength = (ref: mupdf.PDFObject): number => {
    const decoded = ref.readStream();
    try {
      return decoded.getLength();
    } finally {
      decoded.destroy();
    }
  };
  const visit = (num: number, weight: number): void => {
    const ref = doc.newIndirect(num);
    try {
      if (!ref.isStream()) return;
      sum.streams += weight;
      const length = ref.get('Length');
      if (length.isNumber()) sum.bytes += Math.max(0, length.asNumber()) * weight;
      length.destroy();
      if (objstms) return;
      const type = ref.get('Type');
      if (type.isName() && type.asName() === 'ObjStm') sum.objstm += decodedLength(ref) * weight;
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
  // 객체 스트림 번호를 모르면 표본이 객체 스트림을 놓칠 수 있으므로 예산을 넘어도 전수로 센다.
  const stride =
    predictedMs <= budget || !objstms
      ? 1
      : Math.min(STATS_PILOT_STRIDE, Math.max(2, Math.ceil(predictedMs / budget)));
  if (stride !== STATS_PILOT_STRIDE) pass(stride);
  if (objstms) {
    sum.objstm = 0;
    for (const num of objstms) {
      if (num <= 0 || num >= objectCount) continue;
      const ref = doc.newIndirect(num);
      try {
        const type = ref.isStream() ? ref.get('Type') : null;
        if (type?.isName() && type.asName() === 'ObjStm') sum.objstm += decodedLength(ref);
        type?.destroy();
      } catch {
        // 손상된 객체 스트림은 세지 않는다.
      } finally {
        ref.destroy();
      }
    }
  }
  return {
    objectCount,
    streamCount: Math.round(sum.streams),
    rawStreamBytes: Math.round(sum.bytes),
    objectStreamBytes: Math.round(sum.objstm),
    approximate: stride > 1,
  };
}

/** `bytes[from..to)` 를 latin1 문자열로. */
function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = Math.max(0, from); i < Math.min(to, bytes.length); i++)
    out += String.fromCharCode(bytes[i]!);
  return out;
}

/** ASCII `pattern` 이 `from` 이후 처음 나오는 위치. 없으면 -1. */
function indexOfAscii(bytes: Uint8Array, pattern: string, from: number): number {
  const first = pattern.charCodeAt(0);
  outer: for (let i = Math.max(0, from); i <= bytes.length - pattern.length; i++) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < pattern.length; k++)
      if (bytes[i + k] !== pattern.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** ASCII `pattern` 이 마지막으로 나오는 위치. 없으면 -1. */
function lastIndexOfAscii(bytes: Uint8Array, pattern: string): number {
  const first = pattern.charCodeAt(0);
  outer: for (let i = bytes.length - pattern.length; i >= 0; i--) {
    if (bytes[i] !== first) continue;
    for (let k = 1; k < pattern.length; k++)
      if (bytes[i + k] !== pattern.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** 정수 PDF 객체 값. 숫자가 아니면 null. 객체는 놓는다. */
function takeNumber(obj: mupdf.PDFObject): number | null {
  try {
    return obj.isNumber() ? obj.asNumber() : null;
  } finally {
    obj.destroy();
  }
}

/**
 * xref 스트림 하나에서 압축 객체(유형 2)가 든 객체 스트림 번호를 모으고 /Prev 를 `queue` 에 넣는다. xref 스트림이 아니거나
 * 형식이 맞지 않으면 false.
 */
function readXrefStream(ref: mupdf.PDFObject, out: Set<number>, queue: number[]): boolean {
  if (!ref.isStream()) return false;
  const type = ref.get('Type');
  const isXref = type.isName() && type.asName() === 'XRef';
  type.destroy();
  if (!isXref) return false;
  const wObj = ref.get('W');
  const w =
    wObj.isArray() && wObj.length === 3 ? [0, 1, 2].map((i) => takeNumber(wObj.get(i))) : [];
  wObj.destroy();
  if (w.length !== 3 || w.some((v) => v === null || v < 0 || v > 8)) return false;
  const [w0, w1, w2] = w as [number, number, number];
  const size = takeNumber(ref.get('Size'));
  if (size === null) return false;
  const idxObj = ref.get('Index');
  const index: number[] = [];
  if (idxObj.isArray()) {
    for (let i = 0; i < idxObj.length; i++) index.push(takeNumber(idxObj.get(i)) ?? -1);
  } else index.push(0, size);
  idxObj.destroy();
  if (index.length % 2 !== 0 || index.some((v) => v < 0)) return false;
  const prev = takeNumber(ref.get('Prev'));
  if (prev !== null) queue.push(prev);
  const buffer = ref.readStream();
  try {
    const data = buffer.asUint8Array();
    const record = w0 + w1 + w2;
    const field = (at: number, width: number): number => {
      let v = 0;
      for (let k = 0; k < width; k++) v = v * 256 + data[at + k]!;
      return v;
    };
    let at = 0;
    for (let k = 0; k < index.length; k += 2) {
      for (let i = 0; i < index[k + 1]!; i++, at += record) {
        if (at + record > data.length) return false;
        const kind = w0 === 0 ? 1 : field(at, w0);
        if (kind === 2) out.add(field(at + w0, w1));
      }
    }
  } finally {
    buffer.destroy();
  }
  return true;
}

/**
 * 원본 파일의 xref(전통 표·xref 스트림, /Prev·/XRefStm 사슬)에서 압축 객체가 든 객체 스트림 번호를 모은다. xref 를 읽지
 * 못하면(손상·앞쪽 쓰레기 바이트로 MuPDF 가 복구한 문서 등) null. 전통 표만 있는 문서는 빈 집합이다.
 */
export function objectStreamNumbers(doc: mupdf.PDFDocument, bytes: Uint8Array): Set<number> | null {
  try {
    const sx = lastIndexOfAscii(bytes, 'startxref');
    const start = sx < 0 ? null : /^startxref\s+(\d+)/.exec(latin1(bytes, sx, sx + 40));
    if (!start) return null;
    const out = new Set<number>();
    const queue = [Number(start[1])];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const offset = queue.shift()!;
      if (seen.has(offset)) continue;
      if (offset < 0 || offset >= bytes.length) return null;
      seen.add(offset);
      const head = latin1(bytes, offset, offset + 64).replace(/^\s+/, '');
      if (head.startsWith('xref')) {
        const t = indexOfAscii(bytes, 'trailer', offset);
        if (t < 0) return null;
        const end = indexOfAscii(bytes, 'startxref', t);
        const trailer = latin1(bytes, t, end < 0 ? t + 4096 : end);
        for (const key of ['Prev', 'XRefStm']) {
          const m = new RegExp(`/${key}\\s+(\\d+)`).exec(trailer);
          if (m) queue.push(Number(m[1]));
        }
        continue;
      }
      const obj = /^(\d+)\s+\d+\s+obj\b/.exec(head);
      if (!obj) return null;
      const ref = doc.newIndirect(Number(obj[1]));
      try {
        if (!readXrefStream(ref, out, queue)) return null;
      } finally {
        ref.destroy();
      }
    }
    return out;
  } catch {
    return null;
  }
}
