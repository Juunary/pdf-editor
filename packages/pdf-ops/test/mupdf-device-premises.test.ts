import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { brief, recordDevice } from './helpers/device-log.js';

/**
 * Checks the M1 contract section 3 verification premises V1-V5 with MuPDF 1.28.1 Device callbacks (docs/m1-pdf-ops.md section 2).
 * Expected values are measured behavior. Items that deviate from the contract (V3, V5) have "contract mismatch" in the test name.
 */

interface PageSpec {
  /** A string means a single /Contents; an array means a /Contents array. */
  content: string | string[];
  resources?: (doc: mupdf.PDFDocument, ocg: mupdf.PDFObject) => Record<string, unknown>;
}

/** Builds a 1-page document with one OCG turned off (/OCProperties /D /OFF) and Helvetica /F1, and returns the Device log. */
function record(spec: PageSpec) {
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
  const res = { Font: { F1 }, Properties: { OC1: ocg }, ...spec.resources?.(doc, ocg) };
  const contents = Array.isArray(spec.content) ? spec.content : [spec.content];
  const pageObj = doc.addPage([0, 0, 612, 792], 0, res, contents[0]!);
  if (contents.length > 1) {
    const arr = doc.newArray();
    for (const c of contents) arr.push(doc.addStream(c, {}));
    pageObj.put('Contents', arr);
  }
  doc.insertPage(-1, pageObj);
  const saved = doc.saveToBuffer('').asUint8Array().slice();
  const reopened = mupdf.Document.openDocument(saved, 'application/pdf');
  return recordDevice(reopened.loadPage(0));
}

const bt = (body: string) => `BT /F1 12 Tf 50 700 Td ${body} ET 0 Tr`;
const hiddenBt = (body: string) => `/OC /OC1 BDC ${bt(body)} EMC`;
const run = (content: string | string[], resources?: PageSpec['resources']) =>
  brief(record({ content, resources }));

describe('V1: callbacks arrive in content execution order, including Form recursion', () => {
  it('3 /Contents arrays + nested Form. Form Do sends the BBox clipPath first', () => {
    const ev = run(
      [bt('(P1) Tj'), 'q 1 0 0 1 50 400 cm /Fx1 Do Q', `${bt('(P2) Tj')} 0 0 5 5 re f`],
      (doc) => {
        const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
        const fx2 = doc.addStream(`${bt('(N2) Tj')} 0 0 10 10 re f`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          Resources: { Font: { F1 } },
        });
        const fx1 = doc.addStream(
          `${bt('(F1a) Tj')} q 1 0 0 1 30 0 cm /Fx2 Do Q ${bt('(F1b) Tj')}`,
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 200, 100],
            Matrix: [2, 0, 0, 2, 0, 0],
            Resources: { Font: { F1 }, XObject: { Fx2: fx2 } },
          },
        );
        return { XObject: { Fx1: fx1 } };
      },
    );
    expect(ev).toEqual([
      'fill:P1',
      'clipPath',
      'fill:F1a',
      'clipPath',
      'fill:N2',
      'fillPath',
      'fill:F1b',
      'fill:P2',
      'fillPath',
    ]);
  });
});

describe('V2: several Tj/TJ are grouped into one callback while glyph order is preserved', () => {
  it('Tj, TJ, Td, T*, \', ", Tf change, q are grouped; color and Q split', () => {
    expect(
      run(bt('14 TL (Ab) Tj [(C) -500 (d)] TJ T* (E) Tj (f) \' 1 2 (g) " /F1 9 Tf (h) Tj')),
    ).toEqual(['fill:AbCdEfgh']);
    expect(run(bt('(Ab) Tj 1 0 0 rg (Cd) Tj q (Ef) Tj Q (Gh) Tj'))).toEqual([
      'fill:Ab',
      'fill:CdEf',
      'fill:Gh',
    ]);
  });

  it('a path paint inside BT comes before the grouped text (the numbering scheme differs, so matching is unaffected)', () => {
    expect(run(bt('(Ab) Tj 0 0 10 10 re f (Cd) Tj'))).toEqual(['fillPath', 'fill:AbCd']);
  });
});

describe('V3: callbacks per text render mode', () => {
  it('Tr 0-3: fill / stroke / fill+stroke (same object) / ignore', () => {
    expect(run(bt('(A) Tj 1 Tr (B) Tj 2 Tr (C) Tj 3 Tr (D) Tj'))).toEqual([
      'fill:A',
      'stroke:B',
      'fill:C',
      'stroke=:C',
      'ignore:D',
    ]);
  });

  it('contract mismatch: the clip for Tr 4-6 arrives at ET as a text object different from the display callback', () => {
    expect(run(bt('4 Tr (Ab) Tj (Cd) Tj'))).toEqual(['fill:AbCd', 'clip:AbCd']);
    expect(run(bt('5 Tr (Ab) Tj'))).toEqual(['stroke:Ab', 'clip:Ab']);
    expect(run(bt('6 Tr (Ab) Tj'))).toEqual(['fill:Ab', 'stroke=:Ab', 'clip:Ab']);
    expect(run(bt('7 Tr (Ab) Tj'))).toEqual(['clip:Ab']);
  });

  it('gid and trm of the ET re-sent glyphs are bit-identical to the display callback', () => {
    const ev = record({
      content: bt(
        '0.9 0.1 -0.1 0.9 50.17 700.33 Tm 0.7 Tc 1.3 Tw 87 Tz 2 Ts 4 Tr (A b) Tj [(C) -123.4 (d)] TJ',
      ),
    });
    const [fill, clip] = ev.filter((e) => e.pointer !== undefined);
    expect(fill!.kind).toBe('fillText');
    expect(clip!.kind).toBe('clipText');
    expect(clip!.pointer).not.toBe(fill!.pointer);
    expect(clip!.glyphs).toEqual(fill!.glyphs);
  });

  it('ET re-send = all Tr 4-7 glyphs of that BT. If the Tr of the last glyph in the BT is 4-7: clip; 3: ignore; 0-2: none', () => {
    expect(run(bt('7 Tr (A) Tj 4 Tr (B) Tj'))).toEqual(['fill:B', 'clip:AB']);
    expect(run(bt('7 Tr (A) Tj 0 Tr (B) Tj 5 Tr (C) Tj'))).toEqual([
      'fill:B',
      'stroke:C',
      'clip:AC',
    ]);
    expect(run(bt('4 Tr (Ab) Tj 0 Tr (Xy) Tj 7 Tr (Cd) Tj 3 Tr (In) Tj'))).toEqual([
      'fill:Ab',
      'fill:Xy',
      'ignore:In',
      'ignore:AbCd',
    ]);
    expect(run(bt('7 Tr (A) Tj 0 Tr (B) Tj'))).toEqual(['fill:B']);
    expect(run(bt('4 Tr (A) Tj 1 Tr (B) Tj'))).toEqual(['fill:A', 'stroke:B']);
    expect(run(bt('7 Tr (A) Tj 2 Tr (B) Tj'))).toEqual(['fill:B', 'stroke=:B']);
  });

  it('"Tr of the last glyph" is the Tr that produced a glyph (not changed by an empty string or a Tr change alone)', () => {
    expect(run(bt('7 Tr (A) Tj 0 Tr'))).toEqual(['clip:A']);
    expect(run(bt('7 Tr (A) Tj 0 Tr () Tj'))).toEqual(['clip:A']);
    expect(run(bt('7 Tr (A) Tj 1 0 0 rg (B) Tj'))).toEqual(['clip:AB']);
  });
});

describe('V4: a fill+stroke operation yields 2 callbacks, fillPath then strokePath', () => {
  it('B·B*·b·b*', () => {
    expect(run('0 0 9 9 re B 0 0 9 9 re B* 0 0 9 9 re b 0 0 9 9 re b*')).toEqual([
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
      'fillPath',
      'strokePath',
    ]);
  });

  it('an empty path also sends a callback: f (no path), m S, zero-size re f. n yields none without W', () => {
    expect(run('f 50 50 m S 60 60 m 70 70 l n 0 0 0 0 re f')).toEqual([
      'fillPath',
      'strokePath',
      'fillPath',
    ]);
  });
});

describe('V5: optional content turned off', () => {
  it('Tr 0-2 text, paths, images and shades do not arrive', () => {
    const ev = run(
      '/OC /OC1 BDC BT /F1 12 Tf 50 600 Td (H0) Tj 1 Tr (H1) Tj 2 Tr (H2) Tj ET 0 Tr 10 10 20 20 re f q 50 0 0 50 0 0 cm /Im Do Q /Sh sh EMC',
      (doc) => ({
        XObject: {
          Im: doc.addImage(
            new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)),
          ),
        },
        Shading: {
          Sh: {
            ShadingType: 2,
            ColorSpace: 'DeviceRGB',
            Coords: [0, 0, 100, 0],
            Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
          },
        },
      }),
    );
    expect(ev).toEqual([]);
  });

  it('a Form XObject with /OC off sends nothing, including the BBox clip', () => {
    const ev = run('/FxH Do 0 0 1 1 re f', (doc, ocg) => ({
      XObject: {
        FxH: doc.addStream('0 0 10 10 re W n 0 0 10 10 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 100, 100],
          OC: ocg,
        }),
      },
    }));
    expect(ev).toEqual(['fillPath']);
  });

  it('contract mismatch: even inside an /OC that is off, clips (W n, Form BBox) and Tr 3/ET re-sent text still arrive', () => {
    const ev = run(
      `/OC /OC1 BDC q 10 10 30 30 re W n Q /Fx Do EMC ${hiddenBt('3 Tr (H3) Tj')}`,
      (doc) => ({
        XObject: {
          Fx: doc.addStream('0 0 10 10 re f', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 100, 100],
          }),
        },
      }),
    );
    expect(ev).toEqual(['clipPath', 'clipPath', 'ignore:H3']);
    expect(run(hiddenBt('4 Tr (H4) Tj 7 Tr (H7) Tj 3 Tr (H3) Tj 0 Tr'))).toEqual([
      'ignore:H3',
      'ignore:H4H7',
    ]);
    expect(run(hiddenBt('1 Tr (S1) Tj 2 Tr (S2) Tj 5 Tr (S5) Tj 6 Tr (S6) Tj'))).toEqual([
      'clip:S5S6',
    ]);
  });
});

describe('emulation targets that do not conflict with the contract rules (reflected in the paintSeq/glyphSeq computation)', () => {
  const shading = {
    ShadingType: 2,
    ColorSpace: 'DeviceRGB',
    Coords: [0, 0, 100, 0],
    Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
  };

  it('shading pattern: paints are clip + fillShade, text is clipText (at display time) + fillShade', () => {
    const ev = run(
      '/Pattern cs /P scn /Pattern CS /P SCN 10 10 50 50 re f 100 10 50 50 re S 200 10 50 50 re B BT /F1 20 Tf 50 700 Td (Ab) Tj ET',
      (doc) => ({
        Pattern: { P: doc.addObject({ Type: 'Pattern', PatternType: 2, Shading: shading }) },
      }),
    );
    expect(ev).toEqual([
      'clipPath',
      'fillShade',
      'clipStrokePath',
      'fillShade',
      'clipPath',
      'fillShade',
      'clipStrokePath',
      'fillShade',
      'clip:Ab',
      'fillShade',
    ]);
  });

  it('tiling pattern: clip + tile content callbacks (once if beginTile returns 0)', () => {
    const ev = run('/Pattern cs /P scn 10 10 50 50 re f', (doc) => {
      const F1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
      return {
        Pattern: {
          P: doc.addStream('0 0 5 5 re f BT /F1 4 Tf (x) Tj ET', {
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
      };
    });
    expect(ev).toEqual(['clipPath', 'beginTile', 'fillPath', 'fill:x']);
  });

  it('SMask: re-executes the mask group (BBox clip + content) for every paint', () => {
    const ev = run('q /S1 gs 10 10 50 50 re f 100 10 50 50 re f Q 0 0 1 1 re f', (doc) => {
      const g = doc.addStream('0.5 g 0 0 300 300 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 612, 792],
        Group: { S: 'Transparency', CS: 'DeviceGray' },
      });
      return { ExtGState: { S1: { SMask: { Type: 'Mask', S: 'Luminosity', G: g } } } };
    });
    expect(ev).toEqual([
      'clipPath',
      'fillPath',
      'fillPath',
      'clipPath',
      'fillPath',
      'fillPath',
      'fillPath',
    ]);
  });

  it('Type3: Tr 1 is fill, Tr 7 is ignore at ET', () => {
    const ev = run(
      'BT /T 20 Tf 50 700 Td 1 Tr (A) Tj ET BT /T 20 Tf 50 650 Td 7 Tr (B) Tj ET 0 Tr',
      (doc) => ({
        Font: {
          F1: doc.addSimpleFont(new mupdf.Font('Helvetica')),
          T: doc.addObject({
            Type: 'Font',
            Subtype: 'Type3',
            FontBBox: [0, 0, 1000, 1000],
            FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
            CharProcs: {
              a: doc.addStream('600 0 0 0 500 500 d1 0 0 500 500 re f', {}),
              b: doc.addStream('700 0 0 0 500 500 d1 0 0 250 500 re f', {}),
            },
            Encoding: { Type: 'Encoding', Differences: [65, 'a', 'b'] },
            FirstChar: 65,
            LastChar: 66,
            Widths: [600, 700],
            Resources: {},
          }),
        },
      }),
    );
    expect(ev).toEqual(['fill:a', 'ignore:b']);
  });

  it('images, inline images, masked inline images, sh inside a clip', () => {
    const ev = run(
      'q 50 0 0 50 100 100 cm /Im Do Q q 10 0 0 10 200 200 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q q 10 0 0 10 220 200 cm BI /W 1 /H 1 /IM true ID \x80 EI Q q 0 0 50 50 re W n /Sh sh Q',
      (doc) => ({
        XObject: {
          Im: doc.addImage(
            new mupdf.Image(new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 2, 2], false)),
          ),
        },
        Shading: { Sh: shading },
      }),
    );
    expect(ev).toEqual(['fillImage', 'fillImage', 'fillImageMask', 'clipPath', 'fillShade']);
  });
});
