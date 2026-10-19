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
