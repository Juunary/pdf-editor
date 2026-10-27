import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import {
  assessRedactionImpact,
  detachRedactAnnots,
  listRedactAnnots,
  redactRegions,
  withRedactAnnotsDetached,
} from '../src/index.js';

/**
 * 200x200pt, 2 pages. Page 1: "KEEP" (y=150), "EDIT" (y=100), "MARK" (y=50) text,
 * 2 existing Redact annotations (above MARK, partly overlapping the left of EDIT), 1 link (above EDIT). Page 2: 1 Redact annotation.
 * MuPDF coordinates (y downward): KEEP≈[10,40..55], EDIT≈[10,90..105], MARK≈[10,140..155].
 */
function sample(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const text = (y: number, s: string) => `BT /F1 12 Tf 10 ${y} Td (${s}) Tj ET`;
  const content = [text(150, 'KEEP'), text(100, 'EDIT'), text(50, 'MARK')].join('\n');
  for (let i = 0; i < 2; i++) {
    doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, { Font: { F1: font } }, content));
  }
  const p1 = doc.loadPage(0);
  const mark = p1.createAnnotation('Redact');
  mark.setRect([0, 135, 200, 160]);
  mark.setContents('기존: MARK');
  mark.getObject().put('OverlayText', doc.newString('REDACTED'));
  mark.update();
  const overlap = p1.createAnnotation('Redact');
  overlap.setRect([0, 85, 30, 110]);
  overlap.update();
  p1.createLink([10, 88, 60, 106], 'https://example.com/edit');
  const p2 = doc.loadPage(1);
  p2.createAnnotation('Redact').setRect([0, 0, 50, 50]);
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

const EDIT_RECT: [number, number, number, number] = [0, 85, 200, 110];
const open = (b: Uint8Array) =>
  mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
const text = (doc: mupdf.PDFDocument, p = 0) => {
  const page = doc.loadPage(p);
  const t = page.toStructuredText('').asText();
  page.destroy();
  return t;
};
const annotStrings = (doc: mupdf.PDFDocument, nums: number[]) =>
  nums.map((n) => doc.newIndirect(n).resolve().toString());

describe('listRedactAnnots', () => {
  it('number, page, position and OverlayText of Redact annotations in the whole document', () => {
    const r = listRedactAnnots(open(sample()));
    expect(r.total).toBe(3);
    expect(r.pages).toEqual([0, 1]);
    const [mark, overlap, p2] = r.annots;
    expect(mark).toMatchObject({
      pageIndex: 0,
      annotIndex: 0,
      overlayText: 'REDACTED',
      contents: '기존: MARK',
    });
    expect(mark!.rect).toEqual([0, 135, 200, 160]);
    expect(overlap!.rect).toEqual([0, 85, 30, 110]);
    expect(p2!.pageIndex).toBe(1);
  });
});

describe('assessRedactionImpact', () => {
  it('warn if an existing Redact or link overlaps the edit region', () => {
    const imp = assessRedactionImpact(open(sample()), 0, [EDIT_RECT]);
    expect(imp.preexisting.length).toBe(2);
    expect(imp.overlapping.map((a) => a.annotIndex)).toEqual([1]);
    expect(imp.linksRemoved.map((l) => l.uri)).toEqual(['https://example.com/edit']);
    expect(imp.level).toBe('warn');
    expect(imp.messages.length).toBe(3);
  });

  it('info if there is no overlap, none if there is no Redact annotation', () => {
    expect(assessRedactionImpact(open(sample()), 0, [[0, 35, 200, 60]]).level).toBe('info');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    expect(assessRedactionImpact(doc, 0, [[0, 0, 10, 10]]).level).toBe('none');
  });
});

describe('edit redaction on a document with existing Redact annotations', () => {
  it('per-annotation application: erases only the new region and the existing annotation object remains byte-identical (the overlapping link is removed)', () => {
    const doc = open(sample());
    const nums = listRedactAnnots(doc).annots.map((a) => a.objectNumber);
    const before = annotStrings(doc, nums);
    const r = redactRegions(doc.loadPage(0), [EDIT_RECT]);
    expect(r.preexistingRedactAnnots).toBe(2);
    expect(listRedactAnnots(doc).annots.map((a) => a.objectNumber)).toEqual(nums);
    expect(annotStrings(doc, nums)).toEqual(before);
    const t = text(doc);
    expect(t).toContain('KEEP');
    expect(t).toContain('MARK'); // text under the existing Redact stays as is
    expect(t).not.toContain('EDIT');
    const page = doc.loadPage(0);
    expect(page.getLinks().length).toBe(0);
  });

  it('control: page-level applyRedactions also applies the existing annotations', () => {
    const doc = open(sample());
    const page = doc.loadPage(0);
    page.createAnnotation('Redact').setRect(EDIT_RECT);
    page.applyRedactions(false, 0, 0, 0);
    expect(text(doc)).not.toContain('MARK');
    expect(listRedactAnnots(doc, [0]).total).toBe(0);
  });

  it('temporary detach: sets aside existing annotations during page-level redaction and restores them in the original order', () => {
    const doc = open(sample());
    const nums = listRedactAnnots(doc, [0]).annots.map((a) => a.objectNumber);
    const before = annotStrings(doc, nums);
    const annotsBefore = doc.findPage(0).get('Annots').toString();
    withRedactAnnotsDetached(doc, 0, () => {
      const page = doc.loadPage(0);
      expect(page.getAnnotations().filter((a) => a.getType() === 'Redact').length).toBe(0);
      page.createAnnotation('Redact').setRect(EDIT_RECT);
      page.applyRedactions(false, 0, 0, 0);
      page.destroy();
    });
    expect(text(doc)).toContain('MARK');
    expect(text(doc)).not.toContain('EDIT');
    expect(listRedactAnnots(doc, [0]).annots.map((a) => a.objectNumber)).toEqual(nums);
    expect(annotStrings(doc, nums)).toEqual(before);
    // The link is removed by redaction and drops out of /Annots. The remaining order is as before.
    expect(doc.findPage(0).get('Annots').toString()).toBe(annotsBefore.replace(/ \d+ 0 R\]$/, ']'));
  });

  it('temporary detach: fails if that page object is open, and restores /Annots', () => {
    const doc = open(sample());
    const held = doc.loadPage(0);
    held.getAnnotations();
    const annotsBefore = doc.findPage(0).get('Annots').toString();
    expect(() => detachRedactAnnots(doc, 0)).toThrow(/열려 있어/);
    expect(doc.findPage(0).get('Annots').toString()).toBe(annotsBefore);
    held.destroy();
    expect(detachRedactAnnots(doc, 0).detached.length).toBe(2);
  });
});
