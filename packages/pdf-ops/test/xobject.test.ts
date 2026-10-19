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
 * 2쪽 문서. Fx1(카드: 배경·제목·문단·중첩 Fx2)을 1쪽 2곳(A: y=560, B: y=300)과 2쪽 1곳에서 그린다.
 * Fx2(배지: 배경·2줄)는 Fx1 안과 2쪽에서 직접 그린다. 두 페이지는 Resources 간접 객체를 공유한다.
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

/** 원본 객체 중 문자열 표현 또는 원시 스트림이 바뀐 객체 번호. */
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

  it('중첩 Form 까지 사용 위치·경로·CTM 을 낸다', () => {
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

  it('공유 횟수: Fx1 3곳, Fx2 4곳', () => {
    const counts = [...indexXObjectUsages(doc).values()].map((l) => l.length).sort();
    expect(counts).toEqual([3, 4]);
  });
});

describe('redactFormUsage: 선택 사용 위치만 새 인스턴스로 교체', () => {
  const bytes = sharedDoc();

  it('1단계: 1쪽 B 의 문단만 지우고 A·2쪽·원본 객체는 그대로', () => {
    const doc = open(bytes);
    const before = open(bytes);
    const b = listXObjectUsages(doc, 0)[2]!;
    const r = redactFormUsage(doc, b, [[0, 80, 480, 115]]);
    expect(r.originalUsageCount).toBe(3);
    expect(r.newForms.length).toBe(2); // Fx1 인스턴스 + 그 안의 Fx2 인스턴스

    const t0 = text(doc, 0);
    expect(count(t0, 'Shared para one')).toBe(1); // A 만 남음
    expect(count(t0, 'Card title')).toBe(2);
    expect(count(t0, 'Nested one')).toBe(2);
    expect(text(doc, 1)).toBe(text(before, 1));
    expect(pixels(doc, 1)).toEqual(pixels(before, 1));

    // 원본 객체 중 바뀐 것은 1쪽 페이지 사전뿐(Contents·Resources 교체). Fx1·Fx2·공유 Resources·2쪽은 그대로.
    expect(changedObjects(before, doc)).toEqual([before.findPage(0).asIndirect()]);
    const after = listXObjectUsages(doc, 0);
    expect(after[0]!.objectNumber).toBe(b.objectNumber); // A 는 원본 Fx1
    expect(after[2]!.objectNumber).toBe(r.targetObjectNumber);
    expect(doc.countPages()).toBe(2);
  });

  it('2단계(중첩): 1쪽 B 안의 Fx2 문단만 지우고 새 텍스트를 Form 공간에 붙인다', () => {
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

  it('MuPDF 기본(페이지 redaction)은 같은 페이지의 모든 Form 사용 위치를 새 인스턴스로 바꾼다', () => {
    const doc = open(bytes);
    const fx1 = listXObjectUsages(doc, 0)[0]!.objectNumber;
    const page = doc.loadPage(0);
    const annot = page.createAnnotation('Redact');
    annot.setRect([56, 842 - 415, 536, 842 - 380]);
    annot.applyRedaction(0, 0, 0, 0);
    const after = listXObjectUsages(doc, 0);
    expect(after.every((u) => u.objectNumber !== fx1)).toBe(true); // A 도 원본이 아님
    expect(listXObjectUsages(doc, 1)[0]!.objectNumber).toBe(fx1); // 다른 페이지는 원본
  });
});

describe('사각형 정규화(A7-3): 뒤집힌 /BBox [0 792 612 0]', () => {
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

  it('toRect 는 x0 ≤ x1, y0 ≤ y1 로 정규화한다', () => {
    const doc = new mupdf.PDFDocument();
    const arr = doc.newArray();
    for (const v of [0, 792, 612, 0]) arr.push(v);
    expect(toRect(arr)).toEqual([0, 0, 612, 792]);
  });

  it('사용 위치의 페이지 공간 경계가 빈 사각형이 아니다', () => {
    const doc = open(flippedDoc());
    const [u] = listXObjectUsages(doc, 0);
    expect(u).toBeDefined();
    const [x0, y0, x1, y1] = u!.pageBox;
    expect(x1 - x0).toBeCloseTo(612);
    expect(y1 - y0).toBeCloseTo(792);
  });

  it('BBox 안의 사각형을 BBox 밖으로 오판하지 않는다', () => {
    const doc = open(flippedDoc());
    const fx = doc.findPage(0).get('Resources').get('XObject').get('Fx');
    expect(outsideFormBBox(fx, [72, 690, 300, 712])).toBe(false);
    expect(outsideFormBBox(fx, [72, 690, 700, 712])).toBe(true);
  });
});
