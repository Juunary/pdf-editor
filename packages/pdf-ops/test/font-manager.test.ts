import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { TextRun } from '@pdf-editor/shared-types';
import {
  embedFont,
  FontManager,
  FULL_SAVE_OPTIONS,
  subsetFontBytes,
  type ParagraphEditContext,
} from '../src/index.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { editParagraph, loadFallback, fallbackFor } from './helpers/edit-driver.js';
import { inkInside, pageText, raster, squash } from './helpers/engines.js';
import { engines, makeDoc } from './helpers/fixtures-m3.js';

/** Contract D4 font assignment and V4 (outline/width classification = render, fallback ToUnicode copy/search). */
beforeAll(async () => {
  await loadModules();
});

function runsOf(ctx: ParagraphEditContext, needle: string, text: string): TextRun[] {
  const p = findParagraph(ctx, needle);
  const c = p.chars[0]!;
  const ch = ctx.model.chars[c]!;
  return [
    {
      text,
      style: {
        sourceChar: c,
        fontId: ch.fontId,
        size: ch.size,
        bold: false,
        italic: false,
        color: null,
      },
    },
  ];
}

/** Assignment result per cluster: o = original, f = fallback, - = none. */
function faces(fm: FontManager, ctx: ParagraphEditContext, runs: TextRun[]): string {
  const text = runs.map((r) => r.text).join('');
  const { segments } = fm.assign(ctx, text, runs);
  let out = '';
  for (const s of segments) {
    const k = s.face === null ? '-' : s.face.kind === 'original' ? 'o' : 'f';
    out += [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        text.slice(s.start, s.end),
      ),
    ]
      .map(() => k)
      .join('');
  }
  return out;
}

/**
 * A document with Noto Sans KR embedded as Type0 (Identity-H). If subsetText is given, FontFile2 is replaced with a subset
 * keeping only the outlines of those characters (gids kept, ToUnicode and /W left whole: the same state as MuPDF/Word-style subsets).
 */
function notoDoc(text: string, subsetText?: string) {
  const full = loadFallback();
  const font = new mupdf.Font('NotoSansKR', full);
  const src = new mupdf.PDFDocument();
  const N = src.addFont(font);
  if (subsetText) {
    const gids = [...subsetText].map((c) => font.encodeCharacter(c.codePointAt(0)!));
    const ff = N.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    ff.writeStream(subsetFontBytes('NotoSansKR', full, gids));
  }
  const hexs = [...text]
    .map((c) => font.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, '0'))
    .join('');
  src.insertPage(
    -1,
    src.addPage([0, 0, 400, 300], 0, { Font: { N } }, `BT /N 14 Tf 50 200 Td <${hexs}> Tj ET`),
  );
  return { doc: reopen(src), font };
}

describe('original font reverse mapping (i), format (iv)', () => {
  it('Type1 (simple, WinAnsi): Latin and accented characters use the original, Hangul uses the fallback', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Helvetica sample text.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(faces(fm, ctx, runsOf(ctx, 'Helvetica', 'Héllo 한'))).toBe('oooooof');
  });

  it('TrueType (simple) and Type0 (Identity-H) font reverse mapping', () => {
    const src = new mupdf.PDFDocument();
    const T = src.addSimpleFont(new mupdf.Font('NotoSansKR', loadFallback()));
    src.insertPage(
      -1,
      src.addPage(
        [0, 0, 400, 300],
        0,
        { Font: { T } },
        'BT /T 12 Tf 50 200 Td (Truetype simple.) Tj ET',
      ),
    );
    const doc = reopen(src);
    const ctx = pageContext(doc, 0);
    expect(doc.findPage(0).get('Resources').get('Font').get('T').get('Subtype').asName()).toBe(
      'TrueType',
    );
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(faces(fm, ctx, runsOf(ctx, 'Truetype', 'Text 가'))).toBe('ooooof');
    const { doc: d2 } = notoDoc('가나다 abc');
    const c2 = pageContext(d2, 0);
    expect(
      faces(new FontManager(d2, fallbackFor(d2)), c2, runsOf(c2, '가나다', '다나가 cab')),
    ).toBe('ooooooo');
  });

  it('with several candidates, the code used on this page is preferred', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Used \\310 code here.) Tj ET']);
    const f1 = doc.findPage(0).get('Resources').get('Font').get('F1');
    f1.delete('ToUnicode');
    const enc = doc.newDictionary();
    enc.put('BaseEncoding', doc.newName('WinAnsiEncoding'));
    const diff = doc.newArray();
    diff.push(200);
    diff.push(doc.newName('A'));
    enc.put('Differences', diff);
    f1.put('Encoding', enc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const runs = runsOf(ctx, 'Used', 'A');
    const seg = fm.assign(ctx, 'A', runs).segments[0]!;
    expect(seg.face?.kind).toBe('original');
    const enc0 = seg.face!.source.kind === 'pdf-widths' ? seg.face!.source.encode('A') : null;
    expect([...enc0![0]!.code]).toEqual([200]);
  });
});

describe('review fixes (docs/m3-integration.md section 8)', () => {
  it('M3: candidate priority is decided by the state of the page being assigned (independent of having assigned another page first)', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 200 Td (Used \\310 code here.) Tj ET',
      'BT /F1 12 Tf 50 200 Td (Plain A text here.) Tj ET',
    ]);
    const f1 = doc.findPage(0).get('Resources').get('Font').get('F1');
    f1.delete('ToUnicode');
    const enc = doc.newDictionary();
    enc.put('BaseEncoding', doc.newName('WinAnsiEncoding'));
    const diff = doc.newArray();
    diff.push(200);
    diff.push(doc.newName('A'));
    enc.put('Differences', diff);
    f1.put('Encoding', enc);
    const c0 = pageContext(doc, 0);
    const c1 = pageContext(doc, 1);
    const codeOf = (fm: FontManager, ctx: ParagraphEditContext, needle: string) => {
      const seg = fm.assign(ctx, 'A', runsOf(ctx, needle, 'A')).segments[0]!;
      const src = seg.face!.source;
      return src.kind === 'pdf-widths' ? [...src.encode('A')![0]!.code] : null;
    };
    const withHistory = new FontManager(doc, fallbackFor(doc));
    expect(codeOf(withHistory, c1, 'Plain')).toEqual([65]);
    expect(codeOf(withHistory, c0, 'Used')).toEqual([200]);
    const fresh = new FontManager(doc, fallbackFor(doc));
    expect(codeOf(fresh, c0, 'Used')).toEqual([200]);
  });

  it('H1: NFC input maps to decomposed ToUnicode keys; for a missing combining character the base character is kept and only that character is missing', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Accent sample text.) Tj ET']);
    const f1 = doc.findPage(0).get('Resources').get('Font').get('F1');
    const cmap =
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def ' +
      '1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0020> endbfrange ' +
      '1 beginbfchar <E9> <00650301> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
    f1.put('ToUnicode', doc.addStream(cmap, doc.newDictionary()));
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const runs = runsOf(ctx, 'Accent', 'café q\u0301');
    expect(faces(fm, ctx, runs)).toBe('oooooo');
    const { segments, warnings } = fm.assign(ctx, runs[0]!.text, runs);
    const src = segments[0]!.face!.source;
    expect(src.kind === 'pdf-widths' ? [...src.encode('é')![0]!.code] : null).toEqual([0xe9]);
    expect(src.kind === 'pdf-widths' ? src.encode('q\u0301')!.length : null).toBe(1);
    expect(warnings.map((w) => w.kind)).toEqual(['glyph-missing']);
    expect(warnings[0]!.message).toContain('\u0301');
  });
});

describe('outline (ii) and width (iii) classification and V4 (same as the render result)', () => {
  it('a glyph whose outline the subset emptied is not used from the original even if its gid exists (checked with three-engine ink)', async () => {
    const chars = '가나다라마abcxyz';
    const { doc, font } = notoDoc('가나 ab', '가나다 abc');
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const decided = faces(fm, ctx, runsOf(ctx, '가나', chars));
    // Only the glyphs kept in the subset (가나다abc) use the original.
    expect(decided).toBe('oooffooofff');
    // Force-draw each character with the same font and check the ink of the three engines.
    const N = doc.findPage(0).get('Resources').get('Font').get('N');
    const cells = [...chars].map((c, i) => ({
      c,
      gid: font.encodeCharacter(c.codePointAt(0)!),
      x: 20 + (i % 7) * 50,
      y: 250 - Math.floor(i / 7) * 60,
    }));
    const content = cells
      .map((k) => `BT /N 30 Tf ${k.x} ${k.y} Td <${k.gid.toString(16).padStart(4, '0')}> Tj ET`)
      .join('\n');
    const probe = new mupdf.PDFDocument();
    const NN = probe.graftObject(N);
    probe.insertPage(-1, probe.addPage([0, 0, 400, 300], 0, { Font: { N: NN } }, content));
    const bytes = probe.saveToBuffer('').asUint8Array().slice();
    for (const e of engines()) {
      const ras = await raster(e, bytes, 0);
      const inked = cells
        .map((k) =>
          inkInside(ras, [k.x, 300 - k.y - 30, k.x + 40, 300 - k.y + 10]) > 0 ? 'o' : 'f',
        )
        .join('');
      expect(inked, e).toBe(decided);
    }
  });

  it('a code with specified width 0 is not used from the original (pdfTeX-style /Widths)', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Width zero sample.) Tj ET']);
    // A standard 14 font, so there is no /Widths. Provide widths for 32-126 and set only 'x' to 0.
    const f1 = doc.findPage(0).get('Resources').get('Font').get('F1');
    const helv = new mupdf.Font('Helvetica');
    const copy = doc.newArray();
    for (let c = 32; c <= 126; c++) {
      copy.push(c === 0x78 ? 0 : Math.round(helv.advanceGlyph(helv.encodeCharacter(c)) * 1000));
    }
    f1.put('FirstChar', 32);
    f1.put('LastChar', 126);
    f1.put('Widths', copy);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    expect(faces(fm, ctx, runsOf(ctx, 'Width zero', 'wxy'))).toBe('ofo');
  });
});

describe('per-character fallback and glyph-missing', () => {
  it('a line mixing fallback: a character in neither font gets face null and a warning; a line break takes the preceding font', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Mixed fallback line.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const runs = runsOf(ctx, 'Mixed', 'ab 가나\n😀ᄀ漢');
    const { segments, warnings } = fm.assign(ctx, runs[0]!.text, runs);
    expect(faces(fm, ctx, runs)).toBe('ooofff--f');
    expect(
      segments.find((s) => runs[0]!.text.slice(s.start, s.end).includes('\n'))?.face,
    ).not.toBeNull();
    const w = warnings.map((x) => x.kind);
    expect(w).toContain('font-fallback');
    expect(w).toContain('glyph-missing');
    expect(warnings.find((x) => x.kind === 'glyph-missing')!.message).toContain('😀');
    // Numbers and characters for other-language screens (2026-10-26): same as the characters in message.
    const missing = warnings.find((x) => x.kind === 'glyph-missing')!;
    expect(missing.chars).toContain('😀');
    expect(missing.count).toBe([...missing.chars!].length);
    const fallback = warnings.find((x) => x.kind === 'font-fallback')!;
    expect(fallback.message).toContain(fallback.chars!);
    expect(fallback.count).toBeGreaterThan(0);
    expect(segments.at(-1)!.end).toBe(runs[0]!.text.length);
  });
});

describe('fallback font lifetime and save subset (D4, D9)', () => {
  it('subset only inside the save operation: the saved file is small and three engines extract/search Hangul, the working document keeps the full font', async () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Before paragraph.) Tj ET BT /F1 12 Tf 50 200 Td (Target paragraph.) Tj ET',
    ]);
    const source = fallbackFor(doc);
    const fm = new FontManager(doc, source);
    // As in core, the fallback font and Info are created before the journal is turned on (contract D4/D9 amendment 1).
    doc.enableJournal();
    const ctx = pageContext(doc, 0);
    doc.beginOperation('edit');
    const r = editParagraph(ctx, fm, findParagraph(ctx, 'Target').id, '서브셋 저장 확인 문장');
    doc.endOperation();
    const fontRef = source.ref()!;
    const file = () => fontRef.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    const fullLength = file().readStream().getLength();
    doc.beginOperation('save');
    fm.finalizeForSave();
    const saved = doc.saveToBuffer(FULL_SAVE_OPTIONS).asUint8Array().slice();
    doc.abandonOperation();
    expect(file().readStream().getLength()).toBe(fullLength);
    expect(doc.canUndo()).toBe(true);
    const reopened = mupdf.Document.openDocument(saved, 'application/pdf') as mupdf.PDFDocument;
    let subsetLen = 0;
    reopened
      .findPage(0)
      .get('Resources')
      .get('XObject')
      .forEach((x) => {
        x.get('Resources')
          .get('Font')
          .forEach((f) => {
            if (!f.get('BaseFont').asName().includes('NotoSansKR')) return;
            subsetLen = f
              .get('DescendantFonts')
              .get(0)
              .get('FontDescriptor')
              .get('FontFile2')
              .readStream()
              .getLength();
          });
      });
    expect(subsetLen).toBeGreaterThan(0);
    expect(subsetLen).toBeLessThan(fullLength / 10);
    for (const e of engines()) {
      expect(squash(await pageText(e, saved, 0)), e).toContain('서브셋저장확인문장');
    }
    // MuPDF search: the highlight center is inside the glyph box that was laid out.
    const page = reopened.loadPage(0);
    const hits = page.search('저장', {});
    page.destroy();
    expect(hits.length).toBe(1);
    const q = hits[0]![0]!;
    const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
    const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
    const offset = r.text.indexOf('저장');
    const g = r.result.summary.glyphs.filter((x) => x.offset === offset || x.offset === offset + 1);
    const x0 = g[0]!.x;
    const x1 = g[1]!.x + g[1]!.advance;
    expect(cx).toBeGreaterThan(x0);
    expect(cx).toBeLessThan(x1);
    expect(Math.abs(cy - (g[0]!.y - g[0]!.size * 0.35))).toBeLessThan(g[0]!.size * 0.6);
  });
});

describe('V4 fallback ToUnicode round trip (contract amendment 2)', () => {
  it('every code point of the fallback cmap (excluding whitespace): extraction of a character drawn by gid = that code point (0 mismatches)', async () => {
    const bytes = loadFallback();
    const font = new mupdf.Font('NotoSansKR', bytes);
    const cps: number[] = [];
    for (let cp = 0x21; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/\s/u.test(String.fromCodePoint(cp))) continue;
      if (font.encodeCharacter(cp) > 0) cps.push(cp);
    }
    // 60 characters x 40 lines on one page, drawing gids as 2-byte Identity-H.
    const src = new mupdf.PDFDocument();
    const ref = embedFont(src, 'NotoSansKR', bytes).ref;
    const PER = 2400;
    for (let i = 0; i < cps.length; i += PER) {
      const chunk = cps.slice(i, i + PER);
      const lines: string[] = [];
      for (let k = 0; k < chunk.length; k += 60) {
        const hex = chunk
          .slice(k, k + 60)
          .map((cp) => font.encodeCharacter(cp).toString(16).padStart(4, '0'))
          .join('');
        lines.push(`1 0 0 1 20 ${820 - (k / 60) * 20} Tm <${hex}> Tj`);
      }
      src.insertPage(
        -1,
        src.addPage([0, 0, 720, 840], 0, { Font: { F: ref } }, `BT /F 10 Tf ${lines.join(' ')} ET`),
      );
    }
    const out = src.saveToBuffer('compress').asUint8Array().slice();
    const doc = mupdf.Document.openDocument(out, 'application/pdf');
    let mismatch = 0;
    const examples: string[] = [];
    for (let p = 0; p * PER < cps.length; p++) {
      const page = doc.loadPage(p);
      const st = page.toStructuredText('preserve-whitespace');
      const got: number[] = [];
      st.walk({ onChar: (c) => void (/\s/u.test(c) || got.push(c.codePointAt(0)!)) });
      st.destroy();
      page.destroy();
      const want = cps.slice(p * PER, p * PER + PER);
      for (let k = 0; k < want.length; k++) {
        if (got[k] !== want[k]) {
          mismatch++;
          if (examples.length < 5)
            examples.push(`U+${want[k]!.toString(16)}→${got[k]?.toString(16)}`);
        }
      }
      expect(got.length).toBe(want.length);
    }
    console.log(
      `폴백 ToUnicode 왕복(MuPDF): 코드 포인트 ${cps.length}, 불일치 ${mismatch} ${examples.join(' ')}`,
    );
    expect(mismatch).toBe(0);
    // pdf.js and Poppler: compare the page text (whitespace removed) with the code point order. pdf.js converts
    // U+00B5 (MICRO SIGN) to U+03BC in text content (the engine's own normalization, measured 2026-10-19). That one pair is treated as equal.
    const engineNorm: Record<string, Map<number, number>> = { pdfjs: new Map([[0x3bc, 0xb5]]) };
    for (const e of engines().filter((x) => x !== 'mupdf')) {
      let bad = 0;
      const ex: string[] = [];
      for (let p = 0; p * PER < cps.length; p++) {
        const norm = engineNorm[e];
        // The round-trip check looks at every code point (including default-ignorable characters), so only whitespace is removed.
        const got = [...(await pageText(e, out, p)).replace(/\s+/gu, '')]
          .map((c) => c.codePointAt(0)!)
          .map((c, k) => (norm?.get(c) === cps[p * PER + k] ? cps[p * PER + k]! : c));
        const want = cps.slice(p * PER, p * PER + PER);
        for (let k = 0; k < Math.max(got.length, want.length); k++) {
          if (got[k] !== want[k]) {
            bad++;
            if (ex.length < 5) ex.push(`U+${want[k]?.toString(16)}→${got[k]?.toString(16)}`);
          }
        }
      }
      console.log(`폴백 ToUnicode 왕복(${e}): 불일치 ${bad} ${ex.join(' ')}`);
      expect(bad, e).toBe(0);
    }
  }, 120_000);
});
