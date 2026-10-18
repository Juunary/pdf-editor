import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import { buildSourceMap, linkPage, listXObjectUsages } from '../src/index.js';
import { buildSourceMapImpl } from '../src/content-interp.js';
import { buildTestPageModel, type HelperPolicy } from './helpers/page-model.js';
import { deliveryTrace } from './helpers/device-log.js';

/**
 * buildSourceMap·linkPage 합성 PDF 테스트. 기대값의 기준은 MuPDF Device 콜백(테스트 전용 PageModel)이다.
 * 매칭 기준: 총수 차이 0, 글자·도형 전부 매칭, 원점 오차 0.01pt 이하.
 */

interface Built {
  doc: mupdf.PDFDocument;
}

type Res = Record<string, unknown>;

/** 1쪽 문서. content 가 배열이면 /Contents 배열. 꺼진 OCG /OC1, Helvetica /F1 을 둔다. */
function build(
  content: string | string[],
  resources?: (doc: mupdf.PDFDocument, ctx: { F1: mupdf.PDFObject; ocg: mupdf.PDFObject }) => Res,
): Built {
  const doc = new mupdf.PDFDocument();
  const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  const ocg = doc.addObject({ Type: 'OCG', Name: 'Hidden' });
  const ocp = doc.newDictionary();
  const ocgs = doc.newArray();
  ocgs.push(ocg);
  ocp.put('OCGs', ocgs);
  const d = doc.newDictionary();
  const off = doc.newArray();
  off.push(ocg);
  d.put('OFF', off);
  ocp.put('D', d);
  doc.getTrailer().get('Root').put('OCProperties', ocp);
  const res = { Font: { F1 }, Properties: { OC1: ocg }, ...resources?.(doc, { F1, ocg }) };
  const list = Array.isArray(content) ? content : [content];
  const pageObj = doc.addPage([0, 0, 612, 792], 0, res, list[0]!);
  if (list.length > 1) {
    const arr = doc.newArray();
    for (const c of list) arr.push(doc.addStream(c, {}));
    pageObj.put('Contents', arr);
  }
  doc.insertPage(-1, pageObj);
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  return { doc: mupdf.Document.openDocument(saved, 'application/pdf') as mupdf.PDFDocument };
}

function match(b: Built, policy: HelperPolicy = 'first-arrival') {
  const model = buildTestPageModel(b.doc, 0, policy);
  const map =
    policy === 'no-clip' ? buildSourceMapImpl(b.doc, 0, 8, 'no-clip') : buildSourceMap(b.doc, 0);
  const link = linkPage(model, map);
  return { model, map, link };
}

function expectFull(r: { map: SourceMap; link: PageLinkage }) {
  const s = r.link.stats;
  expect({
    glyphDelta: s.glyphCountDelta,
    paintDelta: s.paintCountDelta,
    unmatchedChars: s.chars - s.matchedChars,
    unmatchedPaints: s.paints - s.matchedPaints,
    errors: r.map.errors.length,
  }).toEqual({ glyphDelta: 0, paintDelta: 0, unmatchedChars: 0, unmatchedPaints: 0, errors: 0 });
  expect(s.maxOriginError).toBeLessThan(0.01);
}

/**
 * 소유 연산이 없는 번호(패턴 셀 내용, no-clip 정책의 재전송 중복)는 매칭 대상이 아니다.
 * 총수 차이 0 과, 소유 번호를 가진 글자·도형이 전부 매칭됐는지 본다.
 */
function expectOwned(r: { map: SourceMap; link: PageLinkage; model: PageModel }) {
  const owned = new Set<number>();
  const ownedPaint = new Set<number>();
  for (const op of r.map.ops) {
    op.text?.glyphs.forEach((g) => g.seq !== null && owned.add(g.seq));
    op.paintSeq?.forEach((s) => ownedPaint.add(s));
  }
  const s = r.link.stats;
  const ownedChars = r.model.chars.filter((c) => owned.has(c.glyphSeq)).length;
  const ownedPaints = [...r.model.paths, ...r.model.images, ...r.model.shades].filter((p) =>
    ownedPaint.has(p.paintSeq),
  ).length;
  expect({
    glyphDelta: s.glyphCountDelta,
    paintDelta: s.paintCountDelta,
    matchedChars: s.matchedChars,
    matchedPaints: s.matchedPaints,
  }).toEqual({
    glyphDelta: 0,
    paintDelta: 0,
    matchedChars: ownedChars,
    matchedPaints: ownedPaints,
  });
  return { unownedChars: s.chars - ownedChars, unownedPaints: s.paints - ownedPaints };
}

const textOps = (map: SourceMap) => map.ops.filter((o) => o.kind === 'text-show');
const bt = (body: string) => `BT /F1 12 Tf 50 700 Td ${body} ET 0 Tr`;
const shading = {
  ShadingType: 2,
  ColorSpace: 'DeviceRGB',
  Coords: [0, 0, 100, 0],
  Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
};
const rgbImage = (doc: mupdf.PDFDocument) =>
  doc.addImage(new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)));

describe('buildSourceMap: 스트림·바이트 범위', () => {
  it('/Contents 배열 3개, 스트림 경계에 걸친 연산(피연산자·문자열)', () => {
    const b = build(['BT /F1 12 Tf 50', '700 Td (A', ') Tj ET 0 0 5 5 re f']);
    const r = match(b);
    expectFull(r);
    expect(r.map.streams.map((s) => s.contentsIndex)).toEqual([0, 1, 2]);
    const td = r.map.ops.find((o) => o.op === 'Td')!;
    expect(td.stream.contentsIndex).toBe(0);
    expect(td.limits).toContain('spans-stream-boundary');
    const tj = r.map.ops.find((o) => o.op === 'Tj')!;
    expect(tj.limits).toContain('spans-stream-boundary');
    // MuPDF 는 스트림을 공백으로 잇는다: 문자열 안 경계 바이트가 글리프(코드 32)가 된다.
    expect(tj.text!.glyphs.map((g) => g.code)).toEqual([65, 32]);
    const f = r.map.ops.find((o) => o.op === 'f')!;
    expect(f.stream.contentsIndex).toBe(2);
    expect(f.limits).not.toContain('spans-stream-boundary');
  });

  it('연산 범위·글리프 바이트 범위(리터럴 이스케이프·16진)', () => {
    const content = 'BT /F1 12 Tf 50 700 Td (a\\(b\\101) Tj <41 42> Tj ET';
    const r = match(build(content));
    expectFull(r);
    const [lit, hex] = textOps(r.map);
    expect(content.slice(lit!.range[0], lit!.range[1])).toBe('(a\\(b\\101) Tj');
    expect(lit!.text!.glyphs.map((g) => content.slice(g.byteRange[0], g.byteRange[1]))).toEqual([
      'a',
      '\\(',
      'b',
      '\\101',
    ]);
    expect(hex!.text!.glyphs.map((g) => content.slice(g.byteRange[0], g.byteRange[1]))).toEqual([
      '41',
      '42',
    ]);
  });
});

describe('Form XObject 재귀', () => {
  const formDoc = () =>
    build('q 1 0 0 1 50 400 cm /Fx1 Do Q /Fx3 Do', (doc, { F1 }) => {
      const fx2 = doc.addStream(`${bt('(N2) Tj')} 0 0 10 10 re f`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 100],
        Resources: { Font: { F1 } },
      });
      const fx1 = doc.addStream(`${bt('(F1a) Tj')} q 1 0 0 1 30 0 cm /Fx2 Do Q ${bt('(F1b) Tj')}`, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 200, 100],
        Matrix: [2, 0, 0, 2, 0, 0],
        Resources: { Font: { F1 }, XObject: { Fx2: fx2 } },
      });
      // 자체 /Resources 없는 Form(L1): 페이지 리소스의 /F1 을 쓴다.
      const fx3 = doc.addStream(bt('(L1) Tj'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 300],
      });
      return { XObject: { Fx1: fx1, Fx3: fx3 } };
    });

  it('중첩 Form 의 실행 순서·formPath·ctm 이 xobject.ts 사용 위치 색인과 일치', () => {
    const b = formDoc();
    const r = match(b);
    expectFull(r);
    const dos = r.map.ops.filter((o) => o.op === 'Do');
    const usages = listXObjectUsages(b.doc, 0);
    expect(dos.length).toBe(usages.length);
    dos.forEach((d, i) => {
      const u = usages[i]!;
      const inner = r.map.ops[d.id + 1]!;
      const path = inner.formPath;
      expect(path.map((s) => [s.resourceName, s.doOrdinal])).toEqual(
        u.path.map((s) => [s.resourceName, s.doOrdinal]),
      );
      expect(path.at(-1)!.objectNumber).toBe(u.objectNumber);
      expect(path.at(-1)!.ctm).toEqual(u.path.at(-1)!.ctm);
      expect(path.at(-1)!.nameRange).toEqual(u.path.at(-1)!.nameRange);
      // Do 는 BBox clipPath 1개를 소유한다.
      expect(d.paintSeq?.length).toBe(1);
    });
    const l1 = textOps(r.map).find(
      (o) => o.text!.glyphs.length === 2 && o.formPath[0]?.resourceName === 'Fx3',
    )!;
    expect(l1.limits).toContain('form-inherits-resources');
    expect(r.map.streams.filter((s) => s.contentsIndex === null).length).toBe(3);
  });

  it('깊이 상한·순환은 form-depth-exceeded', () => {
    const b = formDoc();
    const map = buildSourceMap(b.doc, 0, { maxFormDepth: 2 });
    const deep = map.ops.filter((o) => o.limits.includes('form-depth-exceeded'));
    expect(deep.map((o) => o.formPath.map((s) => s.resourceName))).toEqual([['Fx1']]);
    const cyc = build('/Fa Do', (doc) => {
      const fa = doc.addStream('/Fa Do 0 0 1 1 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 9, 9],
      });
      const res = doc.newDictionary();
      const xo = doc.newDictionary();
      xo.put('Fa', fa);
      res.put('XObject', xo);
      fa.put('Resources', res);
      return { XObject: { Fa: fa } };
    });
    const rc = match(cyc);
    expectFull(rc);
    expect(rc.map.ops.some((o) => o.limits.includes('form-depth-exceeded'))).toBe(true);
  });
});

describe('텍스트 상태와 글리프 원점', () => {
  it('Tm·Td·TD·T*·TL·Tc·Tw·Tz·Ts·TJ 조정·\'·" ', () => {
    const r = match(
      build(
        'BT /F1 11 Tf 0.9 0.2 -0.2 0.9 40 600 Tm 1.5 Tc 4 Tw 85 Tz 3 Ts (a b  c) Tj 0 -14 TD (d e) Tj T* [(F) -250 (g) 120.5 ( h)] TJ 16 TL (i j) \' 2 0.5 (k l) " ET',
      ),
    );
    expectFull(r);
  });

  it('회전·확대 CTM 과 페이지 /Rotate', () => {
    const doc = new mupdf.PDFDocument();
    const F1 = doc.addSimpleFont(new mupdf.Font('Times-Roman'));
    const page = doc.addPage(
      [0, 0, 500, 700],
      90,
      { Font: { F1 } },
      'q 0.8 0.6 -0.6 0.8 200 100 cm BT /F1 20 Tf 10 10 Td (Rot) Tj ET Q',
    );
    doc.insertPage(-1, page);
    const r = match({
      doc: mupdf.Document.openDocument(
        doc.saveToBuffer('').asUint8Array().slice(),
        'application/pdf',
      ) as mupdf.PDFDocument,
    });
    expectFull(r);
  });

  it('Type0 Identity-H(addFont)·폭 정보 없는 표준 14 폰트', () => {
    const r = match(
      build(
        'BT /F2 14 Tf 50 650 Td <002400250026> Tj ET BT /F3 13 Tf 50 600 Td (Std14 \\(no Widths\\) Wy) Tj ET',
        (doc) => ({
          Font: {
            F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
            F2: doc.addFont(new mupdf.Font('Helvetica')),
            F3: doc.addObject({
              Type: 'Font',
              Subtype: 'Type1',
              BaseFont: 'Helvetica',
              Encoding: 'WinAnsiEncoding',
            }),
          },
        }),
      ),
    );
    expectFull(r);
  });

  it('세로쓰기 Identity-V(/W2·DW2 기본값)', () => {
    const r = match(
      build('BT /V 16 Tf 300 700 Td 2 Tc <00240025> Tj [<0026> -300 <0027>] TJ ET', (doc) => {
        const V = doc.addFont(new mupdf.Font('Helvetica'));
        V.put('Encoding', doc.newName('Identity-V'));
        const desc = V.get('DescendantFonts').get(0);
        const w2 = doc.newArray();
        for (const v of [36, [-900, 300, 880]]) {
          if (Array.isArray(v)) {
            const inner = doc.newArray();
            for (const x of v) inner.push(x);
            w2.push(inner);
          } else w2.push(v);
        }
        desc.put('W2', w2);
        return { Font: { F1: doc.addSimpleFont(new mupdf.Font('Helvetica')), V } };
      }),
    );
    expectFull(r);
  });

  it('CID 매핑을 모르는 미리 정의된 CMap: 원점이 어긋나도 번호 연속으로 매칭(font-encoding-unresolved)', () => {
    const r = match(
      build('BT /K 12 Tf 50 700 Td <0041004200430044> Tj ET', (doc) => {
        const K = doc.addFont(new mupdf.Font('Helvetica'));
        K.put('Encoding', doc.newName('UniKS-UCS2-H'));
        return { Font: { F1: doc.addSimpleFont(new mupdf.Font('Helvetica')), K } };
      }),
    );
    const tj = textOps(r.map)[0]!;
    expect(tj.limits).toContain('font-encoding-unresolved');
    expect(r.link.stats.glyphCountDelta).toBe(0);
    expect(r.link.stats.matchedChars).toBe(r.link.stats.chars);
  });

  it('Type3 폰트(/FontMatrix 비기본), Tr 1·7 은 MuPDF 규칙대로 fill·ignore', () => {
    const r = match(
      build('BT /T 20 Tf 50 700 Td (AB) Tj 1 Tr (A) Tj 7 Tr (B) Tj 0 Tr ET', (doc) => ({
        Font: {
          T: doc.addObject({
            Type: 'Font',
            Subtype: 'Type3',
            FontBBox: [0, 0, 100, 100],
            FontMatrix: [0.01, 0, 0, 0.01, 0, 0],
            CharProcs: {
              a: doc.addStream('60 0 0 0 50 50 d1 0 0 50 50 re f', {}),
              b: doc.addStream('70.5 0 0 0 50 50 d1 0 0 25 50 re f', {}),
            },
            Encoding: { Type: 'Encoding', Differences: [65, 'a', 'b'] },
            FirstChar: 65,
            LastChar: 66,
            Widths: [60, 70.5],
            Resources: {},
          }),
        },
      })),
    );
    expectFull(r);
    expect(textOps(r.map)[0]!.limits).toContain('type3-font');
  });
});

describe('텍스트 렌더 방식(Tr 0–7)과 ET 재전송', () => {
  const cases = [
    '(A) Tj 1 Tr (B) Tj 2 Tr (C) Tj 3 Tr (D) Tj',
    '4 Tr (Ab) Tj (Cd) Tj',
    '5 Tr (Ab) Tj',
    '6 Tr (Ab) Tj',
    '7 Tr (Ab) Tj',
    '7 Tr (A) Tj 4 Tr (B) Tj',
    '7 Tr (A) Tj 0 Tr (B) Tj 5 Tr (C) Tj',
    '4 Tr (Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj',
    '7 Tr (A) Tj 0 Tr (B) Tj',
    '4 Tr (A) Tj 1 Tr (B) Tj',
    '7 Tr (A) Tj 2 Tr (B) Tj',
    '7 Tr (A) Tj 0 Tr',
    '7 Tr (A) Tj 1 0 0 rg (B) Tj',
    '8 Tr (A) Tj 12 Tr (B) Tj 7 Tr (C) Tj',
  ];
  for (const c of cases) {
    it(`first-arrival: ${c}`, () => expectFull(match(build(bt(c)))));
  }
  // no-clip(core 안 A): ET ignore 재전송 중복은 소유 없는 번호가 된다(그 글자는 매칭되지 않음).
  for (const c of cases) {
    it(`no-clip: ${c}`, () => void expectOwned(match(build(bt(c)), 'no-clip')));
  }
  it('no-clip: ignore 재전송 중복 글자 수', () => {
    const r = match(build(bt(cases[7]!)), 'no-clip');
    expect(expectOwned(r).unownedChars).toBe(2);
  });

  it('first-arrival: Tr 7 글리프는 ET 시점 번호, Device 에 안 오는 글리프는 null', () => {
    const r = match(build(bt('7 Tr (A) Tj 0 Tr (B) Tj 7 Tr (C) Tj 0 Tr')));
    const seq = textOps(r.map).map((o) => o.text!.glyphs.map((g) => g.seq));
    // B 표시(0) 뒤 ET 재전송 없음(마지막 글리프 Tr 7 → clip AC: 1, 2).
    expect(seq).toEqual([[1], [0], [2]]);
    expect(textOps(r.map)[0]!.limits).toContain('clip-text');
  });

  it('Form 안 텍스트가 페이지 BT 의 실행 단위·클립 누적에 합쳐진다', () => {
    const r = match(
      build('BT /F1 12 Tf 50 700 Td 7 Tr (A) Tj /Fx Do (B) Tj ET 0 Tr', (doc, { F1 }) => ({
        XObject: {
          Fx: doc.addStream('BT /F1 12 Tf (X) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 100],
            Resources: { Font: { F1 } },
          }),
        },
      })),
    );
    expectFull(r);
  });
});

describe('선택적 콘텐츠·marked content', () => {
  it('꺼진 /OC: Tr 0–2·경로·이미지·셰이드는 없음, 클립·Tr 3·ET 재전송은 계수', () => {
    const r = match(
      build(
        [
          '/OC /OC1 BDC BT /F1 12 Tf 50 600 Td (H0) Tj 1 Tr (H1) Tj 2 Tr (H2) Tj 3 Tr (H3) Tj 4 Tr (H4) Tj 7 Tr (H7) Tj 3 Tr (Hz) Tj 0 Tr ET',
          '10 10 20 20 re f q 10 10 30 30 re W n Q q 50 0 0 50 0 0 cm /Im Do Q /Sh sh /Fx Do EMC',
          '/FxH Do BT /F1 12 Tf 50 500 Td (V) Tj ET',
        ],
        (doc, { ocg }) => ({
          XObject: {
            Im: rgbImage(doc),
            Fx: doc.addStream('0 0 10 10 re f 0 0 5 5 re W n', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 100, 100],
            }),
            FxH: doc.addStream('0 0 10 10 re W n 0 0 10 10 re f', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 100, 100],
              OC: ocg,
            }),
          },
          Shading: { Sh: shading },
        }),
      ),
    );
    expectFull(r);
    const t = textOps(r.map);
    expect(t[0]!.text!.glyphs.every((g) => g.seq === null)).toBe(true);
    expect(t[3]!.text!.glyphs.every((g) => g.seq !== null)).toBe(true);
    expect(t[0]!.optionalContent).toBe(true);
    expect(t[0]!.limits).toContain('optional-content');
    expect(t.at(-1)!.optionalContent).toBe(false);
  });

  it('BT 안의 꺼진 BDC: marked content 경계에서 실행 단위가 나뉜다', () => {
    expectFull(match(build(bt('(A) Tj /OC /OC1 BDC (B) Tj EMC (C) Tj'))));
    expectFull(match(build(bt('/OC /OC1 BDC (A) Tj 1 0 0 rg EMC (B) Tj'))));
  });

  it('OCMD(AnyOn·AllOff)·켜진 OCG', () => {
    const r = match(
      build(
        '/OC /M1 BDC (a) Tj EMC /OC /M2 BDC (b) Tj EMC /OC /On BDC (c) Tj EMC'.replace(
          /\((\w)\) Tj/g,
          'BT /F1 9 Tf 9 9 Td ($1) Tj ET',
        ),
        (doc, { ocg }) => {
          const on = doc.addObject({ Type: 'OCG', Name: 'On' });
          return {
            Properties: {
              OC1: ocg,
              On: on,
              M1: { Type: 'OCMD', OCGs: [ocg], P: 'AnyOn' },
              M2: { Type: 'OCMD', OCGs: [ocg], P: 'AllOff' },
            },
          };
        },
      ),
    );
    expectFull(r);
  });

  it('MCID 와 tagged-content', () => {
    const r = match(
      build(
        '/P <</MCID 3>> BDC /Span <</MCID 4>> BDC BT /F1 9 Tf (x) Tj ET EMC EMC BT /F1 9 Tf (y) Tj ET',
      ),
    );
    expectFull(r);
    const [x, y] = textOps(r.map);
    expect(x!.mcids).toEqual([3, 4]);
    expect(x!.limits).toContain('tagged-content');
    expect(y!.mcids).toEqual([]);
  });
});

describe('도형·이미지·패턴', () => {
  it('W 클립·빈 경로·B 계열', () => {
    const r = match(
      build(
        '0 0 9 9 re W f 0 0 9 9 re W* S 0 0 9 9 re W n 0 0 9 9 re W B f 50 50 m S 0 0 9 9 re b*',
      ),
    );
    expectFull(r);
    const w = r.map.ops.filter((o) => o.op === 'W' || o.op === 'W*');
    expect(w.every((o) => o.paintSeq?.length === 1)).toBe(true);
    expect(r.map.ops.filter((o) => o.op === 'n')[0]!.clipDepth).toBe(2);
  });

  it('인라인 이미지(데이터 안 EI·마스크)·이미지 XObject(/SMask 는 2개)', () => {
    const r = match(
      build(
        'q 9 0 0 9 0 0 cm BI /W 2 /H 1 /CS /G /BPC 8 ID EI EI Q q 9 0 0 9 20 0 cm BI /IM true /W 8 /H 1 ID \x80 EI Q q 9 0 0 9 40 0 cm /I1 Do Q q 9 0 0 9 60 0 cm /I2 Do Q',
        (doc) => {
          const smask = doc.addStream('\xff\x80\x00\x40', {
            Type: 'XObject',
            Subtype: 'Image',
            Width: 2,
            Height: 2,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
          });
          return {
            XObject: {
              I1: rgbImage(doc),
              I2: doc.addStream('\xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\xff', {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 2,
                Height: 2,
                ColorSpace: 'DeviceRGB',
                BitsPerComponent: 8,
                SMask: smask,
              }),
            },
          };
        },
      ),
    );
    expectFull(r);
    const bi = r.map.ops.filter((o) => o.op === 'BI');
    expect(bi.length).toBe(2);
    expect(bi[0]!.limits).toContain('inline-image');
    expect(r.map.ops.filter((o) => o.op === 'Do').map((o) => o.paintSeq?.length)).toEqual([1, 2]);
  });

  it('셰이딩 패턴: 칠하기·선·텍스트(Tr 0·2, 채움 패턴 + 선 색)', () => {
    const r = match(
      build(
        '/Pattern cs /SP scn /Pattern CS /SP SCN 10 10 50 50 re f 100 10 50 50 re S 200 10 50 50 re B BT /F1 20 Tf 50 700 Td (Ab) Tj 2 Tr (Cd) Tj ET 0 Tr 0 G BT /F1 20 Tf 50 650 Td 2 Tr (Gh) Tj ET 0 Tr',
        (doc) => ({
          Pattern: { SP: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
        }),
      ),
    );
    expectFull(r);
  });

  it('패턴 색 Tr 6: 같은 객체 clipStrokeText 는 1단계로 건너뛴다(계약 수정 6, 수정 2 규칙의 불일치 회귀)', () => {
    const b = build(
      '/Pattern cs /SP scn /Pattern CS /SP SCN BT /F1 20 Tf 50 700 Td 6 Tr (Ef) Tj ET 0 Tr ' +
        '0 g /Pattern CS /SP SCN BT /F1 20 Tf 50 650 Td 6 Tr (Gh) Tj ET 0 Tr',
      (doc) => ({
        Pattern: { SP: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
      }),
    );
    const trace: string[] = [];
    const map = buildSourceMapImpl(b.doc, 0, 8, 'first-arrival', trace);
    expect(trace.map((t) => t.replace(/:[NR]+$/, ''))).toEqual(deliveryTrace(b.doc.loadPage(0)));
    // (Ef) 채움·선 모두 패턴, (Gh) 채움 색·선 패턴. 표시 글리프 4개.
    expect(trace).toEqual([
      'clip:2:NN',
      'P',
      'clip-stroke:2:RR',
      'P',
      'clip:2:RR',
      'fill:2:NN',
      'clip-stroke:2:RR',
      'P',
      'clip:2:RR',
    ]);
    expect(map.glyphCount).toBe(4);
    // 수정 6 판정은 일치한다.
    expectFull(match(b));
    // 수정 2 의 1단계(fill·stroke 만 건너뜀)는 같은 객체 clipStrokeText 가 항목을 소비·비워 ET 재전송 2+2개를 새로 셌다.
    expect(buildTestPageModel(b.doc, 0, 'first-arrival-v2').glyphCount).toBe(8);
  });

  it('타일링 패턴: 직접 실행(작은 영역, 셀 글리프 포함)과 beginTile 경로(큰 영역)', () => {
    const r = match(
      build(
        '/Pattern cs /TP scn 0 0 10 10 re f 100 100 9 9 re f 200 200 50 50 re f 0 g /Pattern CS /TP SCN 2 w 300 300 5 5 re S',
        (doc, { F1 }) => ({
          Pattern: {
            TP: doc.addStream('0 0 5 5 re f BT /F1 4 Tf (x) Tj ET', {
              Type: 'Pattern',
              PatternType: 1,
              PaintType: 1,
              TilingType: 1,
              BBox: [0, 0, 10, 10],
              XStep: 10,
              YStep: 10,
              Resources: { Font: { F1 } },
            }),
          },
        }),
      ),
    );
    // 직접 실행 셀(10×10 → 1, 9×9 → 1, 선 5×5 → 4 타일): 셀 fillPath 는 패턴 칠하기 연산이 소유하고
    // outside-page-content 를 단다(계약 3절). 셀 글리프는 소유 연산 없이 번호만 소비한다.
    expect(expectOwned(r)).toEqual({ unownedChars: 6, unownedPaints: 0 });
    const painted = r.map.ops.filter((o) => o.op === 'f' || o.op === 'S');
    expect(painted.map((o) => o.paintSeq?.length)).toEqual([2, 2, 1, 5]);
    expect(painted.map((o) => o.limits.includes('outside-page-content'))).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(r.map.errors).toEqual([]);
  });

  it('타일링 패턴: 선 패턴 셀 안에서 채움 패턴이 남아 셀이 다시 실행된다(색 있는 패턴은 칠하는 쪽만 해제)', () => {
    const r = match(
      build('/Pattern cs /TP scn /Pattern CS /TP SCN 300 300 1 1 re S 400 400 1 1 re B', (doc) => ({
        Pattern: {
          TP: doc.addStream('0 0 5 5 re f', {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 10, 10],
            XStep: 10,
            YStep: 10,
          }),
        },
      })),
    );
    // S: clipStroke 1 + 4타일 × (clip + 중첩 셀 fill) = 9, B: clip + 4 fill + clipStroke + 8 = 14.
    expect(r.model.paintCount).toBe(23);
    expectOwned(r);
  });

  it('SMask: 마스크 구간 콜백은 세지 않는다', () => {
    const r = match(
      build(
        'q /S1 gs BT /F1 12 Tf 50 700 Td (A) Tj ET 10 10 50 50 re f /Fx Do /Sh sh Q 0 0 1 1 re f',
        (doc) => {
          const g = doc.addStream('0.5 g 0 0 300 300 re f BT /F1 9 Tf (m) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 612, 792],
            Group: { S: 'Transparency', CS: 'DeviceGray' },
          });
          return {
            ExtGState: { S1: { SMask: { Type: 'Mask', S: 'Luminosity', G: g } } },
            XObject: {
              Fx: doc.addStream('0 0 1 1 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [0, 0, 100, 100],
              }),
            },
            Shading: { Sh: shading },
          };
        },
      ),
    );
    expectFull(r);
  });
});

describe('오류·제한', () => {
  it('Tf 리소스 누락: MuPDF 는 hail-mary 글꼴로 그린다(번호·원점 일치, font-encoding-unresolved)', () => {
    const r = match(build('BT /Missing 12 Tf 50 700 Td (AB c) Tj ET BT 50 650 Td (no font) Tj ET'));
    expectFull(r);
    const [missing, noFont] = textOps(r.map);
    expect(missing!.limits).toContain('font-encoding-unresolved');
    expect(missing!.text!.glyphs.every((g) => g.seq !== null)).toBe(true);
    // 첫 BT 의 Tf 가 gstate 에 남으므로 두 번째도 hail-mary 로 그린다.
    expect(noFont!.text!.glyphs.every((g) => g.seq !== null)).toBe(true);
  });

  it('Tf 전 텍스트는 그리지 않는다', () => {
    const r = match(build('BT 50 650 Td (no font) Tj ET'));
    expectFull(r);
    expect(textOps(r.map)[0]!.text!.glyphs).toEqual([]);
  });

  it('토크나이저 오류: 그 전 연산만 기록, tokenizer-error', () => {
    const map = buildSourceMap(build('0 0 9 9 re f BT /F1 9 Tf (open Tj ET').doc, 0);
    expect(map.errors.length).toBe(1);
    expect(map.ops.map((o) => o.op)).toEqual(['re', 'f', 'BT', 'Tf']);
    expect(map.ops.every((o) => o.limits.includes('tokenizer-error'))).toBe(true);
  });
});

describe('linkPage 재동기화', () => {
  it('번호가 어긋난 구간을 원점으로 재동기화하고 실패는 -1·unmatched', () => {
    const b = build(`${bt('(Hello world) Tj')} ${bt('0 -20 Td (Second line) Tj')}`);
    const model = buildTestPageModel(b.doc, 0);
    const map = buildSourceMap(b.doc, 0);
    // 모델에 없는 글자 1개를 끼워 넣어 이후 번호를 1씩 민다.
    const extra = { ...model.chars[3]!, origin: [500, 500] as [number, number] };
    const chars = [...model.chars.slice(0, 4), extra, ...model.chars.slice(4)].map((c, i) => ({
      ...c,
      glyphSeq: i,
    }));
    const link = linkPage({ ...model, chars, glyphCount: chars.length }, map);
    expect(link.charOp[4]).toBe(-1);
    expect(link.stats.matchedChars).toBe(chars.length - 1);
    expect(link.stats.glyphCountDelta).toBe(1);
    expect(link.charGlyph[5]).toBe(4);
  });

  it('원점 오차가 허용치를 넘으면 매칭하지 않는다', () => {
    const b = build(bt('(abc) Tj'));
    const model = buildTestPageModel(b.doc, 0);
    const map = buildSourceMap(b.doc, 0);
    const chars = model.chars.map((c) => ({
      ...c,
      origin: [c.origin[0] + 2, c.origin[1]] as [number, number],
    }));
    const link = linkPage({ ...model, chars }, map);
    expect(link.stats.matchedChars).toBe(0);
    expect(map.ops.find((o) => o.op === 'Tj')!.limits).toContain('unmatched');
    const loose = linkPage({ ...model, chars }, buildSourceMap(b.doc, 0), { originTolerance: 3 });
    expect(loose.stats.matchedChars).toBe(3);
  });
});
