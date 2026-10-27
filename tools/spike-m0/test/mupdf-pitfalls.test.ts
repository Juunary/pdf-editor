import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';

/**
 *  * Control for known MuPDF 1.28.1 defects (docs/m0-dod-xobject-redact-save.md 2.5).
 *  * If this test fails, MuPDF behavior has changed → reassess the workaround rule.
 */
function imageDoc(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 16, 16], false);
  pix.clear(128);
  const img = doc.addImage(new mupdf.Image(pix.asJPEG(80, false)));
  doc.insertPage(
    -1,
    doc.addPage([0, 0, 50, 50], 0, { XObject: { Im: img } }, 'q 40 0 0 40 5 5 cm /Im Do Q'),
  );
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

function saveAfterResolve(options: string, resolve: boolean): boolean {
  const doc = mupdf.Document.openDocument(imageDoc(), 'application/pdf') as mupdf.PDFDocument;
  const im = doc.findPage(0).get('Resources').get('XObject').get('Im');
  if (resolve) im.resolve().destroy();
  else im.get('Width');
  const re = mupdf.Document.openDocument(
    doc.saveToBuffer(options).asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
  return re.findPage(0).get('Resources').get('XObject').get('Im').isStream();
}

describe('MuPDF 1.28.1: garbage=compact save after resolve() of a compressed image XObject', () => {
  it('after resolve(), the image stream is dropped in a compact save (same even if the handle is released)', () => {
    mupdf.setLog({ error: () => {}, warning: () => {} });
    try {
      expect(saveAfterResolve('garbage=compact,compress', true)).toBe(false);
      expect(saveAfterResolve('garbage=deduplicate,compress', true)).toBe(false);
      // objstms is unrelated to the defect path: used with compact the stream is dropped (below), used with garbage=yes it is kept
      expect(saveAfterResolve('garbage=compact,compress,objstms', true)).toBe(false);
    } finally {
      mupdf.setLog(null);
    }
  });

  it('the image is kept if only indirect-reference get() is used or with garbage=yes', () => {
    expect(saveAfterResolve('garbage=compact,compress', false)).toBe(true);
    expect(saveAfterResolve('garbage=yes,compress', true)).toBe(true);
    expect(saveAfterResolve('garbage=yes,compress,objstms', true)).toBe(true);
  });
});

/**
 *  * MuPDF 1.28.1: document state change from objstms saves (docs/m0-dod-xobject-redact-save.md 3.3 A3-7 verification).
 *  * Each save allocates 2 numbers in the document for the object stream and xref stream and keeps them after saving.
 */
describe('MuPDF 1.28.1: state of the same document after an objstms save', () => {
  const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
  const save = (doc: mupdf.PDFDocument, options: string) =>
    doc.saveToBuffer(options).asUint8Array().slice();

  it('each save increases countObjects by 2, and they remain as empty entries in the xref of a later garbage=yes save', () => {
    const doc = mupdf.Document.openDocument(imageDoc(), 'application/pdf') as mupdf.PDFDocument;
    const n = doc.countObjects();
    const fresh = save(doc, 'garbage=yes,compress');
    const b1 = save(doc, 'garbage=yes,compress,objstms');
    expect(doc.countObjects()).toBe(n + 2);
    const b2 = save(doc, 'garbage=yes,compress,objstms');
    expect(doc.countObjects()).toBe(n + 4);
    expect(b2.length).not.toBe(b1.length);
    const after = save(doc, 'garbage=yes,compress');
    expect(latin1(fresh)).toContain(`/Size ${n}`);
    expect(latin1(after)).toContain(`/Size ${n + 4}`);
    doc.destroy();
  });

  it('after that, an incremental save of the same document appends an xref stream section even to an xref-table original', () => {
    const src = imageDoc();
    const doc = mupdf.Document.openDocument(src, 'application/pdf') as mupdf.PDFDocument;
    expect(latin1(src)).toMatch(/\nxref\n/);
    doc.saveToBuffer('garbage=yes,compress,objstms').destroy();
    const page = doc.loadPage(0) as mupdf.PDFPage;
    page.createAnnotation('Text').setRect([5, 5, 15, 15]);
    const out = save(doc, 'incremental');
    doc.destroy();
    const tail = latin1(out.subarray(src.length));
    expect(tail).toMatch(/\/Type\s*\/XRef/);
    expect(tail).not.toMatch(/\nxref\n/);
    const re = mupdf.Document.openDocument(out, 'application/pdf') as mupdf.PDFDocument;
    expect(re.loadPage(0).getAnnotations()).toHaveLength(1);
    re.destroy();
  });
});
