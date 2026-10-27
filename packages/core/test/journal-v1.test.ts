/**
 * All of V1 (docs/m3-contract.md 6.1, docs/m3-core.md section 2): whether the MuPDF journal undoes/redoes edit block Form addition, stream replacement, resource addition and
 * font addition, a new edit after cancelling a draft that inserted the fallback or after undo, and undo/redo after the D9 save sequence.
 * Uses MuPDF only (independent of pdf-ops and reflow). Pins the behavior verified on 2026-10-19 with server Node 22 and mupdf 1.28.1.
 */
import '../src/wasm-module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { openPdf } from '../src/open.js';
import { ensureInfoDictionary } from '../src/edit-util.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
const SAVE = 'garbage=yes,compress,objstms';
/** A single character "가" used with the fallback font (Identity-H 2-byte gid, a glyph with ink). */
const GA = `<${new mupdf.Font('NotoSansKR', FONT).encodeCharacter('가'.codePointAt(0)!).toString(16).padStart(4, '0')}>`;

/** A page with one Latin sentence. Reopened with the same Stream input as the session. */
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

/** Edit block: add a Form + register it in the page Resources + add a call to the page content. Called inside an operation. */
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

/** Adds the fallback font (Type0, Identity-H). The contract (D4 amendment 1) is to call it once before enabling the journal. */
function embedFallback(doc: mupdf.PDFDocument): mupdf.PDFObject {
  const ref = doc.addFont(new mupdf.Font('NotoSansKR', FONT));
  ref.put('PdfEditorFallback', doc.newBoolean(true));
  return ref;
}

const fontLive = (ref: mupdf.PDFObject): boolean => ref.resolve().isDictionary();

describe('V1: the journal reverts edit block changes', () => {
  it('undoes/redoes block Form addition, page content replacement and resource addition, and a change outside an operation throws', () => {
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

  it('editing the same block stream several times inside one operation is one step, and undo returns to the pre-operation content', () => {
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

  it('render, structured text and page load create no journal step', () => {
    const doc = openPlain();
    doc.enableJournal();
    ink(doc);
    pageText(doc);
    doc.loadPage(0).destroy();
    expect(doc.getJournal()).toEqual({ position: 0, steps: [] });
  });
});

describe('V1: fallback font lifetime', () => {
  it('re-inserting a font the journal reverted with the same bytes restores the broken reference (MuPDF 1.28.1 font resource table)', () => {
    const doc = openPlain();
    doc.enableJournal();
    doc.beginOperation('draft');
    const first = embedFallback(doc);
    expect(fontLive(first)).toBe(true);
    const num = first.asIndirect();
    doc.abandonOperation();
    expect(doc.newIndirect(num).resolve().isNull()).toBe(true);

    doc.beginOperation('again');
    const naive = doc.addFont(new mupdf.Font('NotoSansKR', FONT));
    // It finds the existing entry via the font byte digest and returns the same object number, but the object no longer exists.
    expect(naive.asIndirect()).toBe(num);
    expect(fontLive(naive)).toBe(false);
    expect(() => naive.put('X', doc.newInteger(1))).toThrow(/not a dict/);
    doc.abandonOperation();
  });

  it('a font inserted before enabling the journal does not disappear on draft cancel or undo', () => {
    const doc = openPlain();
    const font = embedFallback(doc);
    ensureInfoDictionary(doc);
    doc.enableJournal();
    doc.beginOperation('draft');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.abandonOperation();
    expect(fontLive(font)).toBe(true);
    doc.beginOperation('edit');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    doc.undo();
    expect(fontLive(font)).toBe(true);
    doc.redo();
    expect(fontLive(font)).toBe(true);
  });

  it('an object created outside an operation (Info) survives discarding that operation, while an Info created inside an operation leaves the trailer broken', () => {
    const inside = openPlain();
    ensureNothing(inside);
    inside.enableJournal();
    inside.beginOperation('first-edit');
    const info = inside.addObject(inside.newDictionary());
    inside.getTrailer().put('Info', info);
    inside.abandonOperation();
    // The trailer change is not recorded in the journal, so /Info points to an object that is gone.
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

  it('if getTrailer() is obtained before adding the object, the value put into that trailer is missing from the current trailer', () => {
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

describe('V1: redo step preservation after undo', () => {
  /** A document with two operations committed and one undone (redo possible). */
  function undone(): { doc: mupdf.PDFDocument; pageObj: mupdf.PDFObject } {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    const page = doc.loadPage(0);
    const pageObj = page.getObject();
    for (const key of ['A', 'B']) {
      doc.beginOperation(`edit-${key}`);
      pageObj.put(key, doc.newInteger(1));
      doc.endOperation();
    }
    doc.undo();
    page.destroy();
    return { doc, pageObj };
  }
  const redoable = (doc: mupdf.PDFDocument): boolean => doc.canRedo();

  it('opening and discarding or closing an operation without changes (classification probe) leaves redo intact', () => {
    const { doc } = undone();
    expect(redoable(doc)).toBe(true);
    doc.beginOperation('probe');
    doc.abandonOperation();
    expect(redoable(doc)).toBe(true);
    doc.beginOperation('empty');
    doc.endOperation();
    expect(redoable(doc)).toBe(true);
    expect(doc.getJournal().steps).toEqual(['edit-A', 'edit-B']);
  });

  it('the first object change inside an operation removes the redo steps and they do not come back even after abandon', () => {
    const { doc, pageObj } = undone();
    doc.beginOperation('draft');
    pageObj.put('C', doc.newInteger(1));
    doc.abandonOperation();
    expect(redoable(doc)).toBe(false);
    expect(doc.getJournal()).toEqual({ position: 1, steps: ['edit-A'] });
  });

  it('changing Info inside a save operation (contract D9 order) makes a save right after undo lose redo', () => {
    const wrapped = (change: boolean): boolean => {
      const { doc } = undone();
      doc.beginOperation('save');
      if (change) doc.getTrailer().get('Info').put('PdfEditorEdits', doc.newString('pages=1'));
      doc.saveToBuffer(SAVE).destroy();
      doc.abandonOperation();
      return redoable(doc);
    };
    expect(wrapped(false)).toBe(true);
    expect(wrapped(true)).toBe(false);
  });
});

describe('V1: contract scenarios', () => {
  /** Preparation order of the first `beginParagraphEdit` of a session: create the fallback font and Info, then enable the journal. */
  function prepared(): { doc: mupdf.PDFDocument; font: mupdf.PDFObject } {
    const doc = openPlain();
    const font = embedFallback(doc);
    ensureInfoDictionary(doc);
    doc.enableJournal();
    return { doc, font };
  }

  it('a new edit after cancelling a draft that inserted the fallback', () => {
    const { doc, font } = prepared();
    doc.beginOperation('draft');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.abandonOperation();
    expect(pageText(doc)).toBe('Original');

    doc.beginOperation('edit');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    const saved = doc.saveToBuffer(SAVE);
    const out = openPdf(saved.asUint8Array().slice());
    saved.destroy();
    expect(pageText(out)).toContain('Original');
    expect(ink(out)).toBeGreaterThan(ink(openPlain()));
  });

  it('a new edit after undoing an edit that inserted the fallback → save', () => {
    const { doc, font } = prepared();
    doc.beginOperation('edit1');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    doc.undo();
    expect(pageText(doc)).toBe('Original');

    doc.beginOperation('edit2');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    const base = ink(doc);
    const saved = doc.saveToBuffer(SAVE);
    const out = openPdf(saved.asUint8Array().slice());
    saved.destroy();
    expect(ink(out)).toBe(base);
  });

  it('undo/redo after the D9 save sequence: the save creates no journal step and the first undo is valid', () => {
    const { doc, font } = prepared();
    doc.beginOperation('edit');
    addBlock(doc, `BT /FB 14 Tf 10 100 Td ${GA} Tj ET`, font);
    doc.endOperation();
    const edited = ink(doc);

    // Wrapped save (D9): Info record and subset replacement inside an operation → save → discard the operation.
    const wrappedSave = (): Uint8Array => {
      doc.beginOperation('save');
      doc.getTrailer().get('Info').put('PdfEditorEdits', doc.newString('pages=1'));
      const file = font.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
      file.writeStream(FONT.subarray(0, 1000)); // imitates the subset replacement
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
    expect(fontLive(font)).toBe(true);
    doc.redo();
    expect(ink(doc)).toBe(edited);
    expect(fontLive(font)).toBe(true);
  });

  it('an unwrapped objstms save creates a journal step (why D9 is needed)', () => {
    const doc = openPlain();
    ensureInfoDictionary(doc);
    doc.enableJournal();
    doc.beginOperation('edit');
    addBlock(doc, 'BT /F1 20 Tf 10 100 Td (BLOCK) Tj ET');
    doc.endOperation();
    doc.saveToBuffer(SAVE).destroy();
    expect(doc.getJournal().steps).toEqual(['edit', 'Save document']);
    doc.undo();
    // It reverted the save step, so the screen is unchanged (the first undo is ineffective).
    expect(pageText(doc)).toContain('BLOCK');
  });
});
