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
      // objstms 는 결함 경로와 무관하다: compact 와 함께 쓰면 빠지고(아래), garbage=yes 와 함께면 남는다
      expect(saveAfterResolve('garbage=compact,compress,objstms', true)).toBe(false);
    } finally {
      mupdf.setLog(null);
    }
  });

  it('간접 참조 get() 만 쓰거나 garbage=yes 면 이미지가 남는다', () => {
    expect(saveAfterResolve('garbage=compact,compress', false)).toBe(true);
    expect(saveAfterResolve('garbage=yes,compress', true)).toBe(true);
    expect(saveAfterResolve('garbage=yes,compress,objstms', true)).toBe(true);
  });
});

/**
 * MuPDF 1.28.1: objstms 저장의 문서 상태 변화(docs/m0-dod-xobject-redact-save.md 3.3 A3-7 검증).
 * 저장마다 객체 스트림·xref 스트림용 번호 2개를 문서에 할당하고 저장 뒤에도 남긴다.
 */
describe('MuPDF 1.28.1: objstms 저장 뒤 같은 문서의 상태', () => {
  const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
  const save = (doc: mupdf.PDFDocument, options: string) =>
    doc.saveToBuffer(options).asUint8Array().slice();

  it('저장마다 countObjects 가 2 늘고, 이후 garbage=yes 저장의 xref 에 빈 항목으로 남는다', () => {
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

  it('그 뒤 같은 문서의 증분 저장은 xref 표 원본에도 xref 스트림 구간을 덧붙인다', () => {
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
