/**
 * MuPDF WASM 래퍼를 쓰고 바로 해제하는 도구. 동기 루프에서는 FinalizationRegistry 정리가 돌지 않으므로
 * 쪽·버퍼 래퍼를 GC 에 맡기면 큰 문서에서 WASM 힙이 쌓인다.
 */
import * as mupdf from 'mupdf';
import type { Matrix } from '@pdf-editor/shared-types';

/**
 * 스트림 내용을 바꾼다. mupdf.js 는 Uint8Array·문자열을 받으면 임시 Buffer 래퍼를 만들고 해제를 GC 에 맡겨, 큰 콘텐츠
 * 스트림(수 MB)을 반복해 쓰는 패스 끌기·편집 갱신에서 사본이 쌓이고 GC 멈춤이 생긴다. 버퍼를 직접 만들어 바로 놓는다.
 */
export function writeStreamBytes(obj: mupdf.PDFObject, bytes: Uint8Array | string): void {
  const buffer = typeof bytes === 'string' ? new mupdf.Buffer(bytes) : new mupdf.Buffer(bytes);
  try {
    obj.writeStream(buffer);
  } finally {
    buffer.destroy();
  }
}

/** 스트림을 디코드한 바이트(JS 복사본). MuPDF Buffer 래퍼는 복사 직후 해제한다. */
export function readStreamBytes(stream: mupdf.PDFObject): Uint8Array {
  const buffer = stream.readStream();
  try {
    return buffer.asUint8Array().slice();
  } finally {
    buffer.destroy();
  }
}

/** 사용자 공간 → 페이지 공간 행렬(`PDFPage.getTransform()`). 쪽 래퍼는 읽은 직후 해제한다. */
export function pageTransform(doc: mupdf.PDFDocument, pageIndex: number): Matrix {
  const page = doc.loadPage(pageIndex);
  try {
    return page.getTransform() as Matrix;
  } finally {
    page.destroy();
  }
}

/**
 * mupdf.js 1.28.1 은 Device `fillShade` 콜백의 Shade 래퍼를 참조를 늘리지 않고 만든다(Path·Text·ColorSpace·
 * StrokeState·Image 는 늘린다). 그 래퍼가 GC 되면 소유하지 않은 참조를 놓아 셰이드가 해제되고, 이후 같은 문서를
 * 실행할 때 힙이 손상된 것처럼 실패한다. 종료자 등록을 해제해 빌린 참조를 놓지 않게 한다. destroy() 는 부르지 않는다.
 */
export function releaseBorrowedShade(shade: mupdf.Shade): void {
  const ctor = shade.constructor as unknown as { _finalizer?: FinalizationRegistry<unknown> };
  ctor._finalizer?.unregister(shade);
}
