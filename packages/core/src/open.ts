import * as mupdf from 'mupdf';
import type { InputMode } from '@pdf-editor/shared-types';

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
 * 바이트를 WASM 버퍼로 복사해 연다. mupdf.js 에 Uint8Array 를 그대로 넘기면 임시 Buffer 래퍼의 해제가 GC 에 맡겨져
 * 문서를 닫아도 바이트 사본이 남는다. 문서가 버퍼 참조를 잡은 뒤 래퍼를 바로 놓는다.
 */
function openFromBuffer(bytes: Uint8Array | ArrayBuffer): mupdf.Document {
  const buffer = new mupdf.Buffer(bytes);
  try {
    return mupdf.Document.openDocument(buffer, 'application/pdf');
  } finally {
    buffer.destroy();
  }
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
