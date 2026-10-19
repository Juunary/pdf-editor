/**
 * V1 전반(docs/m3-contract.md 6.1, docs/m3-core.md 2절): MuPDF 저널이 편집 블록 Form 추가·스트림 교체·리소스 추가·
 * 폰트 추가를 undo/redo 로 되돌리는지, 폴백을 넣은 초안 취소·undo 뒤 새 편집, D9 저장 순서 뒤 undo/redo.
 * MuPDF 만 쓴다(pdf-ops·reflow 무관). 2026-10-19 서버 Node 22, mupdf 1.28.1 에서 확인한 동작을 고정한다.
 */
import '../src/wasm-module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { openPdf } from '../src/open.js';
import { ensureInfoDictionary, saltedFontBytes } from '../src/edit-util.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
const SAVE = 'garbage=yes,compress,objstms';
/** 폴백 폰트로 쓰는 "가" 한 글자(Identity-H 2바이트 gid, 잉크가 있는 글리프). */
const GA = `<${new mupdf.Font('NotoSansKR', FONT).encodeCharacter('가'.codePointAt(0)!).toString(16).padStart(4, '0')}>`;

/** 라틴 문장 하나가 있는 쪽. 세션과 같은 Stream 입력으로 다시 연다. */
function openPlain(): mupdf.PDFDocument {
  const doc = new mupdf.PDFDocument();
  const f1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  doc.insertPage(
    -1,
    doc.addPage(
      [0, 0, 300, 200],
      0,
      { Font: { F1: f1 } },
      'BT /F1 14 Tf 10 150 Td (Original) Tj ET',
    ),
  );
  const buffer = doc.saveToBuffer('');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return openPdf(bytes, { inputMode: 'stream' });
}

function ink(doc: mupdf.PDFDocument): number {
  const page = doc.loadPage(0);
  try {
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(1, 1),
      mupdf.ColorSpace.DeviceGray,
      false,
      true,
    );
    const px = pixmap.getPixels();
    let n = 0;
    for (let i = 0; i < px.length; i++) if (px[i]! < 128) n++;
    pixmap.destroy();
    return n;
  } finally {
    page.destroy();
  }
}

function pageText(doc: mupdf.PDFDocument): string {
  const page = doc.loadPage(0);
  try {
    return page.toStructuredText('preserve-whitespace').asText().trim();
  } finally {
    page.destroy();
  }
}

/** 편집 블록: Form 추가 + 쪽 Resources 등록 + 쪽 콘텐츠에 호출 추가. 작업 안에서 부른다. */
function addBlock(
  doc: mupdf.PDFDocument,
  body: string,
  fontRef?: mupdf.PDFObject,
): mupdf.PDFObject {
  const page = doc.loadPage(0);
  const pageObj = page.getObject();
  const form = doc.addStream(body, {
    Type: doc.newName('XObject'),
    Subtype: doc.newName('Form'),
    BBox: [0, 0, 300, 200],
  });
  const resources = pageObj.get('Resources');
  const formFonts = doc.newDictionary();
  formFonts.put('F1', resources.get('Font').get('F1'));
  if (fontRef) formFonts.put('FB', fontRef);
  const formResources = doc.newDictionary();
  formResources.put('Font', formFonts);
  form.put('Resources', formResources);
  if (resources.get('XObject').isNull()) resources.put('XObject', doc.newDictionary());
  resources.get('XObject').put('EB1', form);
  const contents = doc.newArray();
  contents.push(pageObj.get('Contents'));
  contents.push(doc.addStream('q /EB1 Do Q', {}));
  pageObj.put('Contents', contents);
  page.destroy();
  return form;
}

/** 폴백 폰트 추가. salt 를 바꾸면 폰트 바이트 다이제스트가 달라진다(edit-util `saltedFontBytes`). */
function embedRaw(doc: mupdf.PDFDocument, salt: number): mupdf.PDFObject {
  return doc.addFont(new mupdf.Font('NotoSansKR', saltedFontBytes(FONT, salt)));
}

function embedFallback(doc: mupdf.PDFDocument, salt: number): mupdf.PDFObject {
  const ref = embedRaw(doc, salt);
  ref.put('PdfEditorFallback', doc.newBoolean(true));
  return ref;
}

const fontLive = (ref: mupdf.PDFObject): boolean => ref.resolve().isDictionary();

describe('V1: 저널이 편집 블록 변경을 되돌린다', () => {
  it('블록 Form 추가·쪽 콘텐츠 교체·리소스 추가를 undo/redo 하고, 작업 밖 변경은 예외', () => {
    const doc = openPlain();
    doc.enableJournal();
    const base = ink(doc);
    expect(() => doc.addObject(doc.newDictionary())).toThrow(/absent an operation/);

    doc.beginOperation('edit');
    const form = addBlock(doc, 'BT /F1 20 Tf 10 100 Td (BLOCK) Tj ET');
    const num = form.asIndirect();
    expect(() => doc.canUndo()).toThrow(/during an operation/);
    expect(() => doc.getJournal()).toThrow(/during an operation/);
    const draftInk = ink(doc);
    expect(draftInk).toBeGreaterThan(base);
    doc.endOperation();
    expect(doc.getJournal()).toEqual({ position: 1, steps: ['edit'] });
    expect(pageText(doc)).toContain('BLOCK');

    doc.undo();
    expect(ink(doc)).toBe(base);
    expect(pageText(doc)).not.toContain('BLOCK');
    expect(doc.newIndirect(num).resolve().isNull()).toBe(true);
    const page = doc.loadPage(0);
    expect(page.getObject().get('Resources').get('XObject').isNull()).toBe(true);
    expect(page.getObject().get('Contents').isArray()).toBe(false);
    page.destroy();

    doc.redo();
    expect(ink(doc)).toBe(draftInk);
    expect(pageText(doc)).toContain('BLOCK');
    expect(doc.newIndirect(num).isStream()).toBe(true);
  });

  it('같은 블록 스트림을 한 작업 안에서 여러 번 고쳐도 한 단계이고 undo 는 작업 전 내용으로', () => {
    const doc = openPlain();
    doc.enableJournal();
    doc.beginOperation('edit');
    const form = addBlock(doc, 'BT /F1 20 Tf 10 100 Td (V0) Tj ET');
    doc.endOperation();
    doc.beginOperation('edit2');
    for (let i = 1; i <= 20; i++) form.writeStream(`BT /F1 20 Tf 10 100 Td (V${i}) Tj ET`);
    doc.endOperation();
    expect(doc.getJournal().steps).toEqual(['edit', 'edit2']);
    expect(pageText(doc)).toContain('V20');
    doc.undo();
    expect(pageText(doc)).toContain('V0');
    expect(pageText(doc)).not.toContain('V20');
    doc.undo();
    expect(pageText(doc)).not.toContain('V0');
    doc.redo();
    doc.redo();
    expect(pageText(doc)).toContain('V20');
  });

  it('렌더·구조화 텍스트·페이지 로드는 저널 단계를 만들지 않는다', () => {
    const doc = openPlain();
    doc.enableJournal();
    ink(doc);
    pageText(doc);
    doc.loadPage(0).destroy();
    expect(doc.getJournal()).toEqual({ position: 0, steps: [] });
  });
});

describe('V1: 폴백 폰트 수명', () => {
  it('저널이 되돌린 폰트를 같은 바이트로 다시 넣으면 끊긴 참조가 돌아온다(MuPDF 1.28.1 폰트 리소스 표)', () => {
    const doc = openPlain();
    doc.enableJournal();
    doc.beginOperation('draft');
    const first = embedFallback(doc, 0);
    expect(fontLive(first)).toBe(true);
    const num = first.asIndirect();
    doc.abandonOperation();
    expect(doc.newIndirect(num).resolve().isNull()).toBe(true);

    doc.beginOperation('again');
    const naive = embedRaw(doc, 0);
    // 폰트 바이트 다이제스트로 기존 항목을 찾아 같은 객체 번호를 돌려주지만 객체는 이미 없다.
    expect(naive.asIndirect()).toBe(num);
    expect(fontLive(naive)).toBe(false);
    expect(() => naive.put('X', doc.newInteger(1))).toThrow(/not a dict/);
    const salted = embedFallback(doc, 1);
    expect(fontLive(salted)).toBe(true);
    expect(salted.asIndirect()).not.toBe(num);
    doc.abandonOperation();
  });

  it('작업 밖에서 만든 객체(Info)는 그 작업을 버려도 남고, 작업 안에서 만든 Info 는 trailer 가 끊긴다', () => {
    const inside = openPlain();
    ensureNothing(inside);
    inside.enableJournal();
    inside.beginOperation('first-edit');
    const info = inside.addObject(inside.newDictionary());
    inside.getTrailer().put('Info', info);
    inside.abandonOperation();
    // trailer 변경은 저널에 기록되지 않아 /Info 가 사라진 객체를 가리킨다.
    expect(inside.getTrailer().get('Info').isIndirect()).toBe(true);
    expect(inside.getTrailer().get('Info').resolve().isNull()).toBe(true);

    const outside = openPlain();
    ensureInfoDictionary(outside);
    outside.enableJournal();
    outside.beginOperation('first-edit');
    outside.getTrailer().get('Info').put('X', outside.newInteger(1));
    outside.abandonOperation();
    expect(outside.getTrailer().get('Info').isDictionary()).toBe(true);
    expect(outside.getTrailer().get('Info').get('X').isNull()).toBe(true);
  });

  it('getTrailer() 를 객체 추가보다 먼저 받아 두면 그 trailer 에 넣은 값이 현재 trailer 에 없다', () => {
    const doc = openPlain();
    const stale = doc.getTrailer();
    const info = doc.addObject(doc.newDictionary());
    stale.put('Info', info);
    expect(doc.getTrailer().get('Info').isNull()).toBe(true);
    doc.getTrailer().put('Info', info);
    expect(doc.getTrailer().get('Info').isDictionary()).toBe(true);
  });
});

function ensureNothing(doc: mupdf.PDFDocument): void {
  expect(doc.getTrailer().get('Info').isNull()).toBe(true);
}

describe('V1: 계약 시나리오', () => {
  it('폴백을 넣은 초안 취소 뒤 새 편집', () => {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    let salt = 0;
    doc.beginOperation('draft');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, embedFallback(doc, salt++));
    doc.abandonOperation();
    expect(pageText(doc)).toBe('Original');

    doc.beginOperation('edit');
    const font = embedFallback(doc, salt);
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    const saved = doc.saveToBuffer(SAVE);
    const out = openPdf(saved.asUint8Array().slice());
    saved.destroy();
    expect(pageText(out)).toContain('Original');
    expect(ink(out)).toBeGreaterThan(ink(openPlain()));
  });

  it('폴백을 넣은 편집 undo 뒤 새 편집 → 저장', () => {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    let salt = 0;
    doc.beginOperation('edit1');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, embedFallback(doc, salt++));
    doc.endOperation();
    doc.undo();
    expect(pageText(doc)).toBe('Original');

    doc.beginOperation('edit2');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, embedFallback(doc, salt));
    doc.endOperation();
    const base = ink(doc);
    const saved = doc.saveToBuffer(SAVE);
    const out = openPdf(saved.asUint8Array().slice());
    saved.destroy();
    expect(ink(out)).toBe(base);
  });

  it('D9 저장 순서 뒤 undo/redo: 저장은 저널 단계를 만들지 않고 첫 undo 가 유효하다', () => {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    doc.beginOperation('edit');
    const font = embedFallback(doc, 0);
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    const edited = ink(doc);

    // 감싼 저장(D9): 작업 안에서 Info 기록·서브셋 교체 → 저장 → 작업 버림.
    const wrappedSave = (): Uint8Array => {
      doc.beginOperation('save');
      doc.getTrailer().get('Info').put('PdfEditorEdits', doc.newString('pages=1'));
      const file = font.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
      file.writeStream(FONT.subarray(0, 1000)); // 서브셋 교체 흉내
      const buffer = doc.saveToBuffer(SAVE);
      const bytes = buffer.asUint8Array().slice();
      buffer.destroy();
      doc.abandonOperation();
      return bytes;
    };
    const first = wrappedSave();
    const second = wrappedSave();
    expect(openPdf(first).getTrailer().get('Info').get('PdfEditorEdits').asString()).toBe(
      'pages=1',
    );
    expect(second.length).toBeGreaterThan(0);
    expect(doc.getJournal()).toEqual({ position: 1, steps: ['edit'] });
    expect(doc.getTrailer().get('Info').get('PdfEditorEdits').isNull()).toBe(true);
    expect(
      font
        .get('DescendantFonts')
        .get(0)
        .get('FontDescriptor')
        .get('FontFile2')
        .readStream()
        .asUint8Array().length,
    ).toBe(FONT.length);
    expect(ink(doc)).toBe(edited);

    doc.undo();
    expect(pageText(doc)).toBe('Original');
    expect(fontLive(font)).toBe(false);
    doc.redo();
    expect(ink(doc)).toBe(edited);
    expect(fontLive(font)).toBe(true);
  });

  it('감싸지 않은 objstms 저장은 저널 단계를 만든다(D9 가 필요한 이유)', () => {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    doc.beginOperation('edit');
    addBlock(doc, 'BT /F1 20 Tf 10 100 Td (BLOCK) Tj ET');
    doc.endOperation();
    doc.saveToBuffer(SAVE).destroy();
    expect(doc.getJournal().steps).toEqual(['edit', 'Save document']);
    doc.undo();
    // 저장 단계를 되돌린 것이라 화면이 그대로다(첫 undo 가 무효).
    expect(pageText(doc)).toContain('BLOCK');
  });
});
