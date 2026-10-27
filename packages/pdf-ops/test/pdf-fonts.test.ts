import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { FontCache, type PdfFont } from '../src/pdf-fonts.js';
import {
  KNOWN_GLYPH_NAMES,
  PREDEFINED_CMAP_CODESPACES,
  lookupPredefinedCMap,
} from '../src/glyph-names.js';

/**
 * Expected values are checked against MuPDF 1.28.1 itself (Device callback glyph origins).
 * With font size 1000, Tc=Tw=0 and identity CTM, the difference between consecutive glyph origins = advance (in 1/1000 units).
 * To avoid float32 accumulation error, adjacent differences are compared instead of absolute coordinates.
 */

interface Shown {
  gid: number;
  x: number;
  y: number;
  font: string;
}

interface Run {
  font: PdfFont;
  shown: Shown[];
  doc: mupdf.PDFDocument;
  fontObj: mupdf.PDFObject;
}

const hex = (bytes: ArrayLike<number>): string =>
  `<${Array.from(bytes as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join('')}>`;

/**
 * Builds a font dictionary, puts it in a one-page document, saves and reopens it, then returns the glyphs MuPDF drew together with the FontCache result.
 * show is the text-showing operation to put inside BT (e.g. `<4142> Tj`). If resource=false, /F is not added to the resources (hail-mary).
 */
function run(
  makeFont: (doc: mupdf.PDFDocument) => mupdf.PDFObject,
  show: string,
  opts: { resource?: boolean; size?: number } = {},
): Run {
  const doc = new mupdf.PDFDocument();
  const fontRef = makeFont(doc);
  const resources = opts.resource === false ? {} : { Font: { F: fontRef } };
  const page = doc.addPage(
    [0, 0, 612, 792],
    0,
    resources,
    `BT /F ${opts.size ?? 1000} Tf 0 0 Td ${show} ET`,
  );
  doc.insertPage(-1, page);
  const bytes = doc.saveToBuffer('').asUint8Array().slice();
  const reopened = mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
  const shown: Shown[] = [];
  const held: mupdf.Text[] = [];
  const rec = (t: mupdf.Text) => {
    held.push(t);
    t.walk({
      showGlyph(f, trm, gid) {
        if (gid >= 0) shown.push({ gid, x: trm[4]!, y: trm[5]!, font: f.getName() });
      },
    });
  };
  const device = new mupdf.Device({
    fillText: rec,
    strokeText: rec,
    clipText: rec,
    clipStrokeText: rec,
    ignoreText: rec,
  });
  reopened.loadPage(0).runPageContents(device, mupdf.Matrix.identity);
  device.close();
  const fontObj =
    opts.resource === false ? null : reopened.findPage(0).get('Resources', 'Font', 'F');
  const font = new FontCache(reopened).load(fontObj);
  return { font, shown, doc: reopened, fontObj: fontObj ?? mupdf.PDFObject.Null };
}

interface Compare {
  /** Number of glyphs MuPDF drew */
  drawn: number;
  /** Items that deviate from our prediction (index + description) */
  mismatches: string[];
}

/** Horizontal writing: compares MuPDF's glyph sequence with the decode->cid->advance prediction */
function compareHorizontal(r: Run, bytes: Uint8Array, checkGid = false): Compare {
  const mismatches: string[] = [];
  const codes = r.font.decode(bytes).filter((c) => r.font.cid(c.code) >= 0);
  if (codes.length !== r.shown.length) {
    mismatches.push(`글리프 수: 예측 ${codes.length} / MuPDF ${r.shown.length}`);
    return { drawn: r.shown.length, mismatches };
  }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (i + 1 < codes.length) {
      const diff = r.shown[i + 1]!.x - r.shown[i]!.x;
      const adv = r.font.advance(r.font.cid(c.code));
      if (Math.abs(diff - adv) > 0.1)
        mismatches.push(`#${i} code=${c.code}: advance 예측 ${adv} / MuPDF ${diff}`);
    }
    if (checkGid && r.font.glyphIds) {
      const g = r.font.glyphIds[r.font.cid(c.code)];
      if (g !== r.shown[i]!.gid)
        mismatches.push(`#${i} code=${c.code}: gid 예측 ${g} / MuPDF ${r.shown[i]!.gid}`);
    }
  }
  return { drawn: r.shown.length, mismatches };
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bytesOf = (codes: number[]): Uint8Array => Uint8Array.from(codes);

const TEXT_FACES = [
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
];

describe('standard 14 fonts without /Widths (built-in font widths and glyphs)', () => {
  const codes = range(0, 255);
  const bytes = bytesOf(codes);
  const make =
    (base: string, extra: Record<string, unknown> = {}) =>
    (doc: mupdf.PDFDocument) =>
      doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: base, ...extra });

  for (const base of TEXT_FACES) {
    for (const enc of [undefined, 'StandardEncoding', 'WinAnsiEncoding', 'MacRomanEncoding']) {
      it(`${base} /Encoding ${enc ?? '없음'}: glyphs and widths for codes 0-255 match MuPDF`, () => {
        const r = run(make(base, enc ? { Encoding: enc } : {}), `${hex(bytes)} Tj`);
        expect(r.font.unresolved).toEqual([]);
        expect(r.font.glyphIds).toBeDefined();
        const cmp = compareHorizontal(r, bytes, true);
        expect(cmp.drawn).toBe(codes.length);
        expect(cmp.mismatches).toEqual([]);
      });
    }
  }

  it('with descriptor Flags=4 (symbolic), only the /Encoding name applies and the base encoding is the built-in encoding', () => {
    const symbolic = (doc: mupdf.PDFDocument, enc?: unknown) =>
      doc.addObject({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        ...(enc ? { Encoding: enc } : {}),
        FontDescriptor: doc.addObject({
          Type: 'FontDescriptor',
          FontName: 'Helvetica',
          Flags: 4,
          FontBBox: [0, 0, 1000, 1000],
          ItalicAngle: 0,
          Ascent: 800,
          Descent: -200,
          CapHeight: 700,
          StemV: 80,
        }),
      });
    for (const enc of [
      undefined,
      'WinAnsiEncoding',
      { Type: 'Encoding', Differences: [65, 'Euro', 'bullet', 'noSuchGlyph'] },
      { Type: 'Encoding', BaseEncoding: 'MacRomanEncoding', Differences: [65, 'Euro'] },
    ]) {
      const r = run((doc) => symbolic(doc, enc), `${hex(bytes)} Tj`);
      expect(compareHorizontal(r, bytes, true).mismatches, JSON.stringify(enc)).toEqual([]);
    }
  });
});

describe('standard 14 fonts: Differences and glyph name resolution', () => {
  const codes = range(0, 255);
  const bytes = bytesOf(codes);
  const base =
    (name: string, diffs: (string | number)[], baseEnc?: string) => (doc: mupdf.PDFDocument) =>
      doc.addObject({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: name,
        Encoding: {
          Type: 'Encoding',
          ...(baseEnc ? { BaseEncoding: baseEnc } : {}),
          Differences: diffs,
        },
      });

  for (const face of TEXT_FACES) {
    it(`${face}: glyphs and widths match even when placing ${KNOWN_GLYPH_NAMES.length} known glyph names via Differences`, () => {
      const mismatches: string[] = [];
      for (let from = 0; from < KNOWN_GLYPH_NAMES.length; from += codes.length) {
        const names = KNOWN_GLYPH_NAMES.slice(from, from + codes.length);
        const part = bytes.subarray(0, names.length);
        const r = run(base(face, [0, ...names]), `${hex(part)} Tj`);
        const cmp = compareHorizontal(r, part, true);
        expect(cmp.drawn).toBe(names.length);
        for (const m of cmp.mismatches) {
          const i = Number(/#(\d+)/.exec(m)?.[1] ?? -1);
          mismatches.push(`${names[i] ?? '?'}: ${m}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('synthesized names uXXXX, uniXXXX and suffixed (.alt, _) are mostly not found, fall back to built-in glyphs, and are marked unresolved', () => {
    // Measured on 1.28.1: none of these names are found in the font, so the built-in glyph at the code position appears (uni20AC and Euro.sc are excluded because Euro appears)
    const names = ['u2022', 'uni00E9', 'A.alt', 'one.oldstyle', 'f_i', 'eacute.x'];
    const part = bytesOf([65, 66, 67, 68, 69, 70]);
    for (const face of ['Helvetica', 'Times-Italic', 'Courier-Bold']) {
      const r = run(base(face, [65, ...names]), `${hex(part)} Tj`);
      expect(compareHorizontal(r, part, true).mismatches, face).toEqual([]);
      expect(r.font.unresolved.length).toBe(names.length);
    }
  });

  it('a name missing from the font falls back to the built-in encoding glyph (0x27 is quoteright)', () => {
    const names = ['noSuchGlyphA', 'noSuchGlyphB', 'g12', 'cid77'];
    const part = bytesOf([39, 40, 41, 42, 43]);
    const r = run(base('Helvetica', [39, ...names]), `${hex(part)} Tj`);
    expect(compareHorizontal(r, part, true).mismatches).toEqual([]);
    expect(r.font.unresolved.length).toBe(4);
  });

  it('Differences is applied on top of BaseEncoding if present, otherwise on top of StandardEncoding', () => {
    for (const enc of [undefined, 'WinAnsiEncoding', 'MacRomanEncoding', 'PDFDocEncoding']) {
      const r = run(
        base('Times-Roman', [65, 'Euro', 'fi', 'quotesingle'], enc),
        `${hex(bytes)} Tj`,
      );
      expect(compareHorizontal(r, bytes, true).mismatches, String(enc)).toEqual([]);
    }
  });

  it('matches MuPDF even when the first Differences entry is a name or a code is out of range', () => {
    const r1 = run(
      base('Times-Roman', ['Euro', 'fi', 300, 'bullet', -1, 'florin', 70, 'germandbls']),
      `${hex(bytes)} Tj`,
    );
    expect(compareHorizontal(r1, bytes, true).mismatches).toEqual([]);
  });

  it('a standard font marked with Subtype TrueType gives the same result', () => {
    for (const enc of ['WinAnsiEncoding', 'MacRomanEncoding']) {
      const r = run(
        (doc) =>
          doc.addObject({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Arial', Encoding: enc }),
        `${hex(bytes)} Tj`,
      );
      expect(compareHorizontal(r, bytes, true).mismatches).toEqual([]);
    }
  });

  it('alias names (ArialMT, TimesNewRomanPS-BoldMT, including spaces) resolve to standard fonts', () => {
    for (const name of [
      'ArialMT',
      'Arial MT',
      'TimesNewRomanPS-BoldMT',
      'CourierNewPS-BoldItalicMT',
      'Courier New',
    ]) {
      const r = run(
        (doc) =>
          doc.addObject({
            Type: 'Font',
            Subtype: 'TrueType',
            BaseFont: name,
            Encoding: 'WinAnsiEncoding',
          }),
        `${hex(bytes)} Tj`,
      );
      expect(compareHorizontal(r, bytes, true).mismatches, name).toEqual([]);
    }
  });

  it('MacExpertEncoding has no table, so it is marked unresolved', () => {
    const r = run(
      (doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'MacExpertEncoding',
        }),
      `${hex(bytes)} Tj`,
    );
    expect(r.font.unresolved.length).toBe(1);
  });
});

describe('Symbol and ZapfDingbats (no /Widths)', () => {
  const bytes = bytesOf(range(0, 255));
  const make =
    (base: string, extra: Record<string, unknown> = {}) =>
    (doc: mupdf.PDFDocument) =>
      doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: base, ...extra });

  for (const base of ['Symbol', 'ZapfDingbats']) {
    it(`${base}: glyphs and widths for built-in encoding codes 0-255 match MuPDF`, () => {
      const r = run(make(base), `${hex(bytes)} Tj`);
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareHorizontal(r, bytes, true);
      expect(cmp.drawn).toBe(256);
      expect(cmp.mismatches).toEqual([]);
    });
    it(`${base} + /Encoding: reports the approximation as unresolved`, () => {
      const r = run(make(base, { Encoding: 'WinAnsiEncoding' }), `${hex(bytes)} Tj`);
      expect(r.font.unresolved.length).toBeGreaterThan(0);
    });
  }
});

describe('names that are not standard fonts (no /Widths)', () => {
  const bytes = bytesOf(range(32, 126));
  const desc = (
    doc: mupdf.PDFDocument,
    name: string,
    flags: number,
    extra: Record<string, unknown> = {},
  ) =>
    doc.addObject({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: flags,
      FontBBox: [0, 0, 1000, 1000],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
      ...extra,
    });

  it('with no descriptor and an unknown name, Times-Roman', () => {
    const r = run(
      (doc) => doc.addObject({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Foo' }),
      `${hex(bytes)} Tj`,
    );
    expect(r.font.unresolved).toEqual([]);
    expect(compareHorizontal(r, bytes, true).mismatches).toEqual([]);
    expect(r.font.advance(32)).toBe(250);
    // Built-in font widths are integers, so they equal the specified widths.
    for (const c of bytes) expect(r.font.advanceSpec(c)).toBe(r.font.advance(c));
  });

  it('a standard name with a subset prefix is not accepted as an alias (measured on 1.28.1)', () => {
    const r = run(
      (doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'TrueType',
          BaseFont: 'ABCDEF+Arial-BoldMT',
          Encoding: 'WinAnsiEncoding',
        }),
      `${hex(bytes)} Tj`,
    );
    expect(compareHorizontal(r, bytes, true).mismatches).toEqual([]);
    expect(r.font.advance(32)).toBe(250);
  });

  // [name, flags, space width of the expected substitute font]
  const cases: [string, number, number][] = [
    ['Foo', 32, 278],
    ['Foo-Bold', 32, 278],
    ['Foo', 34, 250],
    ['Foo-Bold', 34, 250],
    ['Foo', 33, 600],
    ['Foo-Italic', 35, 600],
    ['Foo', 32 | 0x40, 278],
    ['Foo', 34 | 0x40000, 250],
    ['ABCDEF+Helvetica', 32, 278],
  ];
  for (const [name, flags, space] of cases) {
    it(`with descriptor: ${name} Flags=${flags} -> substitute font (space ${space})`, () => {
      const r = run(
        (doc) =>
          doc.addObject({
            Type: 'Font',
            Subtype: 'TrueType',
            BaseFont: name,
            Encoding: 'WinAnsiEncoding',
            FontDescriptor: desc(doc, name, flags),
          }),
        `${hex(bytes)} Tj`,
      );
      expect(r.font.unresolved).toEqual([]);
      expect(r.font.advance(32)).toBe(space);
      const cmp = compareHorizontal(r, bytes, true);
      expect(cmp.drawn).toBe(bytes.length);
      expect(cmp.mismatches).toEqual([]);
    });
  }

  it('embedded font file + no /Widths: width cannot be resolved -> replaced by MissingWidth and marked unresolved', () => {
    const r = run(
      (doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'TrueType',
          BaseFont: 'Foo',
          FontDescriptor: desc(doc, 'Foo', 32, {
            MissingWidth: 321.9,
            FontFile2: doc.addStream('not a font', {}),
          }),
        }),
      `${hex(bytesOf([65, 66, 67]))} Tj`,
    );
    expect(r.font.unresolved.length).toBe(1);
    expect(r.font.advance(65)).toBe(321);
  });
});

describe('simple font /Widths', () => {
  const desc = (doc: mupdf.PDFDocument, missing?: number) =>
    doc.addObject({
      Type: 'FontDescriptor',
      FontName: 'Foo',
      Flags: 32,
      FontBBox: [0, 0, 1000, 1000],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
      ...(missing === undefined ? {} : { MissingWidth: missing }),
    });
  const make =
    (
      widths: unknown[],
      extra: Record<string, unknown> = {},
      missing?: number,
      subtype = 'TrueType',
    ) =>
    (doc: mupdf.PDFDocument) =>
      doc.addObject({
        Type: 'Font',
        Subtype: subtype,
        BaseFont: 'Foo',
        FontDescriptor: desc(doc, missing),
        Widths: widths,
        ...extra,
      });

  it('FirstChar offset, outside the range MissingWidth (reals truncated by floor), short Widths give 0, fractions use floor(x+0.5)', () => {
    const widths = [556.6, 556.4, 500.5, -300.5, -300.6, 100, 2.5];
    // LastChar (73) exceeds the Widths length (7) -> the rest is 0
    const bytes = bytesOf(range(60, 80));
    const r = run(make(widths, { FirstChar: 65, LastChar: 73 }, 123.9), `${hex(bytes)} Tj`);
    expect(r.font.unresolved).toEqual([]);
    const cmp = compareHorizontal(r, bytes);
    expect(cmp.drawn).toBe(21);
    expect(cmp.mismatches).toEqual([]);
    const adv = (c: number) => r.font.advance(r.font.cid(c));
    expect([60, 64, 74, 80].map(adv)).toEqual([123, 123, 123, 123]);
    expect(range(65, 73).map(adv)).toEqual([557, 556, 501, -300, -301, 100, 3, 0, 0]);
    // Specified width (for editing): the real value as is (float32 precision of the MuPDF object); MissingWidth is not truncated either.
    const spec = (c: number) => r.font.advanceSpec(r.font.cid(c));
    const near = (got: number[], want: number[]) =>
      want.forEach((w, i) => expect(got[i], `${i}`).toBeCloseTo(w, 4));
    near([60, 64, 74, 80].map(spec), [123.9, 123.9, 123.9, 123.9]);
    near(range(65, 73).map(spec), [556.6, 556.4, 500.5, -300.5, -300.6, 100, 2.5, 0, 0]);
  });

  it('0 without MissingWidth, and 0 even without a descriptor', () => {
    const bytes = bytesOf([65, 66, 67, 68]);
    const r1 = run(make([700, 800], { FirstChar: 65, LastChar: 66 }), `${hex(bytes)} Tj`);
    expect(compareHorizontal(r1, bytes).mismatches).toEqual([]);
    expect([65, 66, 67].map((c) => r1.font.advance(c))).toEqual([700, 800, 0]);
    const r2 = run(
      (doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Foo',
          FirstChar: 66,
          LastChar: 66,
          Widths: [900],
        }),
      `${hex(bytes)} Tj`,
    );
    expect(compareHorizontal(r2, bytes).mismatches).toEqual([]);
    expect([65, 66, 67].map((c) => r2.font.advance(c))).toEqual([0, 900, 0]);
  });

  it('FirstChar > LastChar, LastChar > 255 or FirstChar < 0 is treated as first=last=0', () => {
    for (const extra of [
      { FirstChar: 70, LastChar: 66 },
      { FirstChar: 65, LastChar: 300 },
      { FirstChar: -1, LastChar: 5 },
    ]) {
      const bytes = bytesOf([0, 65, 66, 70]);
      const r = run(make([321, 322, 323, 324, 325, 326, 327], extra, 55), `${hex(bytes)} Tj`);
      expect(compareHorizontal(r, bytes).mismatches).toEqual([]);
      expect([0, 65, 66, 70].map((c) => r.font.advance(c))).toEqual([321, 55, 55, 55]);
    }
  });

  it('even for a standard font name, /Widths is used if present', () => {
    const bytes = bytesOf([65, 66]);
    const r = run(
      (doc) =>
        doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          FirstChar: 65,
          LastChar: 66,
          Widths: [111, 222],
        }),
      `${hex(bytes)} Tj`,
    );
    expect(r.font.unresolved).toEqual([]);
    expect(compareHorizontal(r, bytes).mismatches).toEqual([]);
    expect(r.font.advance(65)).toBe(111);
  });

  it('decode yields 1-byte codes, cid=code', () => {
    const font = new FontCache(new mupdf.PDFDocument()).load(null);
    const codes = font.decode(Uint8Array.from([0x41, 0x00, 0xff]));
    expect(codes).toEqual([
      { code: 0x41, offset: 0, length: 1 },
      { code: 0, offset: 1, length: 1 },
      { code: 0xff, offset: 2, length: 1 },
    ]);
    expect(font.cid(0xff)).toBe(0xff);
    expect(font.wmode).toBe(0);
  });
});

describe('hail-mary font (no Tf resource)', () => {
  it('drawn with Times-Roman + StandardEncoding widths', () => {
    const bytes = bytesOf(range(0, 255));
    const r = run(
      (doc) => doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }),
      `${hex(bytes)} Tj`,
      { resource: false },
    );
    expect(r.font.subtype).toBeNull();
    expect(r.font.objectNumber).toBeNull();
    expect(r.font.unresolved).toEqual([]);
    expect(r.shown.every((g) => g.font === '')).toBe(true);
    const cmp = compareHorizontal(r, bytes, true);
    expect(cmp.drawn).toBe(256);
    expect(cmp.mismatches).toEqual([]);
    expect(r.font.advance(32)).toBe(250);
    expect(r.font.advance(0)).toBe(250);
  });
});

describe('Type3', () => {
  const type3 =
    (extra: Record<string, unknown> = {}) =>
    (doc: mupdf.PDFDocument) => {
      const cp = doc.addStream('1000 0 0 0 750 750 d1 0 0 750 750 re f', {});
      return doc.addObject({
        Type: 'Font',
        Subtype: 'Type3',
        FontBBox: [0, 0, 750, 750],
        FirstChar: 65,
        LastChar: 68,
        Encoding: { Type: 'Encoding', Differences: [65, 'a', 'b', 'c', 'd'] },
        CharProcs: { a: cp, b: cp, c: cp, d: cp },
        Resources: {},
        ...extra,
      });
    };
  const bytes = bytesOf([65, 66, 67, 68, 65, 66]);

  const cases: [string, Record<string, unknown>, number[]][] = [
    [
      'FontMatrix 0.001',
      { FontMatrix: [0.001, 0, 0, 0.001, 0, 0], Widths: [500, 600.7, 700.5, 800] },
      [500, 600, 700, 800],
    ],
    [
      'FontMatrix 0.01',
      { FontMatrix: [0.01, 0, 0, 0.01, 0, 0], Widths: [500, 600.7, 700.5, 800] },
      [5000, 6007, 7004, 8000],
    ],
    [
      'FontMatrix 0.0123456',
      { FontMatrix: [0.0123456, 0, 0, 0.0123456, 0, 0], Widths: [500, 600.7, 700.5, 800] },
      [6172, 7416, 8648, 9876],
    ],
    [
      'FontMatrix 음수 a',
      { FontMatrix: [-0.001, 0, 0, 0.001, 0, 0], Widths: [500, 600, 700, 800] },
      [-500, -600, -700, -800],
    ],
    ['FontMatrix 없음 → 항등(MuPDF 동작)', { Widths: [5, 6.5, 7, 8] }, [5000, 6500, 7000, 8000]],
    [
      'FontMatrix 길이 5 → 모자란 칸 0',
      { FontMatrix: [0.001, 0, 0, 0.001, 0], Widths: [500, 600, 700, 800] },
      [500, 600, 700, 800],
    ],
  ];
  for (const [label, extra, expected] of cases) {
    it(`${label}: width = trunc(float32(a*w*1000))`, () => {
      const r = run(type3(extra), `${hex(bytes)} Tj`);
      expect(r.font.subtype).toBe('Type3');
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(6);
      expect(cmp.mismatches).toEqual([]);
      expect([65, 66, 67, 68].map((c) => r.font.advance(c))).toEqual(expected);
    });
  }

  it('type3Matrix is the matrix MuPDF uses (float32)', () => {
    const r = run(
      type3({ FontMatrix: [0.001, 0, 0, 0.001, 0, 0], Widths: [1, 2, 3, 4] }),
      `${hex(bytes)} Tj`,
    );
    expect(r.font.type3Matrix).toEqual([Math.fround(0.001), 0, 0, Math.fround(0.001), 0, 0]);
    const r2 = run(type3({ Widths: [1, 2, 3, 4] }), `${hex(bytes)} Tj`);
    expect(r2.font.type3Matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('if FirstChar > LastChar then first=last=0: only code 0 gets Widths[0], the rest are 0', () => {
    const r = run(
      type3({
        FirstChar: 70,
        LastChar: 66,
        Widths: [500, 1, 1, 1],
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      }),
      `${hex(bytes)} Tj`,
    );
    expect(compareHorizontal(r, bytes).mismatches).toEqual([]);
    expect([0, 65, 66].map((c) => r.font.advance(c))).toEqual([500, 0, 0]);
  });

  it('if any of Widths, Encoding, CharProcs is missing, MuPDF fails to load -> hail-mary widths', () => {
    for (const drop of ['Widths', 'Encoding', 'CharProcs']) {
      const extra: Record<string, unknown> = {
        FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        Widths: [500, 600, 700, 800],
      };
      const r = run(
        (doc) => {
          const f = type3(extra)(doc);
          f.delete(drop);
          return f;
        },
        `${hex(bytes)} Tj`,
      );
      expect(r.font.fallbackReason).toContain(drop);
      expect(r.font.subtype).toBeNull();
      expect(compareHorizontal(r, bytes, true).mismatches).toEqual([]);
      expect(r.font.advance(65)).toBe(722);
    }
  });
});

/** Vertical writing: glyph origin = (-v.x, accumulated w1 - v.y). Size is 1000, so the 1/1000 unit is used as is */
function compareVertical(r: Run, bytes: Uint8Array): Compare {
  const mismatches: string[] = [];
  const codes = r.font.decode(bytes).filter((c) => r.font.cid(c.code) >= 0);
  if (codes.length !== r.shown.length) {
    mismatches.push(`글리프 수: 예측 ${codes.length} / MuPDF ${r.shown.length}`);
    return { drawn: r.shown.length, mismatches };
  }
  let y = 0;
  codes.forEach((c, i) => {
    const v = r.font.vertical(r.font.cid(c.code));
    const g = r.shown[i]!;
    if (Math.abs(g.x - -v.x) > 0.1 || Math.abs(g.y - (y - v.y)) > 0.1) {
      mismatches.push(`#${i} code=${c.code}: 예측 (${-v.x}, ${y - v.y}) / MuPDF (${g.x}, ${g.y})`);
    }
    y += v.w;
  });
  return { drawn: r.shown.length, mismatches };
}

describe('Type0 (CID font)', () => {
  const cidSystemInfo = (doc: mupdf.PDFDocument) => ({
    Registry: doc.newString('Adobe'),
    Ordering: doc.newString('Identity'),
    Supplement: 0,
  });
  const descriptor = (doc: mupdf.PDFDocument) =>
    doc.addObject({
      Type: 'FontDescriptor',
      FontName: 'Foo',
      Flags: 4,
      FontBBox: [0, 0, 1000, 1000],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 80,
    });
  /** Type0 + CIDFontType2 (no embedded font: MuPDF uses a substitute font, but the widths come from /W) */
  const type0 =
    (
      encoding: string | ((doc: mupdf.PDFDocument) => unknown),
      cid: Record<string, unknown> = {},
      opts: { noDescriptor?: boolean; dfontSubtype?: string } = {},
    ) =>
    (doc: mupdf.PDFDocument) => {
      const dfont = doc.addObject({
        Type: 'Font',
        Subtype: opts.dfontSubtype ?? 'CIDFontType2',
        BaseFont: 'Foo',
        CIDSystemInfo: cidSystemInfo(doc),
        ...(opts.noDescriptor ? {} : { FontDescriptor: descriptor(doc) }),
        ...cid,
      });
      return doc.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Foo',
        Encoding: typeof encoding === 'string' ? encoding : encoding(doc),
        DescendantFonts: [dfont],
      });
    };
  const be16 = (...v: number[]): Uint8Array => Uint8Array.from(v.flatMap((x) => [x >> 8, x & 255]));

  describe('Identity-H horizontal writing', () => {
    it('/W array form and range form, /DW, real widths, DW outside the range', () => {
      const W = [10, [100, 200.5, 300], 20, 22, 450, 40, [999], 100.4, [123.6]];
      const bytes = be16(5, 10, 11, 12, 20, 21, 22, 23, 40, 41, 100, 101, 0xffff);
      const r = run(type0('Identity-H', { DW: 500, W }), `${hex(bytes)} Tj`);
      expect(r.font.wmode).toBe(0);
      expect(r.font.subtype).toBe('Type0');
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(13);
      expect(cmp.mismatches).toEqual([]);
      const adv = (c: number) => r.font.advance(r.font.cid(c));
      expect([5, 10, 11, 12, 20, 22, 23, 40, 41, 100, 101].map(adv)).toEqual([
        500, 100, 201, 300, 450, 450, 500, 999, 500, 124, 500,
      ]);
      const spec = [5, 10, 11, 12, 20, 22, 23, 40, 41, 100, 101].map((c) =>
        r.font.advanceSpec(r.font.cid(c)),
      );
      [500, 100, 200.5, 300, 450, 450, 500, 999, 500, 123.6, 500].forEach((w, i) =>
        expect(spec[i], `${i}`).toBeCloseTo(w, 4),
      );
    });

    it('1000 without /DW, rounded if /DW is a real', () => {
      const bytes = be16(1, 2, 3);
      const r1 = run(type0('Identity-H'), `${hex(bytes)} Tj`);
      expect(compareHorizontal(r1, bytes).mismatches).toEqual([]);
      expect(r1.font.advance(1)).toBe(1000);
      const r2 = run(type0('Identity-H', { DW: 777.5 }), `${hex(bytes)} Tj`);
      expect(compareHorizontal(r2, bytes).mismatches).toEqual([]);
      expect(r2.font.advance(1)).toBe(778);
      expect(r2.font.advanceSpec(1)).toBe(777.5);
    });

    it('overlapping /W entries, truncated /W, and entries with a real start CID also get the same widths as MuPDF', () => {
      const cases: unknown[][] = [
        [65, 70, 111, 66, 66, 222, 0, [5, 6]],
        [1, 10, 100, 5, 6, 300],
        [1, 3, 777, 5],
        [1.6, [333], 3.4, 4.5, 99],
        [1, [-100, 0]],
        [70000, [5], 0xffff, [6]],
      ];
      const bytes = be16(0, 1, 2, 3, 4, 5, 6, 7, 10, 64, 65, 66, 67, 70, 71, 4464, 65535);
      for (const W of cases) {
        const r = run(type0('Identity-H', { DW: 500, W }), `${hex(bytes)} Tj`);
        const cmp = compareHorizontal(r, bytes);
        expect(cmp.mismatches, JSON.stringify(W)).toEqual([]);
        expect(r.font.unresolved).toEqual([]);
      }
    });

    it('odd length: the single trailing byte is code 0, length 1 (the CID 0 glyph of Identity-H)', () => {
      const bytes = Uint8Array.from([0x00, 0x41, 0x42]);
      const r = run(type0('Identity-H', { DW: 500, W: [0, [111]] }), `${hex(bytes)} Tj`);
      expect(r.font.decode(bytes)).toEqual([
        { code: 0x41, offset: 0, length: 2 },
        { code: 0, offset: 2, length: 1 },
      ]);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(2);
      expect(cmp.mismatches).toEqual([]);
      expect(r.font.advance(r.font.cid(0))).toBe(111);
    });

    it('FontCache: the same indirect object gives the same instance, and a resolved direct object with the same pointer also gives the same instance', () => {
      const r = run(type0('Identity-H'), `${hex(be16(1))} Tj`);
      const cache = new FontCache(r.doc);
      const a = cache.load(r.fontObj);
      const b = cache.load(r.doc.findPage(0).get('Resources', 'Font', 'F'));
      expect(a).toBe(b);
      expect(a.objectNumber).toBe(r.fontObj.asIndirect());
      const d1 = cache.load(r.fontObj.resolve());
      const d2 = cache.load(r.fontObj.resolve());
      expect(d1).toBe(d2);
      expect(d1).not.toBe(a);
      expect(d1.objectNumber).toBeNull();
      expect(cache.load(null)).toBe(cache.load(null));
      expect(cache.load(mupdf.PDFObject.Null)).toBe(cache.load(null));
    });
  });

  describe('Identity-V vertical writing', () => {
    const bytes = be16(1, 2, 3, 10, 11, 20, 21, 22, 30);
    it('without DW2/W2: default (880, -1000), position vector x = width/2', () => {
      const r = run(
        type0('Identity-V', { DW: 500, W: [10, [400, 600], 20, 22, 300] }),
        `${hex(bytes)} Tj`,
      );
      expect(r.font.wmode).toBe(1);
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareVertical(r, bytes);
      expect(cmp.drawn).toBe(9);
      expect(cmp.mismatches).toEqual([]);
      expect(r.font.vertical(10)).toEqual({ w: -1000, x: 200, y: 880 });
      expect(r.font.vertical(11)).toEqual({ w: -1000, x: 300, y: 880 });
      expect(r.font.vertical(1)).toEqual({ w: -1000, x: 250, y: 880 });
    });

    it('explicit DW2, W2 array form and range form', () => {
      const r = run(
        type0('Identity-V', {
          DW: 800,
          W: [10, [401, 601], 20, 22, 301],
          DW2: [900, -1100],
          W2: [10, [-700, 111, 222, -800, 333, 444], 20, 22, -650, 55, 66, 30, [-900.4, 12.5, 7]],
        }),
        `${hex(bytes)} Tj`,
      );
      const cmp = compareVertical(r, bytes);
      expect(cmp.drawn).toBe(9);
      expect(cmp.mismatches).toEqual([]);
      expect(r.font.vertical(10)).toEqual({ w: -700, x: 111, y: 222 });
      expect(r.font.vertical(11)).toEqual({ w: -800, x: 333, y: 444 });
      expect(r.font.vertical(21)).toEqual({ w: -650, x: 55, y: 66 });
      expect(r.font.vertical(30)).toEqual({ w: -900, x: 13, y: 7 });
      expect(r.font.vertical(1)).toEqual({ w: -1100, x: 400, y: 900 });
    });

    it('if W2 exceeds the short range it is truncated to a C short (wrapping)', () => {
      const r = run(
        type0('Identity-V', { DW: 500, DW2: [40000, -40000], W2: [1, [70000, 1, 2]] }),
        `${hex(be16(1, 2))} Tj`,
      );
      expect(compareVertical(r, be16(1, 2)).mismatches).toEqual([]);
    });
  });

  describe('embedded CMap stream', () => {
    const cmapStream =
      (body: string, dict: Record<string, unknown> = {}) =>
      (doc: mupdf.PDFDocument) =>
        doc.addStream(
          `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Foo def /CMapType 1 def ${body} endcmap end end`,
          { Type: 'CMap', CMapName: 'Foo', CIDSystemInfo: cidSystemInfo(doc), ...dict },
        );
    const mixed = `1 begincodespacerange <00> <7F> endcodespacerange
      1 begincodespacerange <8000> <FFFF> endcodespacerange
      2 begincidrange <00> <7F> 0 <8000> <80FF> 1000 endcidrange
      1 begincidchar <8140> 5000 endcidchar`;
    const W = [1, [100, 200, 300], 1000, 1002, 450, 5000, [999]];

    it('mixed 1/2-byte codespace + cidrange/cidchar: splitting, CIDs and widths match MuPDF', () => {
      const bytes = Uint8Array.from([
        0x01, 0x02, 0x03, 0x80, 0x00, 0x80, 0x01, 0x81, 0x40, 0x41, 0x90,
      ]);
      const r = run(type0(cmapStream(mixed), { DW: 500, W }), `${hex(bytes)} Tj`);
      expect(r.font.unresolved).toEqual([]);
      expect(r.font.decode(bytes).map((c) => [c.code, c.length])).toEqual([
        [1, 1],
        [2, 1],
        [3, 1],
        [0x8000, 2],
        [0x8001, 2],
        [0x8140, 2],
        [0x41, 1],
        [0, 1], // the trailing 0x90: not in the 1-byte codespace (00-7F) and no byte follows
      ]);
      expect(r.font.cid(0x8001)).toBe(1001);
      expect(r.font.cid(0x8140)).toBe(5000);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(8);
      expect(cmp.mismatches).toEqual([]);
    });

    it('a code with no mapping (CID -1) has neither a glyph nor an advance', () => {
      const body = `1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <00> <0F> 0 endcidrange`;
      const bytes = Uint8Array.from([0x01, 0x20, 0x02, 0x30]);
      const r = run(type0(cmapStream(body), { DW: 500 }), `${hex(bytes)} Tj`);
      expect(r.font.cid(0x20)).toBe(-1);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(2);
      expect(cmp.mismatches).toEqual([]);
    });

    it('a later-defined range overrides the overlapping part (range within range, cidrange after cidchar)', () => {
      const bodies = [
        `1 begincodespacerange <00> <FF> endcodespacerange 2 begincidrange <41> <50> 100 <45> <46> 900 endcidrange`,
        `1 begincodespacerange <00> <FF> endcodespacerange 2 begincidrange <45> <46> 900 <41> <50> 100 endcidrange`,
        `1 begincodespacerange <00> <FF> endcodespacerange 1 begincidchar <41> 3 endcidchar 1 begincidrange <41> <42> 7 endcidrange`,
        `1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <50> <41> 100 endcidrange`,
      ];
      const bytes = Uint8Array.from([0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x50]);
      for (const body of bodies) {
        const r = run(type0(cmapStream(body), { DW: 500, W: [0, 2000, 10] }), `${hex(bytes)} Tj`);
        const cmp = compareHorizontal(r, bytes);
        expect(cmp.mismatches, body).toEqual([]);
        expect(r.shown.map((g) => g.x).length).toBe(cmp.drawn);
      }
      const r = run(type0(cmapStream(bodies[0]!), { DW: 500 }), `${hex(bytes)} Tj`);
      expect([0x41, 0x44, 0x45, 0x46, 0x47].map((c) => r.font.cid(c))).toEqual([
        100, 103, 900, 901, 106,
      ]);
    });

    it('if there is no codespace but there are mapping ranges, a 2-byte <0000>-<FFFF> is inserted', () => {
      const bytes = Uint8Array.from([0x00, 0x41, 0x42, 0x43, 0x44]);
      const r = run(
        type0(cmapStream('1 begincidrange <0000> <FFFF> 0 endcidrange'), {
          DW: 500,
          W: [0, 2000, 10],
        }),
        `${hex(bytes)} Tj`,
      );
      expect(r.font.decode(bytes).map((c) => c.length)).toEqual([2, 2, 1]);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(3);
      expect(cmp.mismatches).toEqual([]);
    });

    it('/Identity-H usecmap: inherits the codespace (when there are no ranges), unfound codes go through usecmap', () => {
      const bytes = Uint8Array.from([0x00, 0x41, 0x00, 0x43, 0x00]);
      const r = run(
        type0(cmapStream('/Identity-H usecmap 1 begincidrange <41> <42> 100 endcidrange'), {
          DW: 500,
          W: [0, 2000, 10],
        }),
        `${hex(bytes)} Tj`,
      );
      expect(r.font.unresolved).toEqual([]);
      expect(r.font.cid(0x41)).toBe(100);
      expect(r.font.cid(0x43)).toBe(0x43);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(3);
      expect(cmp.mismatches).toEqual([]);
    });

    it('if a 1-byte codespace is added after /Identity-H usecmap, the shorter one matches first', () => {
      const body =
        '/Identity-H usecmap 1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <41> <42> 100 endcidrange';
      const bytes = Uint8Array.from([0x41, 0x42, 0x43, 0x00, 0x44, 0x00]);
      const r = run(type0(cmapStream(body), { DW: 500, W: [0, 2000, 10] }), `${hex(bytes)} Tj`);
      expect(r.font.decode(bytes).every((c) => c.length === 1)).toBe(true);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(6);
      expect(cmp.mismatches).toEqual([]);
    });

    it('the dictionary /UseCMap name (Identity-H) is also used as a fallback', () => {
      const bytes = Uint8Array.from([0x00, 0x41, 0x00, 0x43]);
      const r = run(
        type0(cmapStream('1 begincidrange <41> <42> 100 endcidrange', { UseCMap: 'Identity-H' }), {
          DW: 500,
        }),
        `${hex(bytes)} Tj`,
      );
      expect(r.font.cid(0x43)).toBe(0x43);
      expect(compareHorizontal(r, bytes).mismatches).toEqual([]);
    });

    it('WMode: the dictionary value if present, otherwise the body', () => {
      const bytes = Uint8Array.from([0x01, 0x02, 0x80, 0x00]);
      const cases: [string, Record<string, unknown>, 0 | 1][] = [
        ['/WMode 1 def', {}, 1],
        ['', { WMode: 1 }, 1],
        ['/WMode 0 def', { WMode: 1 }, 1],
        ['/WMode 1 def', { WMode: 0 }, 0],
        ['', {}, 0],
      ];
      for (const [def, dict, wmode] of cases) {
        const r = run(
          type0(cmapStream(`${def} ${mixed}`, dict), { DW: 500, W }),
          `${hex(bytes)} Tj`,
        );
        expect(r.font.wmode, `${def} ${JSON.stringify(dict)}`).toBe(wmode);
        const cmp = wmode === 1 ? compareVertical(r, bytes) : compareHorizontal(r, bytes);
        expect(cmp.drawn).toBe(3);
        expect(cmp.mismatches).toEqual([]);
      }
    });

    it('a usecmap name MuPDF cannot read is ignored and remains in unresolved', () => {
      const body = `/Nonexistent-H usecmap 1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <41> <42> 100 endcidrange`;
      const bytes = Uint8Array.from([0x41, 0x43]);
      const r = run(type0(cmapStream(body), { DW: 500 }), `${hex(bytes)} Tj`);
      expect(r.font.unresolved.length).toBe(1);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(1);
      expect(cmp.mismatches).toEqual([]);
    });

    it('usecmap of a predefined CMap inherits the codespace (no ranges) and the CID is a placeholder', () => {
      const bytes = Uint8Array.from([0x41, 0x43, 0x81, 0x40, 0x20, 0xa1]);
      const r = run(type0(cmapStream('/90ms-RKSJ-H usecmap'), { DW: 500 }), `${hex(bytes)} Tj`);
      expect(r.font.decode(bytes).map((c) => c.length)).toEqual([1, 1, 2, 1, 1]);
      // Widths are uniform (no W), so widths are right even without knowing the CID
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareHorizontal(r, bytes);
      expect(cmp.drawn).toBe(5);
      expect(cmp.mismatches).toEqual([]);
    });
  });

  describe('random comparison (fixed seed)', () => {
    /** Linear congruential generator */
    const prng = (seed: number) => () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    it('even with overlapping cidrange/cidchar stacked at random, the CID of every code equals the MuPDF one', () => {
      for (let seed = 1; seed <= 25; seed++) {
        const rnd = prng(seed);
        const ri = (n: number) => Math.floor(rnd() * n);
        const items: string[] = [];
        for (let k = 0, n = 5 + ri(25); k < n; k++) {
          const lo = ri(256);
          const hi = rnd() < 0.3 ? lo : Math.min(255, lo + ri(60));
          const h = (v: number) => v.toString(16).padStart(2, '0');
          items.push(
            rnd() < 0.2
              ? `1 begincidchar <${h(lo)}> ${ri(300)} endcidchar`
              : `1 begincidrange <${h(lo)}> <${h(hi)}> ${ri(200)} endcidrange`,
          );
        }
        const body = `1 begincodespacerange <00> <FF> endcodespacerange ${items.join(' ')}`;
        // Width = 100 + CID, so the CID can be derived from MuPDF's advance
        const widths = Array.from({ length: 600 }, (_, i) => 100 + i);
        const cmap = (doc: mupdf.PDFDocument) =>
          doc.addStream(
            `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Foo def /CMapType 1 def ${body} endcmap end end`,
            { Type: 'CMap', CMapName: 'Foo', CIDSystemInfo: cidSystemInfo(doc) },
          );
        const bytes = Uint8Array.from(range(0, 255));
        const r = run(type0(cmap, { DW: 50, W: [0, widths] }), `${hex(bytes)} Tj`);
        const cmp = compareHorizontal(r, bytes);
        expect(cmp.mismatches, `seed ${seed}: ${body}`).toEqual([]);
        // If the same code resolved to the same CID as MuPDF, the width (100+CID) is also the same. A code with no mapping is -1
        const mapped = range(0, 255).filter((c) => r.font.cid(c) >= 0).length;
        expect(r.shown.length).toBe(mapped);
      }
    });

    it('widths of a random /W (entries with distinct start CIDs, overlaps allowed) equal those of MuPDF', () => {
      for (let seed = 1; seed <= 25; seed++) {
        const rnd = prng(1000 + seed);
        const ri = (n: number) => Math.floor(rnd() * n);
        const used = new Set<number>();
        const W: unknown[] = [];
        for (let k = 0, n = 3 + ri(12); k < n; k++) {
          let c0 = ri(280);
          while (used.has(c0)) c0 = (c0 + 1) % 280;
          used.add(c0);
          if (rnd() < 0.5) {
            // The array form creates an entry for each c0+j: the length is taken only until an already-used start CID is reached
            const ws: number[] = [];
            for (let j = 0, len = 1 + ri(8); j < len && (j === 0 || !used.has(c0 + j)); j++) {
              ws.push(ri(1500) - 100);
              used.add(c0 + j);
            }
            W.push(c0, ws);
          } else {
            W.push(c0, c0 + ri(60), ri(1500) - 100);
          }
        }
        const bytes = be16(...range(0, 299));
        const r = run(type0('Identity-H', { DW: 321, W }), `${hex(bytes)} Tj`);
        expect(r.font.unresolved, JSON.stringify(W)).toEqual([]);
        const cmp = compareHorizontal(r, bytes);
        expect(cmp.mismatches, `seed ${seed}: ${JSON.stringify(W)}`).toEqual([]);
      }
    });
  });

  describe('predefined CMap', () => {
    // Code sequences actually mapped by each CMap (mixed 1/2 bytes)
    const samples: [string, number[]][] = [
      ['KSCms-UHC-H', [0x41, 0x42, 0xb0, 0xa1, 0x81, 0x41, 0xc8, 0xfe, 0x20]],
      ['KSC-EUC-H', [0x41, 0xb0, 0xa1, 0xc8, 0xfe, 0x42]],
      ['KSCpc-EUC-H', [0x41, 0xb0, 0xa1, 0xc8, 0xfe, 0x42]],
      ['UniKS-UCS2-H', [0x00, 0x41, 0xac, 0x00, 0xd7, 0xa3]],
      ['90ms-RKSJ-H', [0x41, 0x81, 0x40, 0xa1, 0x88, 0x9f, 0xe0, 0x40, 0x20]],
      ['90msp-RKSJ-H', [0x41, 0x81, 0x40, 0xa1, 0x88, 0x9f]],
      ['EUC-H', [0x41, 0xa4, 0xa2, 0x8e, 0xb1]],
      ['GBK-EUC-H', [0x41, 0x81, 0x40, 0xb0, 0xa1, 0xfe, 0xa0]],
      ['GB-EUC-H', [0x41, 0xb0, 0xa1, 0xa1, 0xa1]],
      ['ETen-B5-H', [0x41, 0xa4, 0x40, 0xa4, 0xa1, 0xf9, 0xd5]],
      ['B5pc-H', [0x41, 0xa4, 0x40, 0xa4, 0xa1]],
      ['UniGB-UCS2-H', [0x00, 0x41, 0x4e, 0x00, 0x96, 0x32]],
      ['UniCNS-UCS2-H', [0x00, 0x41, 0x4e, 0x00]],
      ['UniJIS-UCS2-H', [0x00, 0x41, 0x30, 0x42, 0x4e, 0x00]],
      ['UniJIS-UTF16-H', [0x00, 0x41, 0x30, 0x42, 0xd8, 0x40, 0xdc, 0x0b]],
      ['UniKS-UTF16-H', [0x00, 0x41, 0xac, 0x00]],
      ['UniGB-UTF16-H', [0x00, 0x41, 0x4e, 0x00]],
      // Same boundaries as the Adobe distribution (code sequences for which MuPDF 1.28.1 was confirmed via Device to split that way)
      ['B5pc-H', [0xfd, 0xfe, 0x41]],
      ['GBpc-EUC-H', [0xfd, 0x41]],
      ['83pv-RKSJ-H', [0xfd, 0x41]],
      ['KSCpc-EUC-H', [0xfe, 0x41, 0xa1, 0x41, 0x41]],
      ['CNS-EUC-H', [0x8e, 0xa1, 0xa1, 0xa1, 0x41, 0x8e, 0xa4, 0xa1, 0xa1, 0x8e, 0xa7, 0xa1, 0xa1]],
    ];
    for (const [name, raw] of samples) {
      it(`${name}: code splitting matches MuPDF (uniform widths -> unresolved is empty)`, () => {
        const bytes = Uint8Array.from(raw);
        const r = run(type0(name, { DW: 777 }, {}), `${hex(bytes)} Tj`);
        const codes = r.font.decode(bytes);
        expect(codes.reduce((s, c) => s + c.length, 0)).toBe(bytes.length);
        const cmp = compareHorizontal(r, bytes);
        expect(cmp.mismatches, name).toEqual([]);
        expect(r.font.wmode).toBe(0);
        expect(r.font.unresolved.filter((u) => !u.includes('추정'))).toEqual([]);
      });
    }

    it('every name in the table (-H/-V) is read by MuPDF, and a name not in the table is not read by MuPDF either', () => {
      const bad: string[] = [];
      let checked = 0;
      for (const base of Object.keys(PREDEFINED_CMAP_CODESPACES)) {
        for (const dir of ['H', 'V']) {
          const name = base === '' ? dir : `${base}-${dir}`;
          const mine = lookupPredefinedCMap(name) !== null;
          const first = PREDEFINED_CMAP_CODESPACES[base]!.codespaces[0]!;
          const sample =
            first.n === 1
              ? [0x41]
              : first.low === 0
                ? [0x00, 0x41]
                : [first.low >> 8, first.low & 255];
          const r = run(type0(name, { DW: 777 }), `${hex(Uint8Array.from(sample))} Tj`);
          const loaded = r.font.fallbackReason === undefined;
          // If MuPDF read it, the glyph (if any) is in the 'Foo' font; if not, hail-mary (font name '')
          const mupdfLoaded = r.shown.length > 0 ? r.shown.every((g) => g.font === 'Foo') : loaded;
          checked++;
          if (mine !== loaded || mupdfLoaded !== loaded)
            bad.push(`${name}: 표 ${mine} / 로드 ${loaded} / MuPDF ${mupdfLoaded}`);
        }
      }
      for (const name of [
        'UniKS-UTF32-H',
        'UniJISX0213-UTF32-H',
        '78-H',
        'KSC-H',
        'KSC-Johab-H',
        'Hankaku-H',
        '83pv-RKSJ-V',
        'KSCpc-EUC-V',
        'Foo-H',
      ]) {
        const r = run(type0(name, { DW: 777 }), `${hex(Uint8Array.from([0x41, 0x42]))} Tj`);
        if (r.font.fallbackReason === undefined || r.shown.some((g) => g.font === 'Foo'))
          bad.push(`${name}: 읽히면 안 됨`);
        checked++;
      }
      expect(checked).toBeGreaterThan(60);
      expect(bad).toEqual([]);
    });

    it('-V names have wmode 1, and with uniform widths the vertical metrics are exact too', () => {
      const bytes = Uint8Array.from([0x41, 0xb0, 0xa1, 0x42]);
      const r = run(type0('KSCms-UHC-V', { DW: 777 }), `${hex(bytes)} Tj`);
      expect(r.font.wmode).toBe(1);
      expect(r.font.unresolved).toEqual([]);
      const cmp = compareVertical(r, bytes);
      expect(cmp.drawn).toBe(3);
      expect(cmp.mismatches).toEqual([]);
      expect(r.font.vertical(5)).toEqual({ w: -1000, x: 388, y: 880 });
    });

    it('if widths are not uniform (W has values different from DW), the CID mapping is unknown, so unresolved', () => {
      const r = run(
        type0('KSCms-UHC-H', { DW: 777, W: [1, [500]] }),
        `${hex(Uint8Array.from([0x41]))} Tj`,
      );
      expect(r.font.unresolved.length).toBeGreaterThan(0);
      const same = run(
        type0('KSCms-UHC-H', { DW: 777, W: [1, [777, 777]] }),
        `${hex(Uint8Array.from([0x41]))} Tj`,
      );
      expect(same.font.unresolved).toEqual([]);
    });

    it('UCS2/UTF16 CMaps do not accept D800-DFFF as a 2-byte code (code 0 byte by byte)', () => {
      const bytes = Uint8Array.from([0xd8, 0x00, 0x00, 0x41, 0x00, 0x42]);
      for (const name of ['UniKS-UCS2-H', 'UniGB-UTF16-H']) {
        const r = run(type0(name, { DW: 777 }), `${hex(bytes)} Tj`);
        expect(
          r.font.decode(bytes).map((c) => [c.code, c.length]),
          name,
        ).toEqual([
          [0, 1],
          [0, 2],
          [0x4100, 2],
          [0, 1],
        ]);
      }
      // For this sequence MuPDF draws 0 glyphs with UniKS-UCS2-H (none of the four codes are mapped) and only U+4100 with UniGB-UTF16-H
      expect(run(type0('UniKS-UCS2-H', { DW: 777 }), `${hex(bytes)} Tj`).shown.length).toBe(0);
      expect(run(type0('UniGB-UTF16-H', { DW: 777 }), `${hex(bytes)} Tj`).shown.length).toBe(1);
    });

    it('UTF16 CMap: a surrogate pair is a 4-byte code', () => {
      const font = new FontCache(new mupdf.PDFDocument()).load(null);
      expect(font.decode(Uint8Array.from([0xd8, 0x40, 0xdc, 0x0b])).length).toBe(4); // hail-mary goes byte by byte
      const r = run(
        type0('UniJIS-UTF16-H', { DW: 777 }),
        `${hex(Uint8Array.from([0x00, 0x41, 0xd8, 0x40, 0xdc, 0x0b]))} Tj`,
      );
      expect(
        r.font.decode(Uint8Array.from([0x00, 0x41, 0xd8, 0x40, 0xdc, 0x0b])).map((c) => c.length),
      ).toEqual([2, 4]);
    });
  });

  describe('cases where MuPDF fails to load the font and falls back to hail-mary', () => {
    const bytes = Uint8Array.from([0x00, 0x41, 0x00, 0x42, 0x80, 0xff]);
    const cases: [string, (doc: mupdf.PDFDocument) => mupdf.PDFObject, string][] = [
      ['MuPDF 가 모르는 CMap 이름', type0('Foo-H'), 'Foo-H'],
      ['MuPDF 에 없는 사전 정의 CMap(UniKS-UTF32-H)', type0('UniKS-UTF32-H'), 'UniKS-UTF32-H'],
      [
        'CID 폰트에 FontDescriptor 없음',
        type0('Identity-H', {}, { noDescriptor: true }),
        'FontDescriptor',
      ],
      [
        'CID 폰트 Subtype 이 이상함',
        type0('Identity-H', {}, { dfontSubtype: 'TrueType' }),
        'TrueType',
      ],
      [
        'DescendantFonts 없음',
        (doc) =>
          doc.addObject({
            Type: 'Font',
            Subtype: 'Type0',
            BaseFont: 'Foo',
            Encoding: 'Identity-H',
          }),
        'DescendantFonts',
      ],
    ];
    for (const [label, make, reason] of cases) {
      it(label, () => {
        const r = run(make, `${hex(bytes)} Tj`);
        expect(r.font.fallbackReason).toContain(reason);
        expect(r.font.unresolved).toEqual([]);
        expect(r.shown.every((g) => g.font === '')).toBe(true);
        expect(r.font.decode(bytes).length).toBe(bytes.length);
        const cmp = compareHorizontal(r, bytes, true);
        expect(cmp.drawn).toBe(bytes.length);
        expect(cmp.mismatches).toEqual([]);
      });
    }
  });
});
