/**
 * Compresses large streams rewritten in an unpacked state by editing with Flate and puts them back (M5 Windows check W2, docs/m5-followup.md 5.1).
 *
 * Page content and Form copies are written by `writeStreamBytes` (MuPDF `writeStream`) and hold the unpacked bytes without a filter. The MuPDF journal
 * keeps the pre-operation contents of each changed object per operation, including the stream buffer, so for a page with a large unpacked size (corpus kogl-mods-cpi-202609 page 9, 8.9 MB)
 * that much stays in the journal on every first paragraph edit. If compressed just before commit (inside the same operation), the buffer the next edit hands to the journal becomes the compressed
 * size (1.35 MB for the same page). The original file's content is also Flate, so after compression the bytes that rendering and extraction read are handled the same way as before editing.
 *
 * Compression uses the platform `CompressionStream('deflate')` (zlib format, Chrome Worker, Node 18+). If it is missing or fails, the stream is left as is (only
 * less memory is saved and behavior is the same). After insertion it is unpacked again with MuPDF and compared with the original bytes; if different, it is reverted to the unpacked bytes.
 */
import * as mupdf from 'mupdf';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';

/** Streams smaller than this are not compressed (edit blocks, etc.: the journal holds little, and each commit would only gain an async step). */
export const COMPACT_MIN_BYTES = 64 * 1024;

export interface UncompressedStream {
  objectNumber: number;
  /** Current unpacked bytes of the stream (same as the stored bytes since there is no filter). */
  bytes: Uint8Array;
}

/**
 * Streams to compress among the object numbers: streams with no filter or DecodeParms, length at least `minBytes`, that are not images or metadata
 * (page content, Form). The bytes are read synchronously.
 */
export function uncompressedStreams(
  doc: mupdf.PDFDocument,
  objectNumbers: readonly number[],
  minBytes = COMPACT_MIN_BYTES,
): UncompressedStream[] {
  const out: UncompressedStream[] = [];
  for (const num of new Set(objectNumbers)) {
    const obj = doc.newIndirect(num);
    try {
      if (!obj.isStream()) continue;
      if (!obj.get('Filter').isNull() || !obj.get('DecodeParms').isNull()) continue;
      const subtype = obj.get('Subtype');
      if (subtype.isName() && subtype.asName() === 'Image') continue;
      const type = obj.get('Type');
      if (type.isName() && type.asName() === 'Metadata') continue;
      const length = obj.get('Length');
      if (!length.isNumber() || length.asNumber() < minBytes) continue;
      out.push({ objectNumber: num, bytes: readStreamBytes(obj) });
    } finally {
      obj.destroy();
    }
  }
  return out;
}

/** The part of the platform `CompressionStream` that is used (this package builds without DOM or Node types). */
type CompressionStreamCtor = new (format: 'deflate') => {
  readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
  writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
};

/** zlib (RFC 1950) format deflate. null if the platform has no `CompressionStream`. */
export async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { CompressionStream?: CompressionStreamCtor }).CompressionStream;
  if (!Ctor) return null;
  const cs = new Ctor('deflate');
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Run writing and reading together (without reading, the write of a large input hits backpressure and never finishes).
  const reading = (async () => {
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  })();
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  await reading;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Puts the compressed bytes into the stream (/Filter /FlateDecode, no /DecodeParms). Returns true if, after unpacking again, they equal `plain`. If different or
 * on an exception, reverts `plain` to the unpacked state and returns false (throws if the revert also fails). Called inside an open journal operation.
 */
export function writeCompressedStream(
  doc: mupdf.PDFDocument,
  objectNumber: number,
  compressed: Uint8Array,
  plain: Uint8Array,
): boolean {
  const obj = doc.newIndirect(objectNumber);
  try {
    try {
      obj.put('Filter', doc.newName('FlateDecode'));
      obj.delete('DecodeParms');
      const buffer = new mupdf.Buffer(compressed);
      try {
        obj.writeRawStream(buffer);
      } finally {
        buffer.destroy();
      }
      if (sameBytes(readStreamBytes(obj), plain)) return true;
    } catch {
      // Reverted to the unpacked bytes below.
    }
    writeStreamBytes(obj, plain);
    return false;
  } finally {
    obj.destroy();
  }
}

export interface CompactResult {
  /** Number of streams compressed and inserted. */
  compacted: number;
  /** Sum of bytes before and after compression (compressed streams only). */
  plainBytes: number;
  storedBytes: number;
}

/**
 * Compresses and inserts the streams chosen by `uncompressedStreams`. If `stillValid()` is false after the (async) compression (the document was closed or
 * the draft changed in between), nothing is written. Streams that cannot be compressed or fail are left as is. An exception occurs only when the revert after insertion
 * also fails (the state of that stream is unknown, so the caller must discard the operation).
 */
export async function compactStreams(
  doc: mupdf.PDFDocument,
  streams: readonly UncompressedStream[],
  stillValid: () => boolean = () => true,
): Promise<CompactResult> {
  const result: CompactResult = { compacted: 0, plainBytes: 0, storedBytes: 0 };
  if (streams.length === 0) return result;
  const packed: (Uint8Array | null)[] = [];
  for (const s of streams) packed.push(await deflateZlib(s.bytes).catch(() => null));
  if (!stillValid()) return result;
  streams.forEach((s, i) => {
    const z = packed[i];
    // If compression does not shrink it (e.g. a stream holding already compressed data), leave it as is.
    if (!z || z.byteLength >= s.bytes.byteLength) return;
    if (writeCompressedStream(doc, s.objectNumber, z, s.bytes)) {
      result.compacted++;
      result.plainBytes += s.bytes.byteLength;
      result.storedBytes += z.byteLength;
    }
  });
  return result;
}
