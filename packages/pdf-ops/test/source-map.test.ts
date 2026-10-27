import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import { buildSourceMap, linkPage, listXObjectUsages } from '../src/index.js';
import { buildSourceMapImpl } from '../src/content-interp.js';
import { buildTestPageModel, type HelperPolicy } from './helpers/page-model.js';
import { deliveryTrace } from './helpers/device-log.js';

/**
 * Synthetic PDF tests for buildSourceMap and linkPage. The reference for expected values is the MuPDF Device callbacks (test-only PageModel).
 * Matching criteria: total count difference 0, all glyphs and shapes matched, origin error at most 0.01pt.
 */

interface Built {
  doc: mupdf.PDFDocument;
}

type Res = Record<string, unknown>;

/** 1-page document. If content is an array, a /Contents array. Provides the disabled OCG /OC1 and Helvetica /F1. */
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
 * Numbers without an owning operation (pattern cell content, duplicate re-sends under the no-clip policy) are not matching targets.
 * Checks that the total count difference is 0 and that all glyphs and shapes with owned numbers matched.
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

describe('buildSourceMap: streams and byte ranges', () => {
  it('3 /Contents arrays, operations spanning stream boundaries (operands, strings)', () => {
    const b = build(['BT /F1 12 Tf 50', '700 Td (A', ') Tj ET 0 0 5 5 re f']);
    const r = match(b);
    expectFull(r);
    expect(r.map.streams.map((s) => s.contentsIndex)).toEqual([0, 1, 2]);
    const td = r.map.ops.find((o) => o.op === 'Td')!;
    expect(td.stream.contentsIndex).toBe(0);
    expect(td.limits).toContain('spans-stream-boundary');
    const tj = r.map.ops.find((o) => o.op === 'Tj')!;
    expect(tj.limits).toContain('spans-stream-boundary');
    // MuPDF joins streams with a space: a boundary byte inside a string becomes a glyph (code 32).
    expect(tj.text!.glyphs.map((g) => g.code)).toEqual([65, 32]);
    const f = r.map.ops.find((o) => o.op === 'f')!;
    expect(f.stream.contentsIndex).toBe(2);
    expect(f.limits).not.toContain('spans-stream-boundary');
  });

  it('operation ranges and glyph byte ranges (literal escapes, hex)', () => {
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

describe('Form XObject recursion', () => {
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
      // A Form without its own /Resources (L1): uses /F1 from the page resources.
      const fx3 = doc.addStream(bt('(L1) Tj'), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 300, 300],
      });
      return { XObject: { Fx1: fx1, Fx3: fx3 } };
    });

  it('execution order, formPath and ctm of nested Forms match the xobject.ts usage-site index', () => {
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
      // Do owns one BBox clipPath.
      expect(d.paintSeq?.length).toBe(1);
    });
    const l1 = textOps(r.map).find(
      (o) => o.text!.glyphs.length === 2 && o.formPath[0]?.resourceName === 'Fx3',
    )!;
    expect(l1.limits).toContain('form-inherits-resources');
    expect(r.map.streams.filter((s) => s.contentsIndex === null).length).toBe(3);
  });

  it('depth limit and cycles give form-depth-exceeded', () => {
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

describe('text state and glyph origins', () => {
  it('Tm·Td·TD·T*·TL·Tc·Tw·Tz·Ts·TJ adjustment·\'·" ', () => {
    const r = match(
      build(
        'BT /F1 11 Tf 0.9 0.2 -0.2 0.9 40 600 Tm 1.5 Tc 4 Tw 85 Tz 3 Ts (a b  c) Tj 0 -14 TD (d e) Tj T* [(F) -250 (g) 120.5 ( h)] TJ 16 TL (i j) \' 2 0.5 (k l) " ET',
      ),
    );
    expectFull(r);
  });

  it('rotating/scaling CTM and page /Rotate', () => {
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

  it('Type0 Identity-H (addFont) and standard 14 fonts without width information', () => {
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

  it('vertical writing Identity-V (/W2, DW2 defaults)', () => {
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

  it('predefined CMap whose CID mapping is unknown: matched by number continuity even if origins deviate (font-encoding-unresolved)', () => {
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

  it('Type3 font (non-default /FontMatrix), Tr 1 and 7 are fill and ignore per MuPDF rules', () => {
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

describe('direct execution of Type3 glyphs (MuPDF render_direct)', () => {
  /** Type3 font with two glyphs, codes 65 and 66. procs = [A procedure, B procedure]. */
  const type3 = (doc: mupdf.PDFDocument, procs: [string, string], res: Res = {}) =>
    doc.addObject({
      Type: 'Font',
      Subtype: 'Type3',
      FontBBox: [0, 0, 1000, 1000],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { a: doc.addStream(procs[0], {}), b: doc.addStream(procs[1], {}) },
      Encoding: { Type: 'Encoding', Differences: [65, 'a', 'b'] },
      FirstChar: 65,
      LastChar: 66,
      Widths: [600, 700],
      Resources: res,
    });
  const traceMatches = (b: Built) => {
    const trace: string[] = [];
    buildSourceMapImpl(b.doc, 0, 8, 'first-arrival', trace);
    expect(trace.map((t) => t.replace(/:[NR]+$/, ''))).toEqual(deliveryTrace(b.doc.loadPage(0)));
    return trace;
  };

  it('d0 + paint without color setting = not cacheable -> run the procedure directly per glyph + ignoreText (arXiv pdfTeX type)', () => {
    const b = build('BT /T 20 Tf 50 700 Td (ABA) Tj ET', (doc) => ({
      Font: {
        T: type3(doc, ['600 0 d0 0 0 500 500 re f', '700 0 d0 0 0 250 500 re f 0 0 9 9 re f']),
      },
    }));
    expect(traceMatches(b).filter((t) => t !== 'P')).toEqual([
      'ignore:1:N',
      'ignore:1:N',
      'ignore:1:N',
    ]);
    const r = match(b);
    expectFull(r);
    const tj = textOps(r.map)[0]!;
    expect(tj.paintSeq).toEqual([0, 1, 2, 3]);
    expect(tj.limits).toEqual(expect.arrayContaining(['type3-font', 'outside-page-content']));
  });

  it('d1 + B with undetermined line state = not cacheable; MASK inside a glyph is restored after direct execution (zen-ko type)', () => {
    const b = build(
      'BT /T 20 Tf 50 700 Td (AB) Tj ET /Pattern cs /SP scn 10 10 50 50 re f 1 0 0 rg BT /F1 12 Tf 60 600 Td (x) Tj ET',
      (doc) => ({
        Font: {
          F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
          T: type3(doc, [
            '600 0 0 0 500 500 d1 0 0 500 500 re B',
            '700 0 0 0 500 500 d1 1 0 0 rg 0 0 250 500 re B',
          ]),
        },
        Pattern: { SP: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
      }),
    );
    // fillPath+strokePath per glyph (1 0 0 rg inside the B glyph is ignored as MASK). MuPDF restores the device flags after direct execution,
    // so the later pattern setup is applied and f gives 2: clip+fillShade.
    expect(traceMatches(b)).toEqual([
      'P',
      'P',
      'ignore:1:N',
      'P',
      'P',
      'ignore:1:N',
      'P',
      'P',
      'fill:1:N',
    ]);
    expectFull(match(b));
  });

  it('cacheable if d1 sets all of w, j, d and draws a line; not cacheable if d is missing', () => {
    const b = build('BT /T 20 Tf 50 700 Td (AB) Tj ET', (doc) => ({
      Font: {
        T: type3(doc, [
          '600 0 0 0 500 500 d1 10 w 1 j [] 0 d 0 0 500 500 re B',
          '700 0 0 0 500 500 d1 10 w 1 j 0 0 250 500 re B',
        ]),
      },
    }));
    // A is cacheable (fill); B runs directly because the dash is undetermined (fillPath+strokePath+ignore).
    expect(traceMatches(b)).toEqual(['fill:1:N', 'P', 'P', 'ignore:1:N']);
    expectFull(match(b));
  });

  it('a colored glyph (d0, color set) + pattern fill color = direct execution', () => {
    const b = build('/Pattern cs /SP scn BT /T 20 Tf 50 700 Td (A) Tj ET', (doc) => ({
      Font: {
        T: type3(doc, ['600 0 d0 0 1 0 rg 0 0 500 500 re f', '700 0 d0 0 0 1 rg 0 0 9 9 re f']),
      },
      Pattern: { SP: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
    }));
    expect(traceMatches(b)).toEqual(['P', 'ignore:1:N']);
    expectFull(match(b));
  });

  it('directly executed paints still arrive inside an /OC that is off (the new handler has hidden counter 0)', () => {
    const b = build('/OC /OC1 BDC BT /T 20 Tf 50 700 Td (AB) Tj ET EMC', (doc) => ({
      Font: { T: type3(doc, ['600 0 d0 0 0 500 500 re f', '700 0 d0 0 0 250 500 re f']) },
    }));
    expect(traceMatches(b)).toEqual(['P', 'ignore:1:N', 'P', 'ignore:1:N']);
    expectFull(match(b));
  });
});

describe('text render modes (Tr 0-7) and ET re-send', () => {
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
  // no-clip (core option A): duplicate ET ignore re-sends become numbers without an owner (those characters are not matched).
  for (const c of cases) {
    it(`no-clip: ${c}`, () => void expectOwned(match(build(bt(c)), 'no-clip')));
  }
  it('no-clip: number of duplicate ignore re-send characters', () => {
    const r = match(build(bt(cases[7]!)), 'no-clip');
    expect(expectOwned(r).unownedChars).toBe(2);
  });

  it('first-arrival: Tr 7 glyphs get the ET-time number, glyphs that do not reach the Device are null', () => {
    const r = match(build(bt('7 Tr (A) Tj 0 Tr (B) Tj 7 Tr (C) Tj 0 Tr')));
    const seq = textOps(r.map).map((o) => o.text!.glyphs.map((g) => g.seq));
    // After displaying B (0) there is no ET re-send (the last glyph's Tr 7 -> clip AC: 1, 2).
    expect(seq).toEqual([[1], [0], [2]]);
    expect(textOps(r.map)[0]!.limits).toContain('clip-text');
  });

  it('text inside a Form is merged into the execution unit and clip accumulation of the page BT', () => {
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

describe('optional content and marked content', () => {
  it('/OC off: no Tr 0-2, paths, images or shades; clips, Tr 3 and ET re-sends are counted', () => {
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

  it('a disabled BDC inside BT: execution units are split at marked content boundaries', () => {
    expectFull(match(build(bt('(A) Tj /OC /OC1 BDC (B) Tj EMC (C) Tj'))));
    expectFull(match(build(bt('/OC /OC1 BDC (A) Tj 1 0 0 rg EMC (B) Tj'))));
  });

  it('OCMD (AnyOn, AllOff) and enabled OCG', () => {
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

  it('MCID and tagged-content', () => {
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

describe('shapes, images, patterns', () => {
  it('W clip, empty path, B family', () => {
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

  it('inline images (EI inside data, mask) and image XObjects (/SMask counts 2)', () => {
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

  it('shading pattern: fill, stroke, text (Tr 0 and 2, fill pattern + stroke color)', () => {
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

  it('pattern color Tr 6: clipStrokeText of the same object is skipped at step 1 (contract amendment 6, regression of the amendment 2 rule mismatch)', () => {
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
    // (Ef) fill and stroke both patterns, (Gh) fill color and stroke pattern. 4 displayed glyphs.
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
    // The amendment 6 classification matches.
    expectFull(match(b));
    // Step 1 of amendment 2 (skipping only fill/stroke) made the same-object clipStrokeText consume and empty entries, so it newly counted 2+2 ET re-sends.
    expect(buildTestPageModel(b.doc, 0, 'first-arrival-v2').glyphCount).toBe(8);
  });

  it('tiling pattern: direct execution (small region, including cell glyphs) and the beginTile path (large region)', () => {
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
    // Direct-execution cells (10x10 -> 1, 9x9 -> 1, line 5x5 -> 4 tiles): the cell fillPath is owned by the pattern paint operation
    // and carries outside-page-content (contract section 3). Cell glyphs only consume numbers, without an owning operation.
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

  it('tiling pattern: a fill pattern remains inside a stroke pattern cell so the cell runs again (a colored pattern releases only the painting side)', () => {
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
    // S: clipStroke 1 + 4 tiles x (clip + nested cell fill) = 9, B: clip + 4 fill + clipStroke + 8 = 14.
    expect(r.model.paintCount).toBe(23);
    expectOwned(r);
  });

  it('SMask: callbacks in the mask section are not counted', () => {
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

describe('errors and limits', () => {
  it('missing Tf resource: MuPDF draws with the hail-mary font (numbers and origins match, font-encoding-unresolved)', () => {
    const r = match(build('BT /Missing 12 Tf 50 700 Td (AB c) Tj ET BT 50 650 Td (no font) Tj ET'));
    expectFull(r);
    const [missing, noFont] = textOps(r.map);
    expect(missing!.limits).toContain('font-encoding-unresolved');
    expect(missing!.text!.glyphs.every((g) => g.seq !== null)).toBe(true);
    // The Tf of the first BT remains in gstate, so the second is also drawn with hail-mary.
    expect(noFont!.text!.glyphs.every((g) => g.seq !== null)).toBe(true);
  });

  it('text before Tf is not drawn', () => {
    const r = match(build('BT 50 650 Td (no font) Tj ET'));
    expectFull(r);
    expect(textOps(r.map)[0]!.text!.glyphs).toEqual([]);
  });

  it('tokenizer error: records only the operations before it, tokenizer-error', () => {
    const map = buildSourceMap(build('0 0 9 9 re f BT /F1 9 Tf (open Tj ET').doc, 0);
    expect(map.errors.length).toBe(1);
    expect(map.ops.map((o) => o.op)).toEqual(['re', 'f', 'BT', 'Tf']);
    expect(map.ops.every((o) => o.limits.includes('tokenizer-error'))).toBe(true);
  });
});

describe('linkPage resynchronization', () => {
  it('resynchronizes a misnumbered section by origin, and failures are -1 and unmatched', () => {
    const b = build(`${bt('(Hello world) Tj')} ${bt('0 -20 Td (Second line) Tj')}`);
    const model = buildTestPageModel(b.doc, 0);
    const map = buildSourceMap(b.doc, 0);
    // Insert one character not in the model so that subsequent numbers shift by 1.
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

  it('does not match if the origin error exceeds the tolerance', () => {
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

describe('performance regression: long path', () => {
  it('painting 20,000 re as one path, path closing is not proportional to the path length (previously 4.7 s)', () => {
    const parts: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      parts.push(`${(i % 100) * 6} ${Math.floor(i / 100) * 3} 4 2 re`);
    }
    parts.push('f');
    const { doc } = build(parts.join('\n'));
    const t0 = performance.now();
    const map = buildSourceMap(doc, 0);
    const ms = performance.now() - t0;
    expect(map.paintCount).toBe(1);
    expect(map.ops.filter((o) => o.op === 're')).toHaveLength(20_000);
    // About 0.05 s measured after the fix. A generous upper bound that allows for concurrent load.
    expect(ms).toBeLessThan(2_000);
  });

  it('a Tj with 150,000 glyphs also gets its glyphSeq range (no limit on the number of spread arguments)', () => {
    const { doc } = build(`BT /F1 0.01 Tf 0 0 Td (${'a'.repeat(150_000)}) Tj ET`);
    const map = buildSourceMap(doc, 0);
    expect(map.glyphCount).toBe(150_000);
    expect(map.ops.find((o) => o.op === 'Tj')!.glyphSeq).toEqual([0, 150_000]);
  });
});
