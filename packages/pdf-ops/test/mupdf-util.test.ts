import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { pageTransform, readStreamBytes, releaseBorrowedShade } from '../src/mupdf-util.js';
import { recordDevice } from './helpers/device-log.js';
import { buildTestPageModel } from './helpers/page-model.js';

/** M1 리뷰 반영: WASM 래퍼(쪽·버퍼)를 쓰고 바로 해제하는 도구와, 빌린 Shade 래퍼의 종료자 해제. */
function shadedDoc(): mupdf.PDFDocument {
  const src = new mupdf.PDFDocument();
  const shading = src.addObject({
    ShadingType: 2,
    ColorSpace: 'DeviceRGB',
    Coords: [0, 0, 100, 0],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
  });
  src.insertPage(
    -1,
    src.addPage([0, 0, 200, 100], 90, { Shading: { Sh: shading } }, 'q 0 0 100 50 re W n /Sh sh Q'),
  );
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

afterEach(() => vi.restoreAllMocks());

describe('mupdf-util', () => {
  it('readStreamBytes: 디코드 바이트의 JS 복사본(WASM 메모리 뷰가 아님)', () => {
    const doc = shadedDoc();
    const contents = doc.findPage(0).get('Contents');
    const bytes = readStreamBytes(contents);
    expect(new TextDecoder().decode(bytes)).toContain('/Sh sh');
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
  });

  it('pageTransform: PDFPage.getTransform() 과 같다(/Rotate 90)', () => {
    const doc = shadedDoc();
    const page = doc.loadPage(0);
    const expected = page.getTransform();
    page.destroy();
    expect(pageTransform(doc, 0)).toEqual(expected);
  });

  it('releaseBorrowedShade: 테스트 헬퍼의 fillShade 가 빌린 Shade 래퍼의 종료자를 해제한다', () => {
    const doc = shadedDoc();
    const page = doc.loadPage(0);
    // 첫 실행에서 Shade 종료자 레지스트리가 생긴다.
    expect(recordDevice(page).some((e) => e.kind === 'fillShade')).toBe(true);
    const registry = (mupdf.Shade as unknown as { _finalizer?: FinalizationRegistry<unknown> })
      ._finalizer!;
    const spy = vi.spyOn(registry, 'unregister');
    recordDevice(page);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeInstanceOf(mupdf.Shade);
    spy.mockClear();
    buildTestPageModel(doc, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    page.destroy();
  });

  it('releaseBorrowedShade: 레지스트리가 없는 래퍼도 예외 없이 지나간다', () => {
    const fake = { constructor: {} } as unknown as mupdf.Shade;
    expect(() => releaseBorrowedShade(fake)).not.toThrow();
  });
});
