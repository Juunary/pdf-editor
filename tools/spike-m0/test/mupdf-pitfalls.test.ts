import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';

/**
 * MuPDF 1.28.1 알려진 결함 대조(docs/m0-dod-xobject-redact-save.md 2.5).
 * 이 테스트가 실패하면 MuPDF 동작이 바뀐 것이다 → 회피 규칙 재평가.
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

describe('MuPDF 1.28.1: 압축 이미지 XObject resolve() 후 garbage=compact 저장', () => {
  it('resolve() 하면 compact 저장에서 이미지 스트림이 빠진다(핸들을 해제해도 같음)', () => {
    mupdf.setLog({ error: () => {}, warning: () => {} });
    try {
      expect(saveAfterResolve('garbage=compact,compress', true)).toBe(false);
      expect(saveAfterResolve('garbage=deduplicate,compress', true)).toBe(false);
    } finally {
      mupdf.setLog(null);
    }
  });

  it('간접 참조 get() 만 쓰거나 garbage=yes 면 이미지가 남는다', () => {
    expect(saveAfterResolve('garbage=compact,compress', false)).toBe(true);
    expect(saveAfterResolve('garbage=yes,compress', true)).toBe(true);
  });
});
