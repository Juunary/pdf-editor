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
 * 200x200pt 2쪽. 1쪽: "KEEP"(y=150) · "EDIT"(y=100) · "MARK"(y=50) 텍스트,
 * 기존 Redact 주석 2개(MARK 위, EDIT 왼쪽 일부와 겹침), 링크 1개(EDIT 위). 2쪽: Redact 주석 1개.
 * MuPDF 좌표(y 아래): KEEP≈[10,40..55], EDIT≈[10,90..105], MARK≈[10,140..155].
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
const open = (b: Uint8Array) => mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
const text = (doc: mupdf.PDFDocument, p = 0) => {
  const page = doc.loadPage(p);
  const t = page.toStructuredText('').asText();
  page.destroy();
  return t;
};
const annotStrings = (doc: mupdf.PDFDocument, nums: number[]) =>
  nums.map((n) => doc.newIndirect(n).resolve().toString());

describe('listRedactAnnots', () => {
  it('문서 전체 Redact 주석 수·쪽·위치·OverlayText', () => {
    const r = listRedactAnnots(open(sample()));
    expect(r.total).toBe(3);
    expect(r.pages).toEqual([0, 1]);
    const [mark, overlap, p2] = r.annots;
    expect(mark).toMatchObject({ pageIndex: 0, annotIndex: 0, overlayText: 'REDACTED', contents: '기존: MARK' });
    expect(mark!.rect).toEqual([0, 135, 200, 160]);
    expect(overlap!.rect).toEqual([0, 85, 30, 110]);
    expect(p2!.pageIndex).toBe(1);
  });
});

describe('assessRedactionImpact', () => {
  it('편집 영역과 겹치는 기존 Redact·링크가 있으면 warn', () => {
    const imp = assessRedactionImpact(open(sample()), 0, [EDIT_RECT]);
    expect(imp.preexisting.length).toBe(2);
    expect(imp.overlapping.map((a) => a.annotIndex)).toEqual([1]);
    expect(imp.linksRemoved.map((l) => l.uri)).toEqual(['https://example.com/edit']);
    expect(imp.level).toBe('warn');
    expect(imp.messages.length).toBe(3);
  });

  it('겹침이 없으면 info, Redact 주석이 없으면 none', () => {
    expect(assessRedactionImpact(open(sample()), 0, [[0, 35, 200, 60]]).level).toBe('info');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    expect(assessRedactionImpact(doc, 0, [[0, 0, 10, 10]]).level).toBe('none');
  });
});

describe('기존 Redact 주석이 있는 문서의 편집 redaction', () => {
  it('주석 단위 적용: 새 영역만 지우고 기존 주석 객체는 바이트 그대로 남는다(겹친 링크는 제거)', () => {
    const doc = open(sample());
    const nums = listRedactAnnots(doc).annots.map((a) => a.objectNumber);
    const before = annotStrings(doc, nums);
    const r = redactRegions(doc.loadPage(0), [EDIT_RECT]);
    expect(r.preexistingRedactAnnots).toBe(2);
    expect(listRedactAnnots(doc).annots.map((a) => a.objectNumber)).toEqual(nums);
    expect(annotStrings(doc, nums)).toEqual(before);
    const t = text(doc);
    expect(t).toContain('KEEP');
    expect(t).toContain('MARK'); // 기존 Redact 아래 텍스트는 그대로
    expect(t).not.toContain('EDIT');
    const page = doc.loadPage(0);
    expect(page.getLinks().length).toBe(0);
  });

  it('대조: 페이지 단위 applyRedactions 는 기존 주석까지 적용한다', () => {
    const doc = open(sample());
    const page = doc.loadPage(0);
    page.createAnnotation('Redact').setRect(EDIT_RECT);
    page.applyRedactions(false, 0, 0, 0);
    expect(text(doc)).not.toContain('MARK');
    expect(listRedactAnnots(doc, [0]).total).toBe(0);
  });

  it('임시 분리: 페이지 단위 redaction 중 기존 주석을 빼 두고 원래 순서로 되돌린다', () => {
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
    // 링크는 redaction 으로 제거되어 /Annots 에서 빠진다. 나머지 순서는 원래대로.
    expect(doc.findPage(0).get('Annots').toString()).toBe(
      annotsBefore.replace(/ \d+ 0 R\]$/, ']'),
    );
  });

  it('임시 분리: 그 페이지 객체가 열려 있으면 실패하고 /Annots 를 되돌린다', () => {
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
