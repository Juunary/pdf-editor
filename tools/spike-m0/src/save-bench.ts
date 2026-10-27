// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import { decideSaveMethod } from '@pdf-editor/pdf-ops';
import type { ChangeKind } from '@pdf-editor/shared-types';
import { closeSync, openSync, writeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { applyBenchEdit } from './bench.js';

/**
 * Large-document save limit investigation (docs/m0-day1-log.md A4). Each variant runs in its own Node process
 * (WASM linear memory never shrinks, so the value at process exit is that task's maximum).
 */

export interface SaveVariant {
  /** buffer: copy input bytes into the WASM heap (`openDocument(Uint8Array)`). stream: MuPDF reads JS-side bytes through a callback (`new Stream(handle)`) */
  input: 'buffer' | 'stream';
  /** full: full save after replacing a paragraph on page 1. incremental: incremental save after adding one annotation */
  edit: 'full' | 'incremental';
  /** Full-save options (applies to full only). Default is the decideSaveMethod value */
  options?: string;
  /** Render the first N pages before saving (loads the decode cache) */
  renderPages?: number;
  /** `emptyStore()` right before saving */
  emptyStore?: boolean;
}

export const SAVE_VARIANTS: Record<string, SaveVariant> = {
  'buffer-compact': { input: 'buffer', edit: 'full' },
  'stream-compact': { input: 'stream', edit: 'full' },
  'buffer-gc1': { input: 'buffer', edit: 'full', options: 'garbage=yes,compress' },
  'stream-gc1': { input: 'stream', edit: 'full', options: 'garbage=yes,compress' },
  'buffer-render100': { input: 'buffer', edit: 'full', renderPages: 100 },
  'buffer-render100-empty': { input: 'buffer', edit: 'full', renderPages: 100, emptyStore: true },
  'buffer-incremental': { input: 'buffer', edit: 'incremental' },
  'stream-incremental': { input: 'stream', edit: 'incremental' },
};

export interface SaveBenchMark {
  phase: string;
  tMs: number;
  wasmHeapBytes: number | null;
}

export interface SaveBenchResult {
  variant: string;
  inputBytes: number;
  pages: number | null;
  options: string | null;
  ok: boolean;
  error: string | null;
  outputBytes: number | null;
  saveMs: number | null;
  marks: SaveBenchMark[];
  /** WASM linear memory at exit ÷ input size */
  peakRatio: number | null;
  /** Whether a new document can still be created and saved in the same process after a failure */
  recoveredAfterError: boolean | null;
}

/** Input stream that lets MuPDF read only the ranges it needs from JS-side bytes. The input is not copied into the WASM heap. */
export function openFromStream(bytes: Uint8Array): mupdf.PDFDocument {
  const stream = new mupdf.Stream({
    fileSize: () => bytes.byteLength,
    read: (memory, offset, length, position) => {
      const n = Math.max(0, Math.min(length, bytes.byteLength - position));
      memory.set(bytes.subarray(position, position + n), offset);
      return n;
    },
    close: () => {},
  });
  const doc = mupdf.Document.openDocument(stream, 'application/pdf').asPDF();
  if (!doc) throw new Error('PDF 문서가 아님');
  return doc;
}

export function runSaveVariant(
  name: string,
  bytes: Uint8Array,
  fontBytes: Uint8Array,
): SaveBenchResult {
  const v = SAVE_VARIANTS[name];
  if (!v) throw new Error(`알 수 없는 변형: ${name}`);
  const start = performance.now();
  const marks: SaveBenchMark[] = [];
  const mark = (phase: string) =>
    marks.push({ phase, tMs: performance.now() - start, wasmHeapBytes: wasmHeapBytes() });
  mark('start');
  const result: SaveBenchResult = {
    variant: name,
    inputBytes: bytes.byteLength,
    pages: null,
    options: null,
    ok: false,
    error: null,
    outputBytes: null,
    saveMs: null,
    marks,
    peakRatio: null,
    recoveredAfterError: null,
  };
  try {
    const doc =
      v.input === 'buffer'
        ? (mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument)
        : openFromStream(bytes);
    result.pages = doc.countPages();
    mark('open');
    for (let p = 0; p < Math.min(v.renderPages ?? 0, doc.countPages()); p++) {
      const page = doc.loadPage(p);
      page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).destroy();
      page.destroy();
    }
    if (v.renderPages) mark('render');
    let changes: ChangeKind[];
    if (v.edit === 'full') {
      applyBenchEdit(doc, fontBytes);
      changes = ['redaction', 'font-embed', 'content-stream'];
    } else {
      const page = doc.loadPage(0);
      const annot = page.createAnnotation('Text');
      annot.setRect([20, 20, 40, 40]);
      annot.setContents('M0 save bench');
      annot.update();
      page.destroy();
      changes = ['annotation'];
    }
    mark('edit');
    if (v.edit === 'full') doc.subsetFonts();
    if (v.emptyStore) mupdf.emptyStore();
    const decision = decideSaveMethod(changes, doc.canBeSavedIncrementally());
    result.options = v.edit === 'full' ? (v.options ?? decision.options) : decision.options;
    mark('pre-save');
    const t0 = performance.now();
    const buf = doc.saveToBuffer(result.options);
    result.saveMs = performance.now() - t0;
    result.outputBytes = buf.getLength();
    mark('save');
    buf.destroy();
    doc.destroy();
    result.ok = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    mark('error');
    try {
      const d = new mupdf.PDFDocument();
      d.insertPage(-1, d.addPage([0, 0, 100, 100], 0, {}, ''));
      result.recoveredAfterError = d.saveToBuffer('').getLength() > 0;
    } catch {
      result.recoveredAfterError = false;
    }
  }
  const last = marks.at(-1)!.wasmHeapBytes;
  result.peakRatio = last === null ? null : last / bytes.byteLength;
  return result;
}

/**
 * Writes a large PDF directly to a file without going through WASM (for the 2 GiB limit experiment; generation itself uses no heap).
 * Per page, an incompressible noise image (512×512 RGB, FlateDecode about 787 KB) + 1 text line.
 */
export function writeLargePdf(path: string, pages: number): number {
  const fd = openSync(path, 'w');
  let offset = 0;
  const offsets: number[] = [];
  const write = (chunk: string | Uint8Array) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    writeSync(fd, b);
    offset += b.byteLength;
  };
  const obj = (num: number, body: string | Uint8Array[]) => {
    offsets[num] = offset;
    write(`${num} 0 obj\n`);
    if (typeof body === 'string') write(body);
    else body.forEach(write);
    write('\nendobj\n');
  };
  const pageNum = (i: number) => 4 + i * 3;
  write('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
  obj(1, '<</Type/Catalog/Pages 2 0 R>>');
  obj(
    2,
    `<</Type/Pages/Count ${pages}/Kids[${Array.from({ length: pages }, (_, i) => `${pageNum(i)} 0 R`).join(' ')}]>>`,
  );
  obj(3, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>');
  let state = 0x12345678;
  const noise = new Uint8Array(512 * 512 * 3);
  for (let i = 0; i < pages; i++) {
    const p = pageNum(i);
    const content = `BT /F1 11 Tf 60 700 Td (Large document page ${i + 1}: replacement target line.) Tj ET\nq 200 0 0 200 56 300 cm /Im Do Q\n`;
    obj(
      p,
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 3 0 R>>/XObject<</Im ${p + 2} 0 R>>>>/Contents ${p + 1} 0 R>>`,
    );
    obj(p + 1, `<</Length ${content.length}>>\nstream\n${content}\nendstream`);
    for (let k = 0; k < noise.length; k++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      noise[k] = state & 0xff;
    }
    const flate = deflateSync(noise, { level: 1 });
    obj(p + 2, [
      Buffer.from(
        `<</Type/XObject/Subtype/Image/Width 512/Height 512/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode/Length ${flate.byteLength}>>\nstream\n`,
        'latin1',
      ),
      flate,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  }
  const total = 4 + pages * 3;
  const xref = offset;
  write(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) write(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  write(`trailer\n<</Size ${total}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`);
  closeSync(fd);
  return offset;
}
