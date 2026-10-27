import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import * as mupdf from 'mupdf';
import {
  COMPACT_MIN_BYTES,
  compactStreams,
  deflateZlib,
  uncompressedStreams,
  writeCompressedStream,
} from '../src/stream-compact.js';
import { readStreamBytes, writeStreamBytes } from '../src/mupdf-util.js';

/** Deterministic bytes that look like a content stream (small set of coordinates, well-compressible text). */
function contentLike(bytes: number, seed = 7): Uint8Array {
  let x = seed;
  const next = () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) {
    const l = `${(next() % 600) / 2} ${(next() % 800) / 2} m ${(next() % 600) / 2} ${(next() % 800) / 2} l S\n`;
    lines.push(l);
    size += l.length;
  }
  return new TextEncoder().encode(lines.join('').slice(0, bytes));
}

function docWithPage(content: Uint8Array): { doc: mupdf.PDFDocument; contents: number } {
  const doc = new mupdf.PDFDocument();
  doc.insertPage(-1, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const page = doc.findPage(0);
  const stream = doc.addStream(content, {});
  page.put('Contents', stream);
  return { doc, contents: stream.asIndirect() };
}

describe('stream-compact', () => {
  it('deflateZlib: compresses in zlib format (same as FlateDecode)', async () => {
    const plain = contentLike(200_000);
    const z = await deflateZlib(plain);
    expect(z).not.toBeNull();
    expect(z!.byteLength).toBeLessThan(plain.byteLength / 2);
    expect(new Uint8Array(inflateSync(z!))).toEqual(plain);
  });

  it('uncompressedStreams: selects only content/Forms with no filter and at or above the limit', () => {
    const { doc, contents } = docWithPage(contentLike(COMPACT_MIN_BYTES + 10));
    const small = doc.addStream('0 0 m 1 1 l S', {}).asIndirect();
    const filtered = doc.addRawStream(contentLike(COMPACT_MIN_BYTES * 2), {});
    filtered.put('Filter', doc.newName('FlateDecode'));
    const image = doc.addStream(contentLike(COMPACT_MIN_BYTES + 10), {});
    image.put('Subtype', doc.newName('Image'));
    const meta = doc.addStream(contentLike(COMPACT_MIN_BYTES + 10), {});
    meta.put('Type', doc.newName('Metadata'));
    const form = doc.addStream(contentLike(COMPACT_MIN_BYTES + 10), {});
    form.put('Subtype', doc.newName('Form'));
    const picked = uncompressedStreams(doc, [
      contents,
      small,
      filtered.asIndirect(),
      image.asIndirect(),
      meta.asIndirect(),
      form.asIndirect(),
      contents,
    ]);
    expect(picked.map((s) => s.objectNumber)).toEqual([contents, form.asIndirect()]);
    expect(picked[0]!.bytes.byteLength).toBe(COMPACT_MIN_BYTES + 10);
  });

  it('writeCompressedStream: stores with FlateDecode and the decoded bytes are the same', async () => {
    const plain = contentLike(300_000);
    const { doc, contents } = docWithPage(plain);
    const z = (await deflateZlib(plain))!;
    expect(writeCompressedStream(doc, contents, z, plain)).toBe(true);
    const obj = doc.newIndirect(contents);
    expect(obj.get('Filter').asName()).toBe('FlateDecode');
    expect(obj.get('Length').asNumber()).toBe(z.byteLength);
    expect(readStreamBytes(obj)).toEqual(plain);
    // The render also reads the same content (not an empty drawing).
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray);
    expect(pix.getPixels().some((v) => v < 255)).toBe(true);
  });

  it('writeCompressedStream: if the compressed bytes are wrong, reverts to the decoded bytes and returns false', async () => {
    const plain = contentLike(100_000);
    const { doc, contents } = docWithPage(plain);
    const z = (await deflateZlib(plain))!;
    const broken = z.slice(0, z.byteLength - 10);
    expect(writeCompressedStream(doc, contents, broken, plain)).toBe(false);
    const obj = doc.newIndirect(contents);
    expect(obj.get('Filter').isNull()).toBe(true);
    expect(readStreamBytes(obj)).toEqual(plain);
  });

  it('compactStreams: adds no steps inside a journal operation, and undo returns to the content from before the operation', async () => {
    const before = contentLike(150_000, 1);
    const after = contentLike(150_000, 2);
    const { doc, contents } = docWithPage(before);
    doc.enableJournal();
    doc.beginOperation('edit');
    writeStreamBytes(doc.newIndirect(contents), after);
    const streams = uncompressedStreams(doc, [contents]);
    const r = await compactStreams(doc, streams);
    doc.endOperation();
    expect(r.compacted).toBe(1);
    expect(r.storedBytes).toBeLessThan(r.plainBytes);
    expect(doc.getJournal().steps).toHaveLength(1);
    expect(readStreamBytes(doc.newIndirect(contents))).toEqual(after);
    doc.undo();
    expect(readStreamBytes(doc.newIndirect(contents))).toEqual(before);
    doc.redo();
    expect(readStreamBytes(doc.newIndirect(contents))).toEqual(after);
    expect(doc.newIndirect(contents).get('Filter').asName()).toBe('FlateDecode');
  });

  it('compactStreams: does not write if it becomes invalid while compressing', async () => {
    const plain = contentLike(100_000);
    const { doc, contents } = docWithPage(plain);
    const r = await compactStreams(doc, uncompressedStreams(doc, [contents]), () => false);
    expect(r.compacted).toBe(0);
    expect(doc.newIndirect(contents).get('Filter').isNull()).toBe(true);
  });
});
