import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import core before mupdf (see src/save-bench.ts).
import '@pdf-editor/core';
import * as mupdf from 'mupdf';
import { applyBenchEdit } from '../src/bench.js';
import { buildSamplePdf } from '../src/fixture.js';
import { openFromStream } from '../src/save-bench.js';

const TTF = fileURLToPath(
  new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url),
);

function editAndSave(doc: mupdf.PDFDocument): Uint8Array {
  applyBenchEdit(doc, new Uint8Array(readFileSync(TTF)));
  doc.subsetFonts();
  const buf = doc.saveToBuffer('garbage=compact,compress');
  const out = buf.asUint8Array().slice();
  buf.destroy();
  doc.destroy();
  return out;
}

describe('Stream input (new Stream(handle))', () => {
  it('edit and full-save results are byte-identical to Buffer input', () => {
    const bytes = buildSamplePdf();
    const viaBuffer = editAndSave(
      mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument,
    );
    const viaStream = editAndSave(openFromStream(bytes));
    expect(Buffer.from(viaStream).equals(Buffer.from(viaBuffer))).toBe(true);
  });

  it('MuPDF reads only the ranges it needs: opening a document with an 8 MiB unreferenced stream and rendering page 1 reads only a portion', () => {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, '0 0 1 rg 10 10 50 50 re f'));
    doc.addRawStream(new Uint8Array(8 * 2 ** 20), {});
    const bytes = doc.saveToBuffer('').asUint8Array().slice();
    doc.destroy();
    let read = 0;
    const stream = new mupdf.Stream({
      fileSize: () => bytes.byteLength,
      read: (memory, offset, length, position) => {
        const n = Math.max(0, Math.min(length, bytes.byteLength - position));
        memory.set(bytes.subarray(position, position + n), offset);
        read += n;
        return n;
      },
      close: () => {},
    });
    const d = mupdf.Document.openDocument(stream, 'application/pdf');
    d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).destroy();
    expect(d.countPages()).toBe(1);
    expect(read).toBeLessThan(bytes.byteLength / 4);
    d.destroy();
  });
});
