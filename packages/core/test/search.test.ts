import { describe, expect, it } from 'vitest';
import { PdfSession } from '../src/index.js';
import { buildPdf, hexGlyphs } from './pdf-fixtures.js';

const line = (text: string, y = 150) => `BT /F1 12 Tf 10 ${y} Td (${text}) Tj ET`;

/** p0: "Needle needle", p1: none, p2: "NEEDLE", p3: "needle needle needle". */
function fourPagePdf(): Uint8Array {
  return buildPdf([
    line('Needle needle'),
    line('nothing to see'),
    line('NEEDLE'),
    line('needle needle needle'),
  ]);
}

function open(bytes: Uint8Array): PdfSession {
  const s = new PdfSession();
  s.open(bytes);
  return s;
}

describe('searchText', () => {
  it('by default is case-insensitive and returns results in page order', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle' });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([0, 0, 2, 3, 3, 3]);
    expect(r.pagesSearched).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.query).toBe('needle');
    expect(r.searchMs).toBeGreaterThanOrEqual(0);
    s.close();
  });

  it('caseSensitive: true is case-sensitive', () => {
    const s = open(fourPagePdf());
    expect(
      s.searchText({ query: 'needle', caseSensitive: true }).hits.map((h) => h.pageIndex),
    ).toEqual([0, 3, 3, 3]);
    expect(
      s.searchText({ query: 'NEEDLE', caseSensitive: true }).hits.map((h) => h.pageIndex),
    ).toEqual([2]);
    expect(s.searchText({ query: 'needle', caseSensitive: false }).hits).toHaveLength(6);
    s.close();
  });

  it('goes from startPage to the end and then wraps around to page 0', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle', startPage: 2 });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([2, 3, 3, 3, 0, 0]);
    expect(r.pagesSearched).toBe(4);
    s.close();
  });

  it('pageLimit counts from the start page (including wrap-around)', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle', startPage: 3, pageLimit: 2 });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([3, 3, 3, 0, 0]);
    expect(r.pagesSearched).toBe(2);
    // A pageLimit larger than the page count is capped to the page count (the same page is not visited twice).
    expect(s.searchText({ query: 'needle', pageLimit: 99 }).pagesSearched).toBe(4);
    expect(s.searchText({ query: 'needle', pageLimit: 0 }).pagesSearched).toBe(0);
    s.close();
  });

  it('truncated only when there are more results beyond maxHits', () => {
    const s = open(fourPagePdf());
    const cut = s.searchText({ query: 'needle', maxHits: 2 });
    expect(cut.hits).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    // If there are exactly maxHits results and no more, it is not truncated.
    const exact = s.searchText({ query: 'needle', maxHits: 6 });
    expect(exact.hits).toHaveLength(6);
    expect(exact.truncated).toBe(false);
    s.close();
  });

  it('result quads are in page space (top-left origin), and a result spanning lines has several quads', () => {
    const s = open(
      buildPdf([`BT /F1 12 Tf 10 150 Td (foo bar) Tj 0 -14 Td (baz qux) Tj ET`, line('x')]),
    );
    const single = s.searchText({ query: 'foo' }).hits[0]!;
    expect(single.quads).toHaveLength(1);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = single.quads[0]!;
    // Baseline y=150 (user space) → page space y=50. The glyph rectangle surrounds the baseline.
    expect(ulx).toBeCloseTo(10, 1);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(urx).toBeGreaterThan(ulx);
    // Horizontal text, so the top and bottom edges are horizontal and the left and right edges are vertical.
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    expect(llx).toBeCloseTo(ulx, 3);
    expect(lrx).toBeCloseTo(urx, 3);

    const wrapped = s.searchText({ query: 'bar baz' }).hits;
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.quads).toHaveLength(2);
    s.close();
  });

  it('Hangul search', () => {
    const s = open(
      buildPdf([`BT /F2 14 Tf 10 150 Td ${hexGlyphs('안녕하세요')} Tj ET`, line('x')]),
    );
    const r = s.searchText({ query: '하세' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.pageIndex).toBe(0);
    s.close();
  });

  it('an empty query returns an empty result without looking at pages', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: '' });
    expect(r).toMatchObject({ hits: [], truncated: false, pagesSearched: 0 });
    s.close();
  });

  it('truncated when the results of one page reach the MuPDF limit (500 quads)', () => {
    const s = open(
      buildPdf([
        { content: `BT /F1 1 Tf 5 50 Td (${'a'.repeat(700)}) Tj ET`, mediabox: [0, 0, 1000, 100] },
      ]),
    );
    const r = s.searchText({ query: 'a' });
    expect(r.hits.length).toBeLessThanOrEqual(500);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.truncated).toBe(true);
    s.close();
  });

  it('invalid arguments throw RangeError', () => {
    const s = open(fourPagePdf());
    expect(() => s.searchText({ query: 'a', startPage: 4 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', startPage: -1 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', pageLimit: -1 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', maxHits: 0 })).toThrow(RangeError);
    s.close();
  });
});
