/**
 * Helpers that use a MuPDF WASM wrapper and release it immediately. A synchronous loop never runs FinalizationRegistry cleanup,
 * so leaving page/buffer wrappers to the GC piles up the WASM heap on large documents.
 */
import * as mupdf from 'mupdf';
import type { Matrix } from '@pdf-editor/shared-types';

/**
 * Replaces stream contents. Given a Uint8Array or string, mupdf.js creates a temporary Buffer wrapper and leaves its release to the GC; for repeated writes of large content
 * streams (several MB), such as path dragging and edit refresh, copies pile up and GC pauses occur. Build the buffer directly and drop it right away.
 */
export function writeStreamBytes(obj: mupdf.PDFObject, bytes: Uint8Array | string): void {
  const buffer = typeof bytes === 'string' ? new mupdf.Buffer(bytes) : new mupdf.Buffer(bytes);
  try {
    obj.writeStream(buffer);
  } finally {
    buffer.destroy();
  }
}

/** Decoded bytes of a stream (JS copy). The MuPDF Buffer wrapper is released right after copying. */
export function readStreamBytes(stream: mupdf.PDFObject): Uint8Array {
  const buffer = stream.readStream();
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/** User space → page space matrix (`PDFPage.getTransform()`). The page wrapper is released right after reading. */
export function pageTransform(doc: mupdf.PDFDocument, pageIndex: number): Matrix {
  const page = doc.loadPage(pageIndex);
  try {
    return page.getTransform() as Matrix;
  } finally {
    page.destroy();
  }
}

/**
 * mupdf.js 1.28.1 creates the Shade wrapper in the Device `fillShade` callback without incrementing the reference (Path, Text, ColorSpace,
 * StrokeState and Image do increment it). When that wrapper is GC'd it drops a reference it does not own, freeing the shade, and later runs on the same document
 * fail as if the heap were corrupted. Unregister the finalizer so the borrowed reference is not dropped. destroy() is not called.
 */
export function releaseBorrowedShade(shade: mupdf.Shade): void {
  const ctor = shade.constructor as unknown as { _finalizer?: FinalizationRegistry<unknown> };
  ctor._finalizer?.unregister(shade);
}
