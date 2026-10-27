import * as mupdf from 'mupdf';
import type { DocumentStats, InputMode } from '@pdf-editor/shared-types';

export interface OpenPdfOptions {
  /**
   * buffer (default): copies the input into the WASM heap. `bytes` may be changed after the call.
   * stream: MuPDF reads only the ranges it needs from `bytes` (A3-1). Until the document is closed, `bytes` must not be modified or
   * released.
   */
  inputMode?: InputMode;
  /** Called with the number of bytes read each time MuPDF reads from the stream (for measurement and tests). */
  onRead?: (length: number) => void;
}

/** Opens JS-side bytes through a MuPDF read callback. The input is not copied into the WASM heap. */
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
    // The document keeps its own reference. Release the JS wrapper's reference right away.
    stream.destroy();
  }
}

/**
 * Copies the bytes into a WASM buffer and opens them. When mupdf.js 1.28.1 `Document.openDocument` receives a Uint8Array or ArrayBuffer, it creates a temporary
 * Buffer and releases it itself right after opening the document (the document holds its own reference to the buffer). So no separate wrapper is created here.
 */
function openFromBuffer(bytes: Uint8Array | ArrayBuffer): mupdf.Document {
  return mupdf.Document.openDocument(bytes, 'application/pdf');
}

/** Opens PDF bytes. Throws if the input is not a PDF. */
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

/** Time budget (ms) for computing document stats. If exceeded, the remaining objects are extrapolated from a fixed-interval sample (docs/m5-contract.md D5). */
export const DOCUMENT_STATS_BUDGET_MS = 1000;

/** Pilot sample interval (object numbers). A first pass at this interval measures the time per object. */
const STATS_PILOT_STRIDE = 64;
/** Pseudo-random seed for choosing stratified sample positions. */
const STATS_SAMPLE_SEED = 0x2545f491;

/**
 * Full input of the save-heap model. Adds the core-internal value `objectStreamBytes` to shared-types `DocumentStats` (only the first four
 * fields are used in public responses).
 */
export interface DocumentStatsDetail extends DocumentStats {
  /**
   * Total size (bytes) of the object streams (/Type /ObjStm) after decompression. A full save reads every object, so the save heap follows the decompressed size
   * rather than the compressed object stream size (nasa-se-handbook: 0.38 MiB compressed -> 18.4 MiB decompressed, docs/m5-heap.md section 3).
   */
  objectStreamBytes: number;
}

export interface DocumentStatsOptions {
  budgetMs?: number;
  /**
   * Original file bytes. If present, object stream numbers are read from the xref and only the object streams are decompressed exhaustively (`objectStreamNumbers`). If absent or the xref
   * cannot be read, the object stream numbers are unknown, so everything is counted exhaustively regardless of the budget.
   */
  bytes?: Uint8Array;
  /** Clock (ms). Overridden in tests. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Input of the save-heap model (D5): object count, stream count, sum of raw stream /Length, decompressed size of object streams. For each object number, creates an indirect reference,
 * checks `isStream()` and adds the dictionary's /Length. Only object streams are decompressed to measure their length (one at a time, released immediately); the other
 * streams (images, content) are not read.
 *
 * First pass: visit one object per `STATS_PILOT_STRIDE`-sized interval to measure the time per object; if an exhaustive count fits in the budget, count everything. Otherwise,
 * draw a stratified sample with one object per `stride`-sized interval sized to the budget and multiply the sampled values by the interval size (`approximate: true`). Why not count from the start and stop at the budget:
 * a document where only the leading numbers have been read makes the peak of the following save jump (synthetic 2,000-page object 284 -> 1,389 MiB, while the interval sample is unchanged,
 * docs/m5-heap.md 2.3).
 *
 * The decompressed size of object streams is not estimated by sampling (M1): object streams are rare relative to the object count (one per several hundred objects), so a sample that misses them underestimates
 * close to 0, and the model's sample correction (raw stream = input) does not cover this share. Read the object stream
 * numbers from the xref in `options.bytes` and decompress only those exhaustively; if the numbers are unknown, count everything exhaustively.
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
      // Corrupt objects are not counted (a document MuPDF opened by repairing the xref).
    } finally {
      ref.destroy();
    }
  };
  // Stratified sample: split the numbers from 1 into intervals of `stride` and pick one object per interval (object 0 is the head of the xref free list, not an object).
  // The position within each interval is chosen by a fixed-seed pseudo-random generator, so the same document gets the same sample. Picking only the first object of each interval could line up with the document's object layout period and
  // miss a whole kind of object (e.g. a content stream per page) (docs/m5-heap.md 2.4). The last interval counts only the remaining numbers.
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
  // If the object stream numbers are unknown, a sample could miss the object streams, so count exhaustively even over budget.
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
        // Corrupt object streams are not counted.
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

/** `bytes[from..to)` as a latin1 string. */
function latin1(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let i = Math.max(0, from); i < Math.min(to, bytes.length); i++)
    out += String.fromCharCode(bytes[i]!);
  return out;
}

/** Position of the first occurrence of ASCII `pattern` at or after `from`. -1 if none. */
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

/** Position of the last occurrence of ASCII `pattern`. -1 if none. */
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

/** Integer PDF object value. null if not a number. The object is released. */
function takeNumber(obj: mupdf.PDFObject): number | null {
  try {
    return obj.isNumber() ? obj.asNumber() : null;
  } finally {
    obj.destroy();
  }
}

/**
 * From one xref stream, collects the numbers of object streams that contain compressed objects (type 2) and pushes /Prev to `queue`. false if it is not an xref stream or
 * its format does not match.
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
 * From the original file's xref (classic table or xref stream, /Prev and /XRefStm chain), collects the numbers of object streams that contain compressed objects. null if the xref cannot be
 * read (e.g. a document MuPDF recovered because of corruption or leading garbage bytes). A document with only classic tables yields an empty set.
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
