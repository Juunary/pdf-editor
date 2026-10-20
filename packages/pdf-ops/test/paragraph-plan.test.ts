import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { FontManager, planPageEditability, planParagraphEdit } from '../src/index.js';
import type { ParagraphEditContext } from '../src/index.js';
import { findParagraph, loadModules, pageContext } from './helpers/edit-context.js';
import { fallbackFor } from './helpers/edit-driver.js';
import { charsOfText, makeDoc, paragraphOf, withParagraphs } from './helpers/fixtures-m3.js';

/** 계약 5.1 편집 가능 판정(문서를 바꾸지 않는다). */
beforeAll(async () => {
  await loadModules();
});

function plan(ctx: ParagraphEditContext, needle: string) {
  const fm = new FontManager(ctx.doc, fallbackFor(ctx.doc));
  return planParagraphEdit(ctx, fm, findParagraph(ctx, needle).id);
}
const reasons = (p: { limits: { reason: string }[] }) => p.limits.map((l) => l.reason);
const kinds = (p: { warnings: { kind: string }[] }) => p.warnings.map((w) => w.kind);

describe('편집 제한(5.1)', () => {
  it('회전 줄 → vertical-or-rotated', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 0.866 0.5 -0.5 0.866 80 100 Tm (Rotated thirty degrees.) Tj ET',
    ]);
    expect(reasons(plan(pageContext(doc, 0), 'Rotated thirty'))).toContain('vertical-or-rotated');
  });

  it('Tr 4(채움+클립) → clip-text, Tr 3 → invisible-text', () => {
    const doc = makeDoc([
      'BT 4 Tr /F1 12 Tf 50 240 Td (Clipping text paragraph.) Tj ET BT 3 Tr /F1 12 Tf 50 160 Td (Invisible ocr paragraph.) Tj ET',
    ]);
    const ctx = pageContext(doc, 0);
    expect(reasons(plan(ctx, 'Clipping text'))).toContain('clip-text');
    // Tr 3(스캔 OCR 층) 줄은 레이아웃 문단이 되지 않는다. 글자로 문단을 만들어 판정만 본다.
    const ocr = withParagraphs(ctx, [
      paragraphOf(ctx, charsOfText(ctx, 'Invisible ocr paragraph.'), 0),
    ]);
    expect(reasons(planParagraphEdit(ocr, new FontManager(doc, fallbackFor(doc)), 0))).toContain(
      'invisible-text',
    );
  });

  it('Type3 폰트 → type3-font', () => {
    const doc = makeDoc(['BT /T3 12 Tf 50 200 Td (ab) Tj ET'], (src) => {
      const proc = src.addStream('1000 0 0 0 750 750 d1 0 0 750 750 re f', {});
      const t3 = src.addObject({
        Type: 'Font',
        Subtype: 'Type3',
        FontBBox: [0, 0, 750, 750],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { a: proc, b: proc },
        Encoding: { Type: 'Encoding', Differences: [97, 'a', 'b'] },
        FirstChar: 97,
        LastChar: 98,
        Widths: [1000, 1000],
      });
      return { Font: { T3: t3 } };
    });
    const ctx = pageContext(doc, 0);
    const p = ctx.layout.paragraphs[0]!;
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(reasons(planParagraphEdit(ctx, fm, p.id))).toContain('type3-font');
  });

  it('쪽 콘텐츠와 Form 에 걸친 문단 → mixed-content-sources', () => {
    const doc = makeDoc(
      ['BT /F1 12 Tf 50 200 Td (Page line of mixed source) Tj ET q 1 0 0 1 50 186 cm /X0 Do Q'],
      (src, { F1 }) => ({
        XObject: {
          X0: src.addStream('BT /F1 12 Tf 0 0 Td (form line continues it) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, -5, 300, 20],
            Resources: { Font: { F1 } },
          }),
        },
      }),
    );
    const ctx0 = pageContext(doc, 0);
    const chars = [
      ...charsOfText(ctx0, 'Page line of mixed source'),
      ...charsOfText(ctx0, 'form line continues it'),
    ];
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, chars, 0)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(reasons(planParagraphEdit(ctx, fm, 0))).toContain('mixed-content-sources');
  });

  it('제거가 건너뛸 연산 → remove-skipped(code)', () => {
    // Tf 리소스가 없으면 MuPDF 는 대체 폰트로 그린다(글자는 추출되지만 명세 폭을 알 수 없다).
    const doc = makeDoc(['BT /F9 12 Tf 50 200 Td (Missing font resource here.) Tj ET']);
    const p = plan(pageContext(doc, 0), 'Missing font');
    const l = p.limits.find((x) => x.reason === 'remove-skipped')!;
    expect(l.code).toBe('no-font-resource');
    expect(reasons(p)).toContain('font-encoding-unresolved');
    expect(p.editable).toBe(false);
    expect(p.insertion).toBeNull();
  });

  it('ActualText MC 가 다른 문단에도 걸침 → actualtext-partial', () => {
    const doc = makeDoc([
      '/Span <</ActualText (Both paragraphs)>> BDC BT /F1 12 Tf 50 240 Td (Upper paragraph text.) Tj ET ' +
        'BT /F1 12 Tf 50 120 Td (Lower paragraph text.) Tj ET EMC',
    ]);
    const ctx0 = pageContext(doc, 0);
    const up = charsOfText(ctx0, 'Upper paragraph text.');
    const low = charsOfText(ctx0, 'Lower paragraph text.');
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, up, 0), paragraphOf(ctx0, low, 1)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(reasons(planParagraphEdit(ctx, fm, 0))).toContain('actualtext-partial');
  });

  it('BT 나누기 제한: 같은 BT 의 클립 텍스트, BT 안 q/cm', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td 5 Tr (Clip head line.) Tj 0 Tr 0 -60 Td (Target after clip) Tj ET',
      'BT /F1 12 Tf 50 250 Td (Head line kept.) Tj q 0 -60 Td (Target after q) Tj Q ET',
    ]);
    const c0 = pageContext(doc, 0);
    const p0 = planParagraphEdit(
      withParagraphs(c0, [paragraphOf(c0, charsOfText(c0, 'Target after clip'), 0)]),
      new FontManager(doc, fallbackFor(doc)),
      0,
    );
    expect(reasons(p0)).toContain('bt-split-unsupported');
    expect(p0.limits.find((l) => l.reason === 'bt-split-unsupported')!.detail).toMatch(/클립/);
    const c1 = pageContext(doc, 1);
    const p1 = planParagraphEdit(
      withParagraphs(c1, [paragraphOf(c1, charsOfText(c1, 'Target after q'), 0)]),
      new FontManager(doc, fallbackFor(doc)),
      0,
    );
    expect(p1.limits.find((l) => l.reason === 'bt-split-unsupported')!.detail).toMatch(/q\/Q/);
  });

  it('특이 CTM → singular-ctm', () => {
    const doc = makeDoc([
      'q 1 0 0 0.0000000000001 0 100 cm BT /F1 12 Tf 50 0 Td (Singular ctm text) Tj ET Q BT /F1 12 Tf 50 200 Td (Normal text) Tj ET',
    ]);
    expect(reasons(plan(pageContext(doc, 0), 'Singular ctm'))).toContain('singular-ctm');
  });

  it('직사각형이 아닌 클립 → insertion-clipped', () => {
    const doc = makeDoc([
      'q 30 150 m 380 150 l 200 290 l h W n BT /F1 12 Tf 120 200 Td (Triangle clip text.) Tj ET Q',
    ]);
    expect(reasons(plan(pageContext(doc, 0), 'Triangle clip'))).toContain('insertion-clipped');
  });

  it('삽입점의 직사각형 클립이 원 문단 글자를 덮지 않음 → insertion-clipped', () => {
    const doc = makeDoc([
      'q 40 190 20 30 re W n BT /F1 12 Tf 45 200 Td (1.) Tj ET Q BT /F1 12 Tf 62 200 Td (rest of the clipped note.) Tj ET',
    ]);
    const ctx0 = pageContext(doc, 0);
    const chars = [...charsOfText(ctx0, '1.'), ...charsOfText(ctx0, 'rest of the clipped note.')];
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, chars, 0)]);
    const p = planParagraphEdit(ctx, new FontManager(doc, fallbackFor(doc)), 0);
    const l = p.limits.find((x) => x.reason === 'insertion-clipped')!;
    expect(l.detail).toMatch(/직사각형 클립/);
    expect(l.chars.length).toBeGreaterThan(10);
  });

  it('패턴 채움·SMask 차이 → graphics-state-mismatch', () => {
    const doc = makeDoc(
      [
        '/Pattern cs /P0 scn BT /F1 24 Tf 50 240 Td (Patterned) Tj ET 0 g ' +
          'BT /GSM gs /F1 24 Tf 50 120 Td (Masked text) Tj ET',
      ],
      (src) => {
        const tile = src.addStream('0 0 1 rg 0 0 5 5 re f', {
          Type: 'Pattern',
          PatternType: 1,
          PaintType: 1,
          TilingType: 1,
          BBox: [0, 0, 10, 10],
          XStep: 10,
          YStep: 10,
          Resources: {},
        });
        const mask = src.addStream('1 g 0 0 400 300 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 300],
          Group: { S: 'Transparency', CS: 'DeviceGray' },
        });
        return {
          Pattern: { P0: tile },
          ExtGState: {
            GSM: src.addObject({
              Type: 'ExtGState',
              SMask: { Type: 'Mask', S: 'Luminosity', G: mask },
            }),
          },
        };
      },
    );
    const ctx = pageContext(doc, 0);
    expect(reasons(plan(ctx, 'Patterned'))).toContain('graphics-state-mismatch');
    expect(reasons(plan(ctx, 'Masked text'))).toContain('graphics-state-mismatch');
  });

  it('표 셀·도형 라벨 문단 → not-flow-paragraph', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Cell text) Tj ET']);
    const ctx0 = pageContext(doc, 0);
    const para = { ...ctx0.layout.paragraphs[0]!, table: 0 };
    const ctx = withParagraphs(ctx0, [para]);
    expect(
      reasons(planParagraphEdit(ctx, new FontManager(doc, fallbackFor(doc)), para.id)),
    ).toContain('not-flow-paragraph');
  });
});

describe('경고(5.1)', () => {
  it('링크·Redact 표시와 겹침, 선택적 콘텐츠', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    const ocg = src.addObject({ Type: 'OCG', Name: 'Layer' });
    const page = src.addPage(
      [0, 0, 400, 300],
      0,
      { Font: { F1 }, Properties: { OC0: ocg } },
      'BT /F1 12 Tf 50 200 Td (Linked redacted text.) Tj ET /OC /OC0 BDC BT /F1 12 Tf 50 120 Td (Layered text here.) Tj ET EMC',
    );
    const link = src.newDictionary();
    link.put('Type', src.newName('Annot'));
    link.put('Subtype', src.newName('Link'));
    link.put('Rect', src.newArray());
    for (const v of [45, 195, 150, 215]) link.get('Rect').push(v);
    const action = src.newDictionary();
    action.put('S', src.newName('URI'));
    action.put('URI', src.newString('https://example.com/'));
    link.put('A', action);
    page.put('Annots', [
      src.addObject(link),
      src.addObject({ Type: 'Annot', Subtype: 'Redact', Rect: [100, 195, 200, 215] }),
    ]);
    src.insertPage(-1, page);
    src
      .getTrailer()
      .get('Root')
      .put('OCProperties', { OCGs: [ocg], D: { ON: [ocg] } });
    const doc = mupdf.Document.openDocument(
      src.saveToBuffer('').asUint8Array().slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    const ctx = pageContext(doc, 0);
    const w1 = kinds(plan(ctx, 'Linked redacted'));
    expect(w1).toEqual(expect.arrayContaining(['link-overlap', 'redact-overlap']));
    const p2 = plan(ctx, 'Layered text');
    expect(kinds(p2)).toContain('optional-content');
    expect(p2.editable).toBe(true);
  });
});

describe('시작 상태(5.3)', () => {
  it('텍스트·charIndexOfOffset(합성 공백 -1)·모양 구간·형식', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 14 TL 50 250 Td [(Mixed) -300 (gap)] TJ ( and ) Tj /F2 12 Tf (times) Tj T* /F1 12 Tf (second line.) Tj ET',
    ]);
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Mixed');
    const fm = new FontManager(doc, fallbackFor(doc));
    const pl = planParagraphEdit(ctx, fm, p.id);
    const text = pl.runs.map((r) => r.text).join('');
    expect(text).toBe(p.text);
    expect(pl.charIndexOfOffset).toHaveLength(text.length);
    // TJ 간격으로 만든 합성 공백은 -1, 그 밖은 글자 인덱스.
    const gap = text.indexOf('gap');
    expect(pl.charIndexOfOffset[gap - 1]).toBe(-1);
    expect(ctx.model.chars[pl.charIndexOfOffset[gap]!]!.text).toBe('g');
    expect(pl.runs.length).toBeGreaterThanOrEqual(2);
    expect(pl.runs.map((r) => r.style.fontId)).toContain(
      ctx.model.chars[pl.charIndexOfOffset[text.indexOf('times')]!]!.fontId,
    );
    expect(pl.format.lineHeight).toBeCloseTo(14, 1);
    expect(pl.format.firstBaselineOffset).toBeCloseTo(
      ctx.model.chars[pl.charIndexOfOffset[0]!]!.origin[1] - p.bbox[1],
      3,
    );
    expect(pl.format.overflow).toBeNull();
  });
});

describe('판정은 문서를 바꾸지 않는다·판정 시간', () => {
  it('저널을 켠 문서에서 작업 밖 판정이 예외 없이 끝난다, 쪽 하나 100 ms·문단 하나 10 ms 이하(서버 Node)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) {
      lines.push(
        `BT /F1 9 Tf 11 TL 40 ${780 - i * 50} Td (Paragraph number ${i} has some words) Tj T* (and a second line ${i}.) Tj ET`,
      );
    }
    const doc = makeDoc([{ content: lines.join('\n'), mediabox: [0, 0, 400, 800] }]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    // core 와 같이 폴백 폰트·Info 는 저널을 켜기 전에 만든다(계약 D4·D9 수정 1).
    doc.enableJournal();
    planPageEditability(ctx, fm); // 첫 호출(폰트 캐시 준비)
    const t0 = performance.now();
    const pe = planPageEditability(ctx, fm);
    const pageMs = performance.now() - t0;
    const times: number[] = [];
    for (const p of ctx.layout.paragraphs) times.push(planParagraphEdit(ctx, fm, p.id).planMs);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    expect(pe.paragraphs.length).toBeGreaterThanOrEqual(15);
    expect(pe.paragraphs.every((p) => p.editable)).toBe(true);
    expect(doc.canUndo()).toBe(false);
    console.log(
      `판정 시간: 쪽 ${pageMs.toFixed(2)} ms(${pe.paragraphs.length}문단), 문단 평균 ${avg.toFixed(2)} ms·최대 ${Math.max(...times).toFixed(2)} ms`,
    );
    expect(pageMs).toBeLessThan(100);
    expect(Math.max(...times)).toBeLessThan(10);
  });
});
