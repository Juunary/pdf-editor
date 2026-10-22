/**
 * 편집이 풀린 채 다시 쓴 큰 스트림을 Flate 로 압축해 다시 넣는다(M5 Windows 확인 W2, docs/m5-followup.md 5.1).
 *
 * 쪽 콘텐츠·Form 사본은 `writeStreamBytes`(MuPDF `writeStream`)로 쓰여 필터 없이 풀린 바이트를 그대로 보관한다. MuPDF 저널은
 * 작업마다 바뀐 객체의 작업 전 내용을 스트림 버퍼째 보관하므로, 풀린 크기가 큰 쪽(코퍼스 kogl-mods-cpi-202609 9쪽 8.9 MB)의
 * 문단을 처음 고칠 때마다 그만큼 저널에 남는다. 커밋 직전(같은 작업 안)에 압축해 두면 다음 편집이 저널로 넘기는 버퍼가 압축
 * 크기(같은 쪽 1.35 MB)가 된다. 원본 파일의 콘텐츠도 Flate 라서 압축 뒤 렌더·추출이 읽는 바이트는 편집 전과 같은 방식이다.
 *
 * 압축은 플랫폼 `CompressionStream('deflate')`(zlib 형식, Chrome Worker·Node 18+)를 쓴다. 없거나 실패하면 그대로 둔다(메모리만
 * 덜 줄고 동작은 같다). 넣은 뒤 MuPDF 로 다시 풀어 원래 바이트와 같은지 확인하고, 다르면 풀린 바이트로 되돌린다.
 */
import * as mupdf from 'mupdf';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';

/** 이보다 작은 스트림은 압축하지 않는다(편집 블록 등, 저널 보관량이 작고 커밋마다 비동기 단계만 늘어난다). */
export const COMPACT_MIN_BYTES = 64 * 1024;

export interface UncompressedStream {
  objectNumber: number;
  /** 지금 스트림의 풀린 바이트(필터가 없으므로 보관 바이트와 같다). */
  bytes: Uint8Array;
}

/**
 * 객체 번호들 중 압축할 스트림: 필터·DecodeParms 가 없고 길이가 `minBytes` 이상이며 이미지·메타데이터가 아닌 스트림
 * (쪽 콘텐츠·Form). 동기로 바이트를 읽어 둔다.
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

/** 플랫폼 `CompressionStream` 중 쓰는 부분(이 패키지는 DOM·Node 타입 없이 빌드한다). */
type CompressionStreamCtor = new (format: 'deflate') => {
  readable: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } };
  writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
};

/** zlib(RFC 1950) 형식 deflate. 플랫폼에 `CompressionStream` 이 없으면 null. */
export async function deflateZlib(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Ctor = (globalThis as { CompressionStream?: CompressionStreamCtor }).CompressionStream;
  if (!Ctor) return null;
  const cs = new Ctor('deflate');
  const chunks: Uint8Array[] = [];
  let total = 0;
  // 쓰기와 읽기를 함께 돌린다(읽지 않으면 큰 입력의 쓰기가 역압에 걸려 끝나지 않는다).
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
 * 압축한 바이트를 스트림에 넣는다(/Filter /FlateDecode, /DecodeParms 없음). 넣은 뒤 다시 풀어 `plain` 과 같으면 true. 다르거나
 * 예외면 `plain` 을 풀린 채로 되돌리고 false(되돌리기도 실패하면 예외). 열린 저널 작업 안에서 부른다.
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
      // 아래에서 풀린 바이트로 되돌린다.
    }
    writeStreamBytes(obj, plain);
    return false;
  } finally {
    obj.destroy();
  }
}

export interface CompactResult {
  /** 압축해 넣은 스트림 수. */
  compacted: number;
  /** 압축 전·후 바이트 합(압축한 스트림만). */
  plainBytes: number;
  storedBytes: number;
}

/**
 * `uncompressedStreams` 로 고른 스트림을 압축해 넣는다. 압축(비동기) 뒤 `stillValid()` 가 false 면(그 사이 문서가 닫히거나
 * 초안이 바뀜) 아무것도 쓰지 않는다. 압축을 쓸 수 없거나 실패한 스트림은 그대로 둔다. 예외는 넣은 뒤 되돌리기까지 실패한
 * 경우뿐이다(그 스트림 상태를 알 수 없으므로 호출자가 작업을 버려야 한다).
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
    // 압축이 줄이지 못하면(이미 압축된 데이터를 담은 스트림 등) 그대로 둔다.
    if (!z || z.byteLength >= s.bytes.byteLength) return;
    if (writeCompressedStream(doc, s.objectNumber, z, s.bytes)) {
      result.compacted++;
      result.plainBytes += s.bytes.byteLength;
      result.storedBytes += z.byteLength;
    }
  });
  return result;
}
