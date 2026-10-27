import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  appendFormContent,
  indexXObjectUsages,
  listXObjectUsages,
  outsideFormBBox,
  redactFormUsage,
  samePath,
  toRect,
} from '../src/index.js';

/**
 * 2-page document. Fx1 (card: background, title, paragraph, nested Fx2) is drawn at 2 places on page 1 (A: y=560, B: y=300) and 1 place on page 2.
 * Fx2 (badge: background, 2 lines) is drawn directly inside Fx1 and on page 2. The two pages share a Resources indirect object.
 */
function sharedDoc(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const fx2 = doc.addStream(
    '1 0.9 0.8 rg 0 0 120 40 re f\nBT /F1 9 Tf 0 0 0 rg 6 26 Td (Nested one) Tj 0 -12 Td (Nested two) Tj ET\n',
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 120, 40], Resources: { Font: { F1 } } },
  );
  const fx1 = doc.addStream(
    [
      '0.93 0.95 1 rg 0 0 480 160 re f',
      'BT /F1 14 Tf 0 0 0 rg 10 136 Td (Card title) Tj ET',
      'BT /F1 11 Tf 0 0 0 rg 10 100 Td (Shared para one) Tj 0 -14 Td (Shared para two) Tj ET',
      'q 1 0 0 1 340 10 cm /Fx2 Do Q',
    ].join('\n'),
    {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 480, 160],
      Resources: { Font: { F1 }, XObject: { Fx2: fx2 } },
    },
  );
  const res = doc.addObject({ Font: { F1 }, XObject: { Fx1: fx1, Fx2: fx2 } });
  const page = (c: string) => doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, c));
  page('q 1 0 0 1 56 560 cm /Fx1 Do Q\nq 1 0 0 1 56 300 cm /Fx1 Do Q\n');
  page('q 1 0 0 1 56 560 cm /Fx1 Do Q\nq 1 0 0 1 400 200 cm /Fx2 Do Q\n');
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

const open = (b: Uint8Array) =>
  mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
const text = (doc: mupdf.PDFDocument, p: number) => doc.loadPage(p).toStructuredText('').asText();
const count = (s: string, needle: string) => s.split(needle).length - 1;
const pixels = (doc: mupdf.PDFDocument, p: number) =>
  doc.loadPage(p).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false).getPixels();

/** Object numbers among the original objects whose string representation or raw stream changed. */
function changedObjects(before: mupdf.PDFDocument, after: mupdf.PDFDocument): number[] {
  const changed: number[] = [];
  for (let n = 1; n < before.countObjects(); n++) {
    const a = before.newIndirect(n);
    const b = after.newIndirect(n);
    const same =
      a.resolve().toString() === b.resolve().toString() &&
      (!a.isStream() ||
        Buffer.from(a.readRawStream().asUint8Array()).equals(
          Buffer.from(b.readRawStream().asUint8Array()),
        ));
    if (!same) changed.push(n);
  }
  return changed;
}

describe('listXObjectUsages / indexXObjectUsages', () => {
  const doc = open(sharedDoc());

  it('reports usage sites, paths and CTM down to nested Forms', () => {
    const u = listXObjectUsages(doc, 0);
    expect(u.map((x) => x.path.map((s) => `${s.resourceName}#${s.doOrdinal}`).join('>'))).toEqual([
      'Fx1#0',
      'Fx1#0>Fx2#0',
      'Fx1#1',
      'Fx1#1>Fx2#0',
    ]);
    expect(u[2]!.toPage).toEqual([1, 0, 0, 1, 56, 300]);
    expect(u[3]!.pageBox).toEqual([396, 310, 516, 350]);
  });

  it('sharing counts: Fx1 3 places, Fx2 4 places', () => {
    const counts = [...indexXObjectUsages(doc).values()].map((l) => l.length).sort();
    expect(counts).toEqual([3, 4]);
  });
});

describe('redactFormUsage: replaces only the selected usage sites with new instances', () => {
  const bytes = sharedDoc();

  it('step 1: erases only the paragraph of B on page 1 and leaves A, page 2 and the original objects as they are', () => {
    const doc = open(bytes);
    const before = open(bytes);
    const b = listXObjectUsages(doc, 0)[2]!;
    const r = redactFormUsage(doc, b, [[0, 80, 480, 115]]);
    expect(r.originalUsageCount).toBe(3);
    expect(r.newForms.length).toBe(2); // Fx1 instance + the Fx2 instance inside it

    const t0 = text(doc, 0);
    expect(count(t0, 'Shared para one')).toBe(1); // only A remains
    expect(count(t0, 'Card title')).toBe(2);
    expect(count(t0, 'Nested one')).toBe(2);
    expect(text(doc, 1)).toBe(text(before, 1));
    expect(pixels(doc, 1)).toEqual(pixels(before, 1));

    // Among the original objects, only the page 1 page dictionary changed (Contents and Resources replaced). Fx1, Fx2, shared Resources and page 2 are unchanged.
    expect(changedObjects(before, doc)).toEqual([before.findPage(0).asIndirect()]);
    const after = listXObjectUsages(doc, 0);
    expect(after[0]!.objectNumber).toBe(b.objectNumber); // A is the original Fx1
    expect(after[2]!.objectNumber).toBe(r.targetObjectNumber);
    expect(doc.countPages()).toBe(2);
  });

  it('step 2 (nested): erases only the Fx2 paragraph inside B on page 1 and attaches the new text in Form space', () => {
    const doc = open(bytes);
    const before = open(bytes);
    const nested = listXObjectUsages(doc, 0)[3]!;
    expect(samePath(nested.path.slice(0, 1), listXObjectUsages(doc, 0)[2]!.path)).toBe(true);
    const r = redactFormUsage(doc, nested, [[0, 0, 120, 40]]);
    expect(r.target.get('BBox').toString()).toBe('[0 0 120 40]');
    expect(outsideFormBBox(r.target, [6, 10, 110, 30])).toBe(false);
    appendFormContent(r.target, 'BT /F1 9 Tf 0 0 0 rg 6 16 Td (Replaced) Tj ET\n');

    const t0 = text(doc, 0);
    expect(count(t0, 'Nested one')).toBe(1);
    expect(count(t0, 'Replaced')).toBe(1);
    expect(count(t0, 'Shared para one')).toBe(2);
    expect(text(doc, 1)).toBe(text(before, 1));
    expect(pixels(doc, 1)).toEqual(pixels(before, 1));
    expect(changedObjects(before, doc)).toEqual([before.findPage(0).asIndirect()]);
  });

  it('MuPDF default (page redaction) replaces all Form usage sites on the same page with new instances', () => {
    const doc = open(bytes);
    const fx1 = listXObjectUsages(doc, 0)[0]!.objectNumber;
    const page = doc.loadPage(0);
    const annot = page.createAnnotation('Redact');
    annot.setRect([56, 842 - 415, 536, 842 - 380]);
    annot.applyRedaction(0, 0, 0, 0);
    const after = listXObjectUsages(doc, 0);
    expect(after.every((u) => u.objectNumber !== fx1)).toBe(true); // A is not the original either
    expect(listXObjectUsages(doc, 1)[0]!.objectNumber).toBe(fx1); // the other page is the original
  });
});

describe('rectangle normalization (A7-3): flipped /BBox [0 792 612 0]', () => {
  function flippedDoc(): Uint8Array {
    const doc = new mupdf.PDFDocument();
    const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
    const fx = doc.addStream('BT /F1 11 Tf 0 0 0 rg 72 700 Td (Running head) Tj ET\n', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 792, 612, 0],
      Resources: { Font: { F1 } },
    });
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, { XObject: { Fx: fx } }, '/Fx Do\n'));
    return doc.saveToBuffer('compress').asUint8Array().slice();
  }

  it('toRect normalizes to x0 <= x1, y0 <= y1', () => {
    const doc = new mupdf.PDFDocument();
    const arr = doc.newArray();
    for (const v of [0, 792, 612, 0]) arr.push(v);
    expect(toRect(arr)).toEqual([0, 0, 612, 792]);
  });

  it('the page-space bounds of the usage site are not an empty rectangle', () => {
    const doc = open(flippedDoc());
    const [u] = listXObjectUsages(doc, 0);
    expect(u).toBeDefined();
    const [x0, y0, x1, y1] = u!.pageBox;
    expect(x1 - x0).toBeCloseTo(612);
    expect(y1 - y0).toBeCloseTo(792);
  });

  it('a rectangle inside the BBox is not misjudged as outside the BBox', () => {
    const doc = open(flippedDoc());
    const fx = doc.findPage(0).get('Resources').get('XObject').get('Fx');
    expect(outsideFormBBox(fx, [72, 690, 300, 712])).toBe(false);
    expect(outsideFormBBox(fx, [72, 690, 700, 712])).toBe(true);
  });
});
