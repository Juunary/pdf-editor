import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { buildSourceMap, removeTextShowOps } from '../src/index.js';

/** A7-2 검증: 지운 연산 뒤의 글자 위치가 그대로이고, 스트림의 나머지 바이트가 보존된다. */
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

/** 구조화 텍스트의 글자와 원점(페이지 공간). */
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

describe('removeTextShowOps(A7-2): SourceMap 기반 텍스트 제거', () => {
  it('Tj·TJ(조정·Tc·Tw·Tz)·\'·" 를 지워도 남은 글자의 원점이 그대로다', () => {
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
    // 남은 글자는 원점이 모두 같아야 한다(지운 글자만 빠짐).
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

  it('교체한 연산 밖의 콘텐츠 바이트는 그대로다', () => {
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

// ---------------------------------------------------------------- M1 리뷰 반영

type Doc = mupdf.PDFDocument;

function reopen(src: Doc): Doc {
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as Doc;
}

/** 쪽 하나에 Helvetica /F1 과 추가 리소스를 둔 문서(저장·재오픈). */
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

/** 파란(0,0,255) 픽셀 수. */
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

describe('removeTextShowOps: 클립 텍스트(Tr 4–7)', () => {
  it.each([4, 5, 6, 7])('Tr %i: 건너뛰고 스트림을 바꾸지 않는다(빈 TJ 는 클립을 없앤다)', (tr) => {
    const doc = onePage(`q BT ${tr} Tr /F1 40 Tf 20 100 Td (Hi) Tj ET 0 0 1 rg 0 0 300 200 re f Q`);
    const map = buildSourceMap(doc, 0);
    const op = map.ops.find((o) => o.op === 'Tj')!;
    expect(op.limits).toContain('clip-text');
    const before = streamOf(doc, op.stream.objectNumber);
    const blue = bluePixels(doc);
    const r = removeTextShowOps(doc, map, [op.id]);
    expect(r.removed).toEqual([]);
    expect(r.skipped).toEqual([{ opId: op.id, reason: `클립 텍스트(Tr ${tr})` }]);
    expect(r.streams).toEqual([]);
    expect(streamOf(doc, op.stream.objectNumber)).toBe(before);
    expect(bluePixels(doc)).toBe(blue);
    expect(blue).toBeLessThan(300 * 200);
  });

  it('Tr 3(보이지 않는 텍스트)은 지운다', () => {
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

describe('removeTextShowOps: 공유 콘텐츠 스트림', () => {
  it('다른 쪽 /Contents 배열과 공유한 스트림은 사본을 만들어 이 쪽 칸만 바꾼다', () => {
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
    // 저장 후 다시 열어도 같다.
    const saved = reopen(doc);
    expect(textOf(saved, 0).trim()).toBe('');
    expect(textOf(saved, 1)).toContain('Shared header');
  });

  it('같은 /Contents 배열에 두 번 나오는 스트림: 지운 칸만 사본으로 바꾼다', () => {
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

    // 첫 칸(위로 50 옮긴 것)만 지운다.
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
    // 남은 글자는 두 번째 칸이 그린 원래 위치 그대로다.
    after.forEach((x, i) => {
      expect(x.x).toBeCloseTo(before[5 + i]!.x, 3);
      expect(x.y).toBeCloseTo(before[5 + i]!.y, 3);
    });

    // 이제 공유가 아니므로 남은 칸은 제자리에서 고친다.
    const rest = showOps(doc).find((o) => o.stream.contentsIndex === 3)!;
    const r2 = removeTextShowOps(doc, buildSourceMap(doc, 0), [rest.id]);
    expect(r2.copied).toEqual([]);
    expect(r2.streams).toEqual([num]);
    expect(textOf(doc, 0).trim()).toBe('');
  });

  it('같은 스트림의 두 칸을 한 번에 지우면 칸마다 사본을 만들고 원본은 그대로 둔다', () => {
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

  it('두 쪽이 같은 간접 /Contents 배열을 쓰면 이 쪽만 새 배열로 바꾼다', () => {
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

describe('removeTextShowOps: 명세 폭·코드·폰트 가드', () => {
  it('소수 /Widths: TJ 숫자는 명세 폭(실수)으로 계산한다(MuPDF 정수 폭 아님)', () => {
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
    // MuPDF 는 폭을 556 으로 반올림해 그리므로 MuPDF 렌더의 X 는 반올림 오차(20 × 0.4/1000 × 12 pt)만큼 움직인다.
    expect(xOf() - xBefore).toBeCloseTo((20 * 0.4 * 12) / 1000, 3);
  });

  it('Tw 는 1바이트 코드 32 에만 더한다(Type0 1바이트 코드스페이스 포함, 2바이트 0x0020 제외)', () => {
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
    // 뒤따르는 (X) Tj 두 개의 원점(SourceMap 은 MuPDF 와 같은 정수 폭으로 계산한다).
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

  it('CID 매핑이 없는 코드가 있는 연산은 건너뛴다(MuPDF 는 전진하지 않음, 명세 뷰어는 CID 0 폭)', () => {
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
    expect(r.skipped[0]!.reason).toMatch(/^CID 매핑 없는 코드/);
  });

  it('MuPDF 가 로드하지 못해 대체(hail-mary)한 폰트는 건너뛴다', () => {
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
      { opId: op.id, reason: '편집 제한: font-encoding-unresolved' },
    ]);
    // 제한 표시가 없어도 폰트 자체의 대체 사유로 건너뛴다.
    op.limits = [];
    const r = removeTextShowOps(doc, map, [op.id]);
    expect(r.removed).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/^MuPDF 대체 폰트/);
  });

  it('/Font 가 없는 쪽·/Resources 가 없는 쪽: 예외 없이 건너뛴다', () => {
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
      expect(r.skipped).toEqual([{ opId: op.id, reason: '폰트 리소스 없음: F1' }]);
    }
  });

  it('" 피연산자가 모자라면 건너뛴다', () => {
    const doc = onePage('BT /F1 10 Tf 14 TL 20 100 Td (zero) " 5 (one) " 1 2 (two) " ET');
    const ops = showOps(doc);
    const r = removeTextShowOps(
      doc,
      buildSourceMap(doc, 0),
      ops.map((o) => o.id),
    );
    expect(r.removed).toEqual([ops[2]!.id]);
    expect(r.skipped).toEqual([
      { opId: ops[0]!.id, reason: '" 피연산자 부족' },
      { opId: ops[1]!.id, reason: '" 피연산자 부족' },
    ]);
  });

  it('TJ 배열 안 연산자(Tw·Tc)는 뷰어마다 달라 건너뛴다', () => {
    const doc = onePage('BT /F1 10 Tf 20 100 Td [(A) 5 Tw (B)] TJ ET');
    const op = showOps(doc)[0]!;
    const r = removeTextShowOps(doc, buildSourceMap(doc, 0), [op.id]);
    expect(r.skipped).toEqual([{ opId: op.id, reason: 'TJ 배열에 문자열·숫자 밖 토큰' }]);
  });
});
