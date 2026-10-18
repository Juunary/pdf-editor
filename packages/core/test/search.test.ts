import { describe, expect, it } from 'vitest';
import { PdfSession } from '../src/index.js';
import { buildPdf, hexGlyphs } from './pdf-fixtures.js';

const line = (text: string, y = 150) => `BT /F1 12 Tf 10 ${y} Td (${text}) Tj ET`;

/** p0: "Needle needle", p1: 없음, p2: "NEEDLE", p3: "needle needle needle". */
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
  it('기본은 대소문자를 구분하지 않고 쪽 순서로 돌려준다', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle' });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([0, 0, 2, 3, 3, 3]);
    expect(r.pagesSearched).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.query).toBe('needle');
    expect(r.searchMs).toBeGreaterThanOrEqual(0);
    s.close();
  });

  it('caseSensitive: true 는 대소문자를 구분한다', () => {
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

  it('startPage 부터 끝까지 간 뒤 0 쪽으로 돌아온다', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle', startPage: 2 });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([2, 3, 3, 3, 0, 0]);
    expect(r.pagesSearched).toBe(4);
    s.close();
  });

  it('pageLimit 은 시작 쪽부터 센다(순환 포함)', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: 'needle', startPage: 3, pageLimit: 2 });
    expect(r.hits.map((h) => h.pageIndex)).toEqual([3, 3, 3, 0, 0]);
    expect(r.pagesSearched).toBe(2);
    // 쪽 수보다 큰 pageLimit 은 쪽 수로 제한한다(같은 쪽을 두 번 보지 않는다).
    expect(s.searchText({ query: 'needle', pageLimit: 99 }).pagesSearched).toBe(4);
    expect(s.searchText({ query: 'needle', pageLimit: 0 }).pagesSearched).toBe(0);
    s.close();
  });

  it('maxHits 를 넘는 결과가 더 있을 때만 truncated', () => {
    const s = open(fourPagePdf());
    const cut = s.searchText({ query: 'needle', maxHits: 2 });
    expect(cut.hits).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    // 결과가 정확히 maxHits 개이고 더 없으면 잘린 것이 아니다.
    const exact = s.searchText({ query: 'needle', maxHits: 6 });
    expect(exact.hits).toHaveLength(6);
    expect(exact.truncated).toBe(false);
    s.close();
  });

  it('결과 quad 는 페이지 공간(좌상단 원점)이고 줄이 바뀌면 한 결과가 quad 여러 개', () => {
    const s = open(
      buildPdf([`BT /F1 12 Tf 10 150 Td (foo bar) Tj 0 -14 Td (baz qux) Tj ET`, line('x')]),
    );
    const single = s.searchText({ query: 'foo' }).hits[0]!;
    expect(single.quads).toHaveLength(1);
    const [ulx, uly, urx, ury, llx, lly, lrx, lry] = single.quads[0]!;
    // 기준선 y=150(사용자 공간) → 페이지 공간 y=50. 글자 사각형이 기준선을 둘러싼다.
    expect(ulx).toBeCloseTo(10, 1);
    expect(uly).toBeLessThan(50);
    expect(lly).toBeGreaterThan(50);
    expect(urx).toBeGreaterThan(ulx);
    // 가로 글자라 윗변·아랫변이 수평이고 좌우변이 수직이다.
    expect(ury).toBeCloseTo(uly, 3);
    expect(lry).toBeCloseTo(lly, 3);
    expect(llx).toBeCloseTo(ulx, 3);
    expect(lrx).toBeCloseTo(urx, 3);

    const wrapped = s.searchText({ query: 'bar baz' }).hits;
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]!.quads).toHaveLength(2);
    s.close();
  });

  it('한글 검색', () => {
    const s = open(
      buildPdf([`BT /F2 14 Tf 10 150 Td ${hexGlyphs('안녕하세요')} Tj ET`, line('x')]),
    );
    const r = s.searchText({ query: '하세' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]!.pageIndex).toBe(0);
    s.close();
  });

  it('빈 검색어는 쪽을 보지 않고 빈 결과', () => {
    const s = open(fourPagePdf());
    const r = s.searchText({ query: '' });
    expect(r).toMatchObject({ hits: [], truncated: false, pagesSearched: 0 });
    s.close();
  });

  it('한 쪽의 결과가 MuPDF 상한(500 quad)에 닿으면 truncated', () => {
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

  it('잘못된 인자는 RangeError', () => {
    const s = open(fourPagePdf());
    expect(() => s.searchText({ query: 'a', startPage: 4 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', startPage: -1 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', pageLimit: -1 })).toThrow(RangeError);
    expect(() => s.searchText({ query: 'a', maxHits: 0 })).toThrow(RangeError);
    s.close();
  });
});
