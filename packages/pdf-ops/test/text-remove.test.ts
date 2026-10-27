import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMap, removeTextShowOps } from '../src/index.js';

/** A7-2 verification: the position of characters after the erased operation stays the same, and the remaining bytes of the stream are preserved. */
const CONTENT = [
  'BT /F1 12 Tf 72 700 Td (Remove me) Tj ( keep) Tj 0 -14 Td (Second line) Tj ET',
  'BT /F1 11 Tf 1.5 Tc 2 Tw 90 Tz 72 650 Td [(Kern) -250 (ed text)] TJ (after) Tj ET',
  'BT /F1 10 Tf 14 TL 72 600 Td (first) Tj (quote line) \' (tail) Tj 3 1 (dq line) " (tail2) Tj ET',
].join('\n');
const REMOVE = ['Remove me', 'Kerned text', 'quote line', 'dq line'];
const KEEP = [' keep', 'Second line', 'after', 'first', 'tail', 'tail2'];

function makeDoc(): mupdf.PDFDocument {
  const src = new mupdf.PDFDocument();
  const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
  src.insertPage(-1, src.addPage([0, 0, 612, 792], 0, { Font: { F1 } }, CONTENT));
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

/** Characters and origins of structured text (page space). */
function charsOf(doc: mupdf.PDFDocument): { c: string; x: number; y: number }[] {
  const out: { c: string; x: number; y: number }[] = [];
  doc
    .loadPage(0)
    .toStructuredText('preserve-whitespace')
    .walk({ onChar: (c, origin) => out.push({ c, x: origin[0], y: origin[1] }) });
  return out;
}

const opText = (op: { text?: { glyphs: { code: number }[] } }) =>
  String.fromCharCode(...(op.text?.glyphs.map((g) => g.code) ?? []));

describe('removeTextShowOps (A7-2): SourceMap-based text removal', () => {
  it('origins of the remaining characters stay the same even after erasing Tj, TJ (adjustment, Tc, Tw, Tz), \' and "', () => {
    const doc = makeDoc();
    const before = charsOf(doc);
    const map = buildSourceMap(doc, 0);
    const targets = map.ops.filter((o) => o.kind === 'text-show' && REMOVE.includes(opText(o)));
    expect(targets.map(opText).sort()).toEqual([...REMOVE].sort());
    const r = removeTextShowOps(
      doc,
      map,
      targets.map((o) => o.id),
    );
    expect(r.skipped).toEqual([]);
    expect(r.removed).toHaveLength(4);

    const after = charsOf(doc);
    const text = after.map((x) => x.c).join('');
    for (const s of REMOVE) expect(text).not.toContain(s.replace(/ /g, ''));
    // The origins of the remaining characters must all be the same (only the erased characters are gone).
    for (const word of KEEP) {
      const find = (list: typeof before) => {
        const s = list.map((x) => x.c).join('');
        const i = s.indexOf(word);
        return i < 0 ? null : list.slice(i, i + word.length);
      };
      const a = find(before);
      const b = find(after);
      expect(b, word).not.toBeNull();
      for (let i = 0; i < word.length; i++) {
        expect(b![i]!.x, `${word}[${i}].x`).toBeCloseTo(a![i]!.x, 3);
        expect(b![i]!.y, `${word}[${i}].y`).toBeCloseTo(a![i]!.y, 3);
      }
    }
  });

  it('content bytes outside the replaced operation stay as they are', () => {
    const doc = makeDoc();
    const map = buildSourceMap(doc, 0);
    const target = map.ops.find((o) => o.kind === 'text-show' && opText(o) === 'Remove me')!;
    const num = target.stream.objectNumber;
    const original = doc.newIndirect(num).readStream().asUint8Array().slice();
    removeTextShowOps(doc, map, [target.id]);
    const edited = doc.newIndirect(num).readStream().asUint8Array().slice();
    const [s, e] = target.range;
    expect(Buffer.from(edited.subarray(0, s)).equals(Buffer.from(original.subarray(0, s)))).toBe(
      true,
    );
    const tailLen = original.length - e;
    expect(
      Buffer.from(edited.subarray(edited.length - tailLen)).equals(
        Buffer.from(original.subarray(e)),
      ),
    ).toBe(true);
    expect(new TextDecoder().decode(edited.subarray(s, edited.length - tailLen))).toMatch(
      /^\[-?[\d.]+\] TJ$/,
    );
  });
});

// ---------------------------------------------------------------- M1 review fixes

type Doc = mupdf.PDFDocument;

function reopen(src: Doc): Doc {
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as Doc;
}

/** A document with Helvetica /F1 and extra resources on one page (saved and reopened). */
function onePage(content: string, extra: (src: Doc) => Record<string, unknown> = () => ({})): Doc {
  const src = new mupdf.PDFDocument();
  const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
  src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, { Font: { F1 }, ...extra(src) }, content));
  return reopen(src);
}

function pageChars(doc: Doc, index: number): { c: string; x: number; y: number }[] {
  const out: { c: string; x: number; y: number }[] = [];
  const page = doc.loadPage(index);
  const st = page.toStructuredText('preserve-whitespace');
  st.walk({ onChar: (c, origin) => out.push({ c, x: origin[0], y: origin[1] }) });
  st.destroy();
  page.destroy();
  return out;
}

const textOf = (doc: Doc, index: number) =>
  pageChars(doc, index)
    .map((x) => x.c)
    .join('');

const streamOf = (doc: Doc, num: number) => {
  const buf = doc.newIndirect(num).readStream();
  const s = new TextDecoder('latin1').decode(buf.asUint8Array());
  buf.destroy();
  return s;
};

const showOps = (doc: Doc, index = 0) =>
  buildSourceMap(doc, index).ops.filter((o) => o.kind === 'text-show');

/** Number of blue (0,0,255) pixels. */
function bluePixels(doc: Doc): number {
  const page = doc.loadPage(0);
  const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
  const p = pix.getPixels();
  let n = 0;
  for (let i = 0; i < p.length; i += 3) if (p[i]! < 50 && p[i + 1]! < 50 && p[i + 2]! > 200) n++;
  pix.destroy();
  page.destroy();
  return n;
}

describe('removeTextShowOps: clip text (Tr 4-7)', () => {
  it.each([4, 5, 6, 7])('Tr %i: skipped, stream unchanged (empty TJ removes the clip)', (tr) => {
    const doc = onePage(`q BT ${tr} Tr /F1 40 Tf 20 100 Td (Hi) Tj ET 0 0 1 rg 0 0 300 200 re f Q`);
    const map = buildSourceMap(doc, 0);
    const op = map.ops.find((o) => o.op === 'Tj')!;
    expect(op.limits).toContain('clip-text');
    const before = streamOf(doc, op.stream.objectNumber);
    const blue = bluePixels(doc);
    const r = removeTextShowOps(doc, map, [op.id]);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([
      { opId: op.id, code: 'clip-text', detail: `클립 텍스트(Tr ${tr})` },
    ]);
    expect(r.streams).toEqual([]);
    expect(streamOf(doc, op.stream.objectNumber)).toBe(before);
    expect(bluePixels(doc)).toBe(blue);
    expect(blue).toBeLessThan(300 * 200);
  });

  it('Tr 3 (invisible text) is erased', () => {
    const doc = onePage('BT 3 Tr /F1 12 Tf 20 100 Td (Hidden) Tj 0 Tr (Shown) Tj ET');
    const [hidden] = showOps(doc);
    const all = pageChars(doc, 0);
    const at = all
      .map((x) => x.c)
      .join('')
      .indexOf('Shown');
    const shownBefore = all.slice(at, at + 5);
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [hidden!.id]);
    expect(r.removed).toEqual([hidden!.id]);
    expect(textOf(doc, 0)).toBe('Shown');
    pageChars(doc, 0).forEach((x, i) => expect(x.x).toBeCloseTo(shownBefore[i]!.x, 3));
  });
});

describe('removeTextShowOps: shared content stream', () => {
  it('a stream shared with the /Contents array of another page is copied and only the slot of this page is changed', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    const add = (c: string) =>
      src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, { Font: { F1 } }, c));
    add('BT /F1 12 Tf 20 100 Td (Shared header) Tj ET');
    add('BT /F1 12 Tf 20 50 Td (Page two) Tj ET');
    const p1 = src.findPage(0);
    const p2 = src.findPage(1);
    const arr = src.newArray();
    arr.push(p1.get('Contents'));
    arr.push(p2.get('Contents'));
    p2.put('Contents', arr);
    const doc = reopen(src);
    expect(textOf(doc, 1)).toContain('Shared header');

    const map = buildSourceMap(doc, 0);
    const op = map.ops.find((o) => o.op === 'Tj')!;
    const num = op.stream.objectNumber;
    const original = streamOf(doc, num);
    const r = removeTextShowOps(doc, map, [op.id]);
    expect(r.removed).toEqual([op.id]);
    expect(r.streams).toHaveLength(1);
    expect(r.streams[0]).not.toBe(num);
    expect(r.copied).toEqual([{ contentsIndex: 0, from: num, to: r.streams[0] }]);
    expect(streamOf(doc, num)).toBe(original);
    expect(textOf(doc, 0).trim()).toBe('');
    expect(textOf(doc, 1)).toContain('Shared header');
    expect(textOf(doc, 1)).toContain('Page two');
    // The same holds after saving and reopening.
    const saved = reopen(doc);
    expect(textOf(saved, 0).trim()).toBe('');
    expect(textOf(saved, 1)).toContain('Shared header');
  });

  it('a stream appearing twice in the same /Contents array: only the erased slot is replaced with a copy', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, { Font: { F1 } }, 'q 1 0 0 1 0 50 cm'));
    const page = src.findPage(0);
    const s = src.addStream('BT /F1 12 Tf 20 100 Td (Twice) Tj ET', {});
    const arr = src.newArray();
    arr.push(page.get('Contents'));
    arr.push(s);
    arr.push(src.addStream('Q', {}));
    arr.push(s);
    page.put('Contents', arr);
    const doc = reopen(src);
    const before = pageChars(doc, 0);
    expect(before.map((x) => x.c).join('')).toBe('TwiceTwice');

    // Erase only the first slot (the one moved up by 50).
    const ops = showOps(doc);
    expect(ops.map((o) => o.stream.contentsIndex)).toEqual([1, 3]);
    expect(ops[0]!.stream.objectNumber).toBe(ops[1]!.stream.objectNumber);
    const num = ops[0]!.stream.objectNumber;
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [ops[0]!.id]);
    expect(r.copied).toEqual([{ contentsIndex: 1, from: num, to: r.streams[0] }]);
    const contents = doc.findPage(0).get('Contents');
    expect(contents.get(1).asIndirect()).toBe(r.streams[0]);
    expect(contents.get(3).asIndirect()).toBe(num);
    const after = pageChars(doc, 0);
    expect(after.map((x) => x.c).join('')).toBe('Twice');
    // The remaining characters are at the original position drawn by the second slot.
    after.forEach((x, i) => {
      expect(x.x).toBeCloseTo(before[5 + i]!.x, 3);
      expect(x.y).toBeCloseTo(before[5 + i]!.y, 3);
    });

    // It is no longer shared, so the remaining slot is fixed in place.
    const rest = showOps(doc).find((o) => o.stream.contentsIndex === 3)!;
    const r2 = removeTextShowOps(doc, buildSourceMap(doc, 0), [rest.id]);
    expect(r2.copied).toEqual([]);
    expect(r2.streams).toEqual([num]);
    expect(textOf(doc, 0).trim()).toBe('');
  });

  it('erasing two slots of the same stream at once makes a copy for each slot and leaves the original as it is', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, { Font: { F1 } }, ''));
    const page = src.findPage(0);
    const s = src.addStream('BT /F1 12 Tf 20 100 Td (Dup) Tj ET', {});
    const arr = src.newArray();
    arr.push(s);
    arr.push(s);
    page.put('Contents', arr);
    const doc = reopen(src);
    const ops = showOps(doc);
    const num = ops[0]!.stream.objectNumber;
    const original = streamOf(doc, num);
    const r = removeTextShowOps(
      doc,
      buildSourceMap(doc, 0),
      ops.map((o) => o.id),
    );
    expect(r.removed).toHaveLength(2);
    expect(r.copied.map((c) => c.contentsIndex).sort()).toEqual([0, 1]);
    expect(new Set(r.streams).size).toBe(2);
    expect(streamOf(doc, num)).toBe(original);
    expect(textOf(doc, 0).trim()).toBe('');
  });

  it('if two pages use the same indirect /Contents array, only this page is switched to a new array', () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    for (let i = 0; i < 2; i++) {
      src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, { Font: { F1 } }, ''));
    }
    const s1 = src.addStream('BT /F1 12 Tf 20 100 Td (Head) Tj ET', {});
    const s2 = src.addStream('BT /F1 12 Tf 20 50 Td (Body) Tj ET', {});
    const shared = src.addObject([s1, s2]);
    src.findPage(0).put('Contents', shared);
    src.findPage(1).put('Contents', shared);
    const doc = reopen(src);
    const head = showOps(doc).find((o) => o.stream.contentsIndex === 0)!;
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [head.id]);
    expect(r.copied).toHaveLength(1);
    expect(textOf(doc, 0)).toBe('Body');
    expect(textOf(doc, 1)).toBe('HeadBody');
    expect(doc.findPage(1).get('Contents').isIndirect()).toBe(true);
    expect(doc.findPage(0).get('Contents').isIndirect()).toBe(false);
  });
});

describe('removeTextShowOps: specified width, code and font guards', () => {
  it('fractional /Widths: TJ numbers are computed with the specified width (real), not the MuPDF integer width', () => {
    const doc = onePage('BT /W 12 Tf 20 100 Td (aaaaaaaaaaaaaaaaaaaa) Tj (X) Tj ET', (src) => ({
      Font: {
        W: src.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
          FirstChar: 97,
          LastChar: 97,
          Widths: [556.4],
        }),
      },
    }));
    const xOf = () => pageChars(doc, 0).find((x) => x.c === 'X')!.x;
    const xBefore = xOf();
    const op = showOps(doc)[0]!;
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [op.id]);
    expect(r.removed).toEqual([op.id]);
    const n = Number(/\[(-?[\d.]+)\] TJ/.exec(streamOf(doc, op.stream.objectNumber))![1]);
    expect(n).toBeCloseTo(-20 * 556.4, 2);
    // MuPDF draws with the width rounded to 556, so the MuPDF render X moves by the rounding error (20 x 0.4/1000 x 12 pt).
    expect(xOf() - xBefore).toBeCloseTo((20 * 0.4 * 12) / 1000, 3);
  });

  it('Tw is added only to 1-byte code 32 (including a Type0 1-byte codespace, excluding 2-byte 0x0020)', () => {
    const cmap = (src: Doc) =>
      src.addStream(
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /One def ' +
          '1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <20> <7E> 1 endcidrange endcmap end end',
        { Type: 'CMap', CMapName: 'One' },
      );
    const type0 = (src: Doc, encoding: unknown) =>
      src.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Foo',
        Encoding: encoding,
        DescendantFonts: [
          src.addObject({
            Type: 'Font',
            Subtype: 'CIDFontType2',
            BaseFont: 'Foo',
            CIDSystemInfo: {
              Registry: src.newString('Adobe'),
              Ordering: src.newString('Identity'),
              Supplement: 0,
            },
            FontDescriptor: src.addObject({
              Type: 'FontDescriptor',
              FontName: 'Foo',
              Flags: 4,
              FontBBox: [0, 0, 1000, 1000],
              ItalicAngle: 0,
              Ascent: 800,
              Descent: -200,
              CapHeight: 700,
              StemV: 80,
            }),
            DW: 500,
          }),
        ],
      });
    const doc = onePage(
      'BT /T1 10 Tf 5 Tw 20 100 Td (A B) Tj (X) Tj ET BT /T2 10 Tf 5 Tw 20 50 Td <004100200042> Tj <0058> Tj ET',
      (src) => ({ Font: { T1: type0(src, cmap(src)), T2: type0(src, 'Identity-H') } }),
    );
    // Origins of the two (X) Tj that follow (SourceMap computes with the same integer widths as MuPDF).
    const xs = () =>
      showOps(doc)
        .filter((o) => o.text!.glyphs.length === 1 && o.text!.glyphs[0]!.code === 0x58)
        .map((o) => o.text!.glyphs[0]!.origin[0]);
    const before = xs();
    expect(before).toHaveLength(2);
    const ops = showOps(doc).filter((o) => o.text!.glyphs.length === 3);
    const r = removeTextShowOps(
      doc,
      buildSourceMap(doc, 0),
      ops.map((o) => o.id),
    );
    expect(r.skipped).toEqual([]);
    expect(r.removed).toHaveLength(2);
    const after = xs();
    expect(after).toHaveLength(2);
    after.forEach((x, i) => expect(x).toBeCloseTo(before[i]!, 3));
  });

  it('an operation with a code that has no CID mapping is skipped (MuPDF does not advance, spec viewers use the CID 0 width)', () => {
    const doc = onePage('BT /T 10 Tf 20 100 Td (AaB) Tj (AB) Tj ET', (src) => ({
      Font: {
        T: src.addObject({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: 'Foo',
          Encoding: src.addStream(
            '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Up def ' +
              '1 begincodespacerange <00> <FF> endcodespacerange 1 begincidrange <41> <5A> 1 endcidrange endcmap end end',
            { Type: 'CMap', CMapName: 'Up' },
          ),
          DescendantFonts: [
            src.addObject({
              Type: 'Font',
              Subtype: 'CIDFontType2',
              BaseFont: 'Foo',
              CIDSystemInfo: {
                Registry: src.newString('Adobe'),
                Ordering: src.newString('Identity'),
                Supplement: 0,
              },
              FontDescriptor: src.addObject({ Type: 'FontDescriptor', FontName: 'Foo', Flags: 4 }),
              DW: 600,
            }),
          ],
        }),
      },
    }));
    const [mixed, mapped] = showOps(doc);
    expect(mixed!.limits).not.toContain('font-encoding-unresolved');
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [mixed!.id, mapped!.id]);
    expect(r.removed).toEqual([mapped!.id]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.opId).toBe(mixed!.id);
    expect(r.skipped[0]!.code).toBe('cid-unmapped');
    expect(r.skipped[0]!.detail).toMatch(/^CID 매핑 없는 코드/);
  });

  it('a font that MuPDF failed to load and replaced (hail-mary) is skipped', () => {
    const doc = onePage('BT /H 10 Tf 20 100 Td (AB) Tj ET', (src) => ({
      Font: {
        H: src.addObject({
          Type: 'Font',
          Subtype: 'Type0',
          BaseFont: 'Foo',
          Encoding: 'No-Such-CMap-H',
          DescendantFonts: [src.addObject({ Type: 'Font', Subtype: 'CIDFontType2' })],
        }),
      },
    }));
    const map = buildSourceMap(doc, 0);
    const op = map.ops.find((o) => o.op === 'Tj')!;
    expect(op.limits).toContain('font-encoding-unresolved');
    expect(removeTextShowOps(doc, map, [op.id]).skipped).toEqual([
      {
        opId: op.id,
        code: 'font-encoding-unresolved',
        detail: '편집 제한: font-encoding-unresolved',
      },
    ]);
    // Even without a limit mark, it is skipped for the font's own substitution reason.
    op.limits = [];
    const r = removeTextShowOps(doc, map, [op.id]);
    expect(r.removed).toEqual([]);
    expect(r.skipped[0]!.code).toBe('fallback-font');
    expect(r.skipped[0]!.detail).toMatch(/^MuPDF 대체 폰트/);
  });

  it('a page without /Font or without /Resources: skipped without an exception', () => {
    const src = new mupdf.PDFDocument();
    src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, {}, 'BT /F1 10 Tf 20 100 Td (AB) Tj ET'));
    src.insertPage(-1, src.addPage([0, 0, 300, 200], 0, {}, 'BT /F1 10 Tf 20 100 Td (CD) Tj ET'));
    src.findPage(1).delete('Resources');
    const doc = reopen(src);
    for (const index of [0, 1]) {
      const map = buildSourceMap(doc, index);
      const op = map.ops.find((o) => o.op === 'Tj')!;
      op.limits = [];
      const r = removeTextShowOps(doc, map, [op.id]);
      expect(r.removed).toEqual([]);
      expect(r.skipped).toEqual([
        { opId: op.id, code: 'no-font-resource', detail: '폰트 리소스 없음: F1' },
      ]);
    }
  });

  it('" is skipped when it has too few operands', () => {
    const doc = onePage('BT /F1 10 Tf 14 TL 20 100 Td (zero) " 5 (one) " 1 2 (two) " ET');
    const ops = showOps(doc);
    const r = removeTextShowOps(
      doc,
      buildSourceMap(doc, 0),
      ops.map((o) => o.id),
    );
    expect(r.removed).toEqual([ops[2]!.id]);
    expect(r.skipped).toEqual([
      { opId: ops[0]!.id, code: 'quote-operands', detail: '" 피연산자 부족' },
      { opId: ops[1]!.id, code: 'quote-operands', detail: '" 피연산자 부족' },
    ]);
  });

  it('operators inside a TJ array (Tw, Tc) differ per viewer, so they are skipped', () => {
    const doc = onePage('BT /F1 10 Tf 20 100 Td [(A) 5 Tw (B)] TJ ET');
    const op = showOps(doc)[0]!;
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [op.id]);
    expect(r.skipped).toEqual([
      { opId: op.id, code: 'tj-bad-token', detail: 'TJ 배열에 문자열·숫자 밖 토큰' },
    ]);
  });
});
