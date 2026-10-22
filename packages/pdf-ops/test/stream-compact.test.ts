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

/** 콘텐츠 스트림처럼 보이는 결정적 바이트(작은 좌표 집합, 압축이 잘 되는 텍스트). */
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
  it('deflateZlib: zlib 형식(FlateDecode 와 같음)으로 압축한다', async () => {
    const plain = contentLike(200_000);
    const z = await deflateZlib(plain);
    expect(z).not.toBeNull();
    expect(z!.byteLength).toBeLessThan(plain.byteLength / 2);
    expect(new Uint8Array(inflateSync(z!))).toEqual(plain);
  });

  it('uncompressedStreams: 필터 없고 상한 이상인 콘텐츠·Form 만 고른다', () => {
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

  it('writeCompressedStream: FlateDecode 로 넣고 풀린 바이트가 같다', async () => {
    const plain = contentLike(300_000);
    const { doc, contents } = docWithPage(plain);
    const z = (await deflateZlib(plain))!;
    expect(writeCompressedStream(doc, contents, z, plain)).toBe(true);
    const obj = doc.newIndirect(contents);
    expect(obj.get('Filter').asName()).toBe('FlateDecode');
    expect(obj.get('Length').asNumber()).toBe(z.byteLength);
    expect(readStreamBytes(obj)).toEqual(plain);
    // 렌더도 같은 콘텐츠를 읽는다(빈 그림이 아님).
    const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray);
    expect(pix.getPixels().some((v) => v < 255)).toBe(true);
  });

  it('writeCompressedStream: 압축 바이트가 틀리면 풀린 바이트로 되돌리고 false', async () => {
    const plain = contentLike(100_000);
    const { doc, contents } = docWithPage(plain);
    const z = (await deflateZlib(plain))!;
    const broken = z.slice(0, z.byteLength - 10);
    expect(writeCompressedStream(doc, contents, broken, plain)).toBe(false);
    const obj = doc.newIndirect(contents);
    expect(obj.get('Filter').isNull()).toBe(true);
    expect(readStreamBytes(obj)).toEqual(plain);
  });

  it('compactStreams: 저널 작업 안에서 단계를 늘리지 않고, 되돌리기는 작업 전 내용으로', async () => {
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

  it('compactStreams: 압축하는 동안 무효가 되면 쓰지 않는다', async () => {
    const plain = contentLike(100_000);
    const { doc, contents } = docWithPage(plain);
    const r = await compactStreams(doc, uncompressedStreams(doc, [contents]), () => false);
    expect(r.compacted).toBe(0);
    expect(doc.newIndirect(contents).get('Filter').isNull()).toBe(true);
  });
});
