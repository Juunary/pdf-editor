import { afterEach, describe, expect, it, vi } from 'vitest';
import * as mupdf from 'mupdf';
import { pageTransform, readStreamBytes, releaseBorrowedShade } from '../src/mupdf-util.js';
import { recordDevice } from './helpers/device-log.js';
import { buildTestPageModel } from './helpers/page-model.js';

/** M1 review fixes: tools that use a WASM wrapper (page, buffer) and release it immediately, and finalizer release of borrowed Shade wrappers. */
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
  it('readStreamBytes: a JS copy of the decoded bytes (not a WASM memory view)', () => {
    const doc = shadedDoc();
    const contents = doc.findPage(0).get('Contents');
    const bytes = readStreamBytes(contents);
    expect(new TextDecoder().decode(bytes)).toContain('/Sh sh');
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
  });

  it('pageTransform: same as PDFPage.getTransform() (/Rotate 90)', () => {
    const doc = shadedDoc();
    const page = doc.loadPage(0);
    const expected = page.getTransform();
    page.destroy();
    expect(pageTransform(doc, 0)).toEqual(expected);
  });

  it('releaseBorrowedShade: fillShade of the test helper releases the finalizer of the borrowed Shade wrapper', () => {
    const doc = shadedDoc();
    const page = doc.loadPage(0);
    // The first run creates the Shade finalizer registry.
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

  it('releaseBorrowedShade: a wrapper without a registry also passes without an exception', () => {
    const fake = { constructor: {} } as unknown as mupdf.Shade;
    expect(() => releaseBorrowedShade(fake)).not.toThrow();
  });
});
