import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { FontManager } from '../src/index.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { editParagraph, fallbackFor } from './helpers/edit-driver.js';
import {
  bytesOf,
  charsOfText,
  expectNoChangeOutside,
  expectOrder,
  expectSameOrigins,
  makeDoc,
  paragraphOf,
  stextChars,
  withParagraphs,
  wordOrigins,
} from './helpers/fixtures-m3.js';

/** Contract 8.1 synthetic PDFs: removal and insertion (D2, D3) and V2/V3 three-engine checks. */
beforeAll(async () => {
  await loadModules();
});

const THREE = [
  'BT /F1 12 Tf 14 TL 50 260 Td (Alpha paragraph opens the page.) Tj T* (It has two lines.) Tj ET',
  'BT /F1 12 Tf 14 TL 50 200 Td (Bravo paragraph is the target.) Tj T* (Second line of bravo.) Tj ET',
  'BT /F1 12 Tf 14 TL 50 140 Td (Charlie paragraph closes it.) Tj ET',
].join('\n');

const contentOf = (doc: mupdf.PDFDocument, page = 0) => {
  const c = doc.findPage(page).get('Contents');
  const s = c.isArray() ? c.get(0) : c;
  return s.readStream().asString();
};

describe('V2 before-bt: q /name Do Q at the insertion point', () => {
  it('0 px render outside the region (three engines), re-extraction order stays in the original place', async () => {
    const doc = makeDoc([THREE]);
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r = editParagraph(
      ctx,
      fm,
      p.id,
      'Bravo text was rewritten here with a few more words added.',
    );
    expect(r.plan.insertion).toEqual({ container: 'page', mode: 'before-bt', mcidKept: null });
    expect(contentOf(doc)).toContain('q /PEB0 Do Q');
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
    await expectOrder(after, 0, 'It has two lines.', r.text, 'Charlie paragraph');
  });

  it('objects changed by removal and insertion = page dictionary, content stream, edit block', () => {
    const doc = makeDoc([THREE, 'BT /F1 12 Tf 50 200 Td (Other page) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Bravo paragraph');
    const page1 = doc.findPage(1).toString();
    const r = editParagraph(ctx, fm, p.id);
    const pageNum = doc.findPage(0).asIndirect();
    const contents = doc.findPage(0).get('Contents').asIndirect();
    expect(r.prepared.changedObjects).toEqual(
      expect.arrayContaining([pageNum, contents, r.prepared.block.objectNumber]),
    );
    expect(doc.findPage(1).toString()).toBe(page1);
  });
});

describe('V2 geometric proximity: two paragraphs in the same MuPDF block', () => {
  it('even when the adjacent next paragraph is made longer, the re-extraction order stays in the original place (three engines)', async () => {
    const doc = makeDoc([
      'BT /F1 11 Tf 13 TL 50 260 Td (First block line one,) Tj T* (first block line two.) Tj T* ' +
        '(Second part line three) Tj T* (second part line four.) Tj ET BT /F1 11 Tf 50 150 Td (Tail paragraph.) Tj ET',
    ]);
    const before = bytesOf(doc);
    const ctx0 = pageContext(doc, 0);
    const a = charsOfText(ctx0, 'First block line one,first block line two.');
    const b = charsOfText(ctx0, 'Second part line threesecond part line four.');
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, a, 0), paragraphOf(ctx0, b, 1)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(
      ctx,
      fm,
      1,
      'Second part rewritten into a noticeably longer sentence here.',
    );
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 0, [
      ctx.layout.paragraphs[1]!.bbox,
      r.result.summary.contentBox,
    ]);
    await expectOrder(after, 0, 'first block line two.', r.text, 'Tail paragraph.');
  });
});

describe('V3 split-bt: BT splitting', () => {
  const ONE_BT =
    'BT /F1 11 Tf 13 TL 0.98 0 0 1.02 50.25 260.125 Tm (Kept first paragraph line.) Tj ' +
    '0 -40 Td (Target paragraph line one) Tj T* (and the target line two.) Tj ' +
    '0 -40 Td (Kept last paragraph stays.) Tj ET';

  it('remaining characters of the same BT keep their position and shape (fractional-coefficient Tm, three engines 0 px)', async () => {
    const doc = makeDoc([ONE_BT]);
    const before = bytesOf(doc);
    const st0 = stextChars(doc, 0);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Target paragraph');
    const r = editParagraph(ctx, fm, p.id, 'Target paragraph was replaced by a sentence.');
    expect(r.plan.insertion?.mode).toBe('split-bt');
    const content = contentOf(doc);
    expect(content).toMatch(/ET q \/PEB0 Do Q BT [-\d. ]+ Tm/);
    const st1 = stextChars(doc, 0);
    expectSameOrigins(
      wordOrigins(st0, 'Kept last paragraph stays.'),
      wordOrigins(st1, 'Kept last paragraph stays.'),
    );
    expectSameOrigins(
      wordOrigins(st0, 'Kept first paragraph line.'),
      wordOrigins(st1, 'Kept first paragraph line.'),
    );
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
    await expectOrder(after, 0, 'Kept first paragraph line.', r.text, 'Kept last paragraph stays.');
  });

  it('if Tm is the last line-setting operation, the original operand bytes are used as is', () => {
    const doc = makeDoc([
      'BT /F1 11 Tf 50 260 Td (Kept first line here.) Tj 0.98 0 0 1.02 50.123456 200.5 Tm (Target words) Tj ET',
    ]);
    const ctx0 = pageContext(doc, 0);
    const target = charsOfText(ctx0, 'Target words');
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, target, 0)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(ctx, fm, 0);
    expect(r.plan.insertion?.mode).toBe('split-bt');
    expect(contentOf(doc)).toContain('Do Q BT 0.98 0 0 1.02 50.123456 200.5 Tm');
  });

  it('the line matrix is restored by re-executing the original line-setting operations in the same order (Td accumulation, TD, T*, three engines 0 px)', async () => {
    const doc = makeDoc([
      'BT /F1 10 Tf 61.827 269.963 Td (Head words kept.) Tj 117.789 -13.948 Td (more) Tj ' +
        '-125.616 -23.91 TD (Target line here) Tj 12 TL T* (target second line.) Tj T* (Kept tail line after.) Tj ET',
    ]);
    const before = bytesOf(doc);
    const st0 = stextChars(doc, 0);
    const ctx0 = pageContext(doc, 0);
    const chars = [
      ...charsOfText(ctx0, 'Target line here'),
      ...charsOfText(ctx0, 'target second line.'),
    ];
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, chars, 0)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(ctx, fm, 0, 'Replaced lines.');
    expect(r.plan.insertion?.mode).toBe('split-bt');
    expect(contentOf(doc)).toContain(
      'ET q /PEB0 Do Q BT 61.827 269.963 Td 117.789 -13.948 Td -125.616 -23.91 Td',
    );
    const st1 = stextChars(doc, 0);
    expectSameOrigins(
      wordOrigins(st0, 'Kept tail line after.'),
      wordOrigins(st1, 'Kept tail line after.'),
    );
    await expectNoChangeOutside(before, bytesOf(doc), 0, [
      ctx.layout.paragraphs[0]!.bbox,
      r.result.summary.contentBox,
    ]);
  });

  for (const [label, content, replay] of [
    [
      'TD 뒤 TL 변경 → 분할 → T*',
      'BT /F1 12 Tf 50 260 Td (Kept head line.) Tj 0 -20 TD (Kept second line.) Tj 12 TL (Target words here) Tj T* (Next line after split.) Tj ET',
      'BT 50 260 Td 0 -20 Td',
    ],
    [
      'T* 사이 TL 변경 → 분할 → T*',
      'BT /F1 12 Tf 14 TL 50 260 Td (Kept head line.) Tj T* (Kept second line.) Tj 20 TL T* (Target words here) Tj T* (Next line after split.) Tj ET',
      'BT 50 260 Td 0 -14 Td 0 -20 Td',
    ],
    [
      'BT 앞에서 정한 TL, 분할 앞 TL 변경',
      '18 TL BT /F1 12 Tf 50 260 Td (Kept head line.) Tj T* (Kept second line.) Tj 11 TL T* (Target words here) Tj T* (Next line after split.) Tj ET',
      'BT 50 260 Td 0 -18 Td 0 -11 Td',
    ],
  ] as const) {
    it(`TL preservation (contract amendment 3 check): ${label} — later line positions unchanged, three engines 0 px`, async () => {
      const doc = makeDoc([content]);
      const before = bytesOf(doc);
      const st0 = stextChars(doc, 0);
      const ctx0 = pageContext(doc, 0);
      const ctx = withParagraphs(ctx0, [
        paragraphOf(ctx0, charsOfText(ctx0, 'Target words here'), 0),
      ]);
      const fm = new FontManager(doc, fallbackFor(doc));
      const r = editParagraph(ctx, fm, 0, 'Replaced words');
      expect(r.plan.insertion?.mode).toBe('split-bt');
      // TD is rewritten as Td and T* as Td with the TL at that time, then re-executed (TL state is not changed, so the TL at that point remains).
      expect(contentOf(doc)).toContain(`ET q /PEB0 Do Q ${replay}`);
      const st1 = stextChars(doc, 0);
      expectSameOrigins(
        wordOrigins(st0, 'Next line after split.'),
        wordOrigins(st1, 'Next line after split.'),
      );
      await expectNoChangeOutside(before, bytesOf(doc), 0, [
        ctx.layout.paragraphs[0]!.bbox,
        r.result.summary.contentBox,
      ]);
    });
  }

  for (const [label, content, keep, target, after] of [
    ['Tj', 'BT /F1 12 Tf 50 200 Td (Alpha beta gamma) Tj ET', 'Alpha', 'beta gamma', null],
    ['Tj 가운데', 'BT /F1 12 Tf 50 200 Td (Alpha beta gamma) Tj ET', 'Alpha', 'beta', 'gamma'],
    [
      'TJ 조정',
      'BT /F1 12 Tf 1.5 Tc 2 Tw 90 Tz 50 200 Td [(Al) -30 (pha be) 33.5 (ta gam) -10 (ma)] TJ ET',
      'Alpha',
      'beta gam',
      'ma',
    ],
    [
      "'",
      "BT /F1 12 Tf 14 TL 50 214 Td (Line zero) Tj (Alpha beta gamma) ' ET",
      'Alpha',
      'beta gamma',
      null,
    ],
    [
      '"',
      'BT /F1 12 Tf 14 TL 50 214 Td (Line zero) Tj 3 0.5 (Alpha beta gamma) " ET',
      'Alpha',
      'beta',
      'gamma',
    ],
  ] as const) {
    it(`erasing only part of an operation and splitting inside an operation: ${label}`, async () => {
      const doc = makeDoc([content]);
      const before = bytesOf(doc);
      const st0 = stextChars(doc, 0);
      const ctx0 = pageContext(doc, 0);
      const chars = charsOfText(ctx0, target);
      const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, chars, 0)]);
      const fm = new FontManager(doc, fallbackFor(doc));
      const r = editParagraph(ctx, fm, 0, target.toUpperCase());
      expect(r.plan.removal.partialOps).toBe(1);
      expect(r.plan.insertion?.mode).toBe('split-bt');
      const st1 = stextChars(doc, 0);
      expectSameOrigins(wordOrigins(st0, keep), wordOrigins(st1, keep));
      if (after) expectSameOrigins(wordOrigins(st0, after), wordOrigins(st1, after));
      const bytes = bytesOf(doc);
      await expectNoChangeOutside(before, bytes, 0, [
        ctx.layout.paragraphs[0]!.bbox,
        r.result.summary.contentBox,
      ]);
      await expectOrder(bytes, 0, keep, target.toUpperCase(), after);
    });
  }
});

describe('text inside a Form: byte duplication of the used path (D2)', () => {
  const formDoc = (nested: boolean) =>
    makeDoc(
      [
        'BT /F1 12 Tf 50 270 Td (Page paragraph above the form.) Tj ET q 1 0 0 1 50 100 cm /X0 Do Q',
        'q 1 0 0 1 50 100 cm /X0 Do Q',
      ],
      (src, { F1 }) => {
        const inner = src.addStream(
          'BT /F1 12 Tf 10 70 Td (Form paragraph text one.) Tj ET BT /F1 12 Tf 10 20 Td (Form second paragraph.) Tj ET',
          {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 300, 100],
            Resources: { Font: { F1 } },
            StructParents: 3,
          },
        );
        if (!nested) return { XObject: { X0: inner } };
        const outer = src.addStream('q 1 0 0 1 0 0 cm /B0 Do Q', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 320, 120],
          Resources: { XObject: { B0: inner } },
        });
        return { XObject: { X0: outer } };
      },
    );

  for (const nested of [false, true]) {
    it(`${nested ? '중첩 Form(상위 체인 포함)' : '공유 Form'}: removed from the duplicate, other pages and the original Form unchanged, /StructParents removed`, async () => {
      const doc = formDoc(nested);
      const before = bytesOf(doc);
      const page1 = doc.findPage(1).toString();
      const ctx = pageContext(doc, 0);
      const fm = new FontManager(doc, fallbackFor(doc));
      const p = findParagraph(ctx, 'Form paragraph text one');
      const formNums = ctx.map.ops
        .find((o) => o.text && o.formPath.length > 0)!
        .formPath.map((s) => s.objectNumber);
      const formBytes = formNums.map((n) => doc.newIndirect(n).readStream().asString());
      const r = editParagraph(ctx, fm, p.id, 'Form text replaced in the clone.');
      expect(r.plan.insertion?.container).toBe('form-clone');
      expect(r.plan.removal.formInstances).toBe(nested ? 2 : 1);
      expect(r.plan.warnings.map((w) => w.kind)).toContain('tagged-structure-unlinked');
      // The original Form stream and other pages stay as they are.
      formNums.forEach((n, i) =>
        expect(doc.newIndirect(n).readStream().asString()).toBe(formBytes[i]),
      );
      expect(doc.findPage(1).toString()).toBe(page1);
      const xo = doc.findPage(0).get('Resources').get('XObject');
      const clone = xo.get('PEF0').isNull() ? xo.get('PEB0') : xo.get('PEF0');
      expect(clone.isStream()).toBe(true);
      const leaf = nested ? clone.get('Resources').get('XObject').get('PEF0') : clone;
      expect(leaf.get('StructParents').isNull()).toBe(true);
      expect(leaf.readStream().asString()).toContain('/PEB0 Do');
      const after = bytesOf(doc);
      await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
      await expectNoChangeOutside(before, after, 1, []);
      await expectOrder(
        after,
        0,
        'Page paragraph above the form.',
        r.text,
        'Form second paragraph.',
      );
    });
  }

  it('shared content stream: makes a copy and changes only the slot of this page', async () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, { Font: { F1 } }, THREE));
    src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, { Font: { F1 } }, ''));
    src.findPage(1).put('Contents', src.findPage(0).get('Contents'));
    const doc = reopen(src);
    const before = bytesOf(doc);
    const shared = doc.findPage(0).get('Contents').asIndirect();
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r = editParagraph(ctx, fm, p.id, 'Bravo changed.');
    expect(doc.findPage(1).get('Contents').asIndirect()).toBe(shared);
    expect(doc.findPage(0).get('Contents').asIndirect()).not.toBe(shared);
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 1, []);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
  });
});

describe('coordinates: y-flipped CTM, /Rotate 90 and 270, Tr 3 of a preceding BT, clip', () => {
  it('y-flipped CTM: the block /Matrix cancels it so the new text stands upright', async () => {
    const doc = makeDoc([
      'q 1 0 0 -1 0 300 cm BT /F1 12 Tf 1 0 0 -1 50 40 Tm (Upright flipped paragraph.) Tj ET ' +
        'BT /F1 12 Tf 1 0 0 -1 50 120 Tm (Second flipped paragraph.) Tj ET Q',
    ]);
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Upright flipped');
    const r = editParagraph(ctx, fm, p.id, 'Upright text after edit.');
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
    await expectOrder(after, 0, null, r.text, 'Second flipped paragraph.');
  });

  for (const rotate of [90, 270] as const) {
    it(`/Rotate ${rotate}: editing a horizontal paragraph on screen`, async () => {
      // Build the user-space Tm so that the text is horizontal on screen (page space).
      const probe = makeDoc([{ content: '', rotate }]);
      const u2p = probe.loadPage(0).getTransform();
      const inv = mupdf.Matrix.invert(u2p);
      const ex = [inv[0], inv[1]];
      const up = [-inv[2], -inv[3]];
      const tm = (x: number, y: number) => {
        const o = [x * inv[0] + y * inv[2] + inv[4], x * inv[1] + y * inv[3] + inv[5]];
        return `${ex[0]} ${ex[1]} ${up[0]} ${up[1]} ${o[0]} ${o[1]} Tm`;
      };
      const doc = makeDoc([
        {
          rotate,
          content:
            `BT /F1 12 Tf ${tm(40, 60)} (Rotated page first paragraph.) Tj ET ` +
            `BT /F1 12 Tf ${tm(40, 140)} (Rotated page second paragraph.) Tj ET`,
        },
      ]);
      const before = bytesOf(doc);
      const ctx = pageContext(doc, 0);
      const fm = new FontManager(doc, fallbackFor(doc));
      const p = findParagraph(ctx, 'Rotated page first');
      const r = editParagraph(ctx, fm, p.id, 'Rotated page text edited.');
      const after = bytesOf(doc);
      await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
      await expectOrder(after, 0, null, r.text, 'Rotated page second paragraph.');
      const st = stextChars(doc, 0);
      const w = wordOrigins(st, 'Rotated page text edited.')!;
      // New characters are horizontal on screen (same y, increasing x).
      expect(Math.abs(w.at(-1)!.y - w[0]!.y)).toBeLessThan(0.01);
      expect(w.at(-1)!.x).toBeGreaterThan(w[0]!.x);
    });
  }

  it('does not inherit the Tr 3 left by a preceding BT (the block specifies Tr)', async () => {
    const doc = makeDoc([
      'BT 3 Tr /F1 12 Tf 50 270 Td (hidden ocr layer) Tj ET BT /F1 12 Tf 50 200 Td 0 Tr (Visible paragraph text.) Tj ET',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Visible paragraph');
    const r = editParagraph(ctx, fm, p.id, 'NEW VISIBLE WORDS');
    const after = bytesOf(doc);
    const { inkInside, raster } = await import('./helpers/engines.js');
    for (const e of ['mupdf', 'pdfjs', 'poppler'] as const) {
      expect(inkInside(await raster(e, after, 0), r.result.summary.contentBox), e).toBeGreaterThan(
        50,
      );
    }
  });

  it('a rectangular clip goes into the region limit (areaLimit)', () => {
    const doc = makeDoc([
      'q 40 150 300 80 re W n BT /F1 12 Tf 50 200 Td (Clipped paragraph text.) Tj ET Q',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Clipped paragraph');
    const r = editParagraph(ctx, fm, p.id);
    expect(r.plan.areaLimit.map((v) => Math.round(v))).toEqual([40, 70, 340, 150]);
    const block = doc.newIndirect(r.prepared.block.objectNumber);
    expect(block.get('BBox').toString()).toBe('[40 150 340 230]');
  });
});

describe('V5 marked content·ActualText', () => {
  it('MCID BDC outside BT: the block call goes inside that MC (pdf.js includeMarkedContent)', async () => {
    const doc = makeDoc([
      '/P <</MCID 0>> BDC BT /F1 12 Tf 50 230 Td (Tagged paragraph zero.) Tj ET EMC ' +
        '/P <</MCID 1>> BDC BT /F1 12 Tf 50 160 Td (Tagged paragraph one.) Tj ET EMC',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Tagged paragraph zero');
    const r = editParagraph(ctx, fm, p.id, 'Replaced tagged words.');
    expect(r.plan.insertion?.mcidKept).toBe(true);
    expect(r.plan.warnings.map((w) => w.kind)).toContain('tagged-structure-kept');
    const { pdfjsMarkedText } = await import('./helpers/engines.js');
    const marked = await pdfjsMarkedText(bytesOf(doc), 0);
    expect(marked.get(0)?.replace(/\s+/g, '')).toBe('Replacedtaggedwords.');
    expect(marked.get(1)?.replace(/\s+/g, '')).toBe('Taggedparagraphone.');
  });

  it('MC opened inside BT: moved before the BDC by rule 3, and reading-order-approximate if characters to keep lie in between', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Kept line before.) Tj 0 -40 Td /Span <</MCID 0>> BDC (Kept in mc. ) Tj (Target words here) Tj EMC ET',
    ]);
    const ctx0 = pageContext(doc, 0);
    const ctx = withParagraphs(ctx0, [
      paragraphOf(ctx0, charsOfText(ctx0, 'Target words here'), 0),
    ]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(ctx, fm, 0, 'New words');
    expect(r.plan.insertion).toEqual({ container: 'page', mode: 'split-bt', mcidKept: false });
    const kinds = r.plan.warnings.map((w) => w.kind);
    expect(kinds).toContain('reading-order-approximate');
    expect(kinds).toContain('tagged-structure-unlinked');
    expect(contentOf(doc)).toMatch(/ET q \/PEB0 Do Q BT [^]*?\/Span <<\/MCID 0>> BDC/);
  });

  it('a BMC inside BT (no tag) is also subject to rule 3: moved before the BMC', async () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Kept line before.) Tj 0 -40 Td /Artifact BMC (Target in bmc) Tj EMC (after) Tj ET',
    ]);
    const before = bytesOf(doc);
    const ctx0 = pageContext(doc, 0);
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, charsOfText(ctx0, 'Target in bmc'), 0)]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(ctx, fm, 0, 'Moved text');
    expect(r.plan.insertion).toEqual({ container: 'page', mode: 'split-bt', mcidKept: null });
    expect(contentOf(doc)).toMatch(/ET q \/PEB0 Do Q BT [^]*?\/Artifact BMC/);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [
      ctx.layout.paragraphs[0]!.bbox,
      r.result.summary.contentBox,
    ]);
  });

  for (const viaProperties of [false, true]) {
    it(`removes ActualText when all of it is erased (${viaProperties ? '/Properties 이름' : '인라인 사전'}), no old text in three-engine copies`, async () => {
      const bdc = viaProperties ? '/Span /AT0 BDC' : '/Span <</ActualText (OLDACTUAL)>> BDC';
      const doc = makeDoc(
        [
          `${bdc} BT /F1 12 Tf 50 200 Td (Visible glyph text.) Tj ET EMC BT /F1 12 Tf 50 120 Td (Other paragraph.) Tj ET`,
        ],
        (src) => {
          if (!viaProperties) return {};
          const d = src.newDictionary();
          d.put('ActualText', src.newString('OLDACTUAL'));
          return { Properties: { AT0: src.addObject(d) } };
        },
      );
      const before = bytesOf(doc);
      const { pageText } = await import('./helpers/engines.js');
      const shows = await Promise.all(
        (['mupdf', 'pdfjs', 'poppler'] as const).map(async (e) =>
          (await pageText(e, before, 0)).includes('OLDACTUAL'),
        ),
      );
      expect(shows.some((v) => v)).toBe(true);
      const ctx = pageContext(doc, 0);
      const fm = new FontManager(doc, fallbackFor(doc));
      const p = ctx.layout.paragraphs.find((q) => !q.text.includes('Other'))!;
      const r = editParagraph(ctx, fm, p.id, 'Fresh text without actual.');
      expect(r.plan.warnings.map((w) => w.kind)).toContain('actualtext-cleared');
      const after = bytesOf(doc);
      for (const e of ['mupdf', 'pdfjs', 'poppler'] as const) {
        const t = await pageText(e, after, 0);
        expect(t.includes('OLDACTUAL'), e).toBe(false);
        expect(t.replace(/\s+/g, ''), e).toContain('Freshtextwithoutactual.');
      }
      if (viaProperties) {
        const props = doc.findPage(0).get('Resources').get('Properties');
        expect(props.get('PEP0').isDictionary()).toBe(true);
        expect(props.get('PEP0').get('ActualText').isNull()).toBe(true);
        expect(contentOf(doc)).toContain('/Span /PEP0 BDC');
      }
    });
  }
});

describe('journal (MuPDF undo/redo): removal, insertion and writing inside an operation', () => {
  it('endOperation -> undo restores the original state, redo the edited state', async () => {
    const doc = makeDoc([THREE]);
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    // As in core, the fallback font and Info are created before the journal is turned on (contract D4/D9 amendment 1).
    doc.enableJournal();
    const p = findParagraph(ctx, 'Bravo paragraph');
    doc.beginOperation('edit');
    const r = editParagraph(ctx, fm, p.id, '브라보 문단을 한글로 바꿈');
    doc.endOperation();
    const edited = bytesOf(doc);
    doc.undo();
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
    doc.redo();
    await expectNoChangeOutside(edited, bytesOf(doc), 0, []);
    expect(r.warnings.map((w) => w.kind)).toContain('font-fallback');
  });

  it('abandonOperation cancels the draft, the fallback font added outside the operation remains and the next edit uses the same object', async () => {
    const doc = makeDoc([THREE]);
    const before = bytesOf(doc);
    const source = fallbackFor(doc);
    const fm = new FontManager(doc, source);
    // As in core, the fallback font and Info are created before the journal is turned on (contract D4/D9 amendment 1).
    doc.enableJournal();
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    doc.beginOperation('draft');
    editParagraph(ctx, fm, p.id, '취소할 초안');
    doc.abandonOperation();
    await expectNoChangeOutside(before, bytesOf(doc), 0, []);
    doc.beginOperation('edit');
    const r = editParagraph(pageContext(doc, 0), fm, p.id, '새 편집 한글');
    doc.endOperation();
    const { pageText } = await import('./helpers/engines.js');
    expect((await pageText('mupdf', bytesOf(doc), 0)).replace(/\s+/g, '')).toContain('새편집한글');
    // The edit block references the fallback font object that core put in (FontManager does not add fonts).
    const font = doc.newIndirect(r.prepared.block.objectNumber).get('Resources').get('Font');
    const refs: number[] = [];
    font.forEach((v) => void refs.push(v.asIndirect()));
    expect(refs).toContain(source.ref()!.asIndirect());
    expect(source.ref()!.resolve().get('Subtype').asName()).toBe('Type0');
  });

  it('new edit after undoing an edit that used the fallback: the fallback font object remains and is reused', async () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, fallbackFor(doc));
    // As in core, the fallback font and Info are created before the journal is turned on (contract D4/D9 amendment 1).
    doc.enableJournal();
    const p = findParagraph(pageContext(doc, 0), 'Bravo paragraph');
    doc.beginOperation('edit1');
    editParagraph(pageContext(doc, 0), fm, p.id, '첫 편집');
    doc.endOperation();
    doc.undo();
    doc.beginOperation('edit2');
    editParagraph(pageContext(doc, 0), fm, p.id, '둘째 편집');
    doc.endOperation();
    const { pageText } = await import('./helpers/engines.js');
    expect((await pageText('poppler', bytesOf(doc), 0)).replace(/\s+/g, '')).toContain('둘째편집');
  });
});

describe('re-editing (rewrite-block) and the edit block list', () => {
  it('same session: a paragraph containing block characters -> only the block is rewritten (no Form nesting)', async () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r1 = editParagraph(ctx, fm, p.id, 'First rewrite of bravo with 한글 words.');
    const ctx2 = pageContext(doc, 0);
    expect(ctx2.editBlocks).toEqual([r1.prepared.block]);
    const p2 = findParagraph(ctx2, 'First rewrite');
    const r2 = editParagraph(ctx2, fm, p2.id, 'Second rewrite.');
    expect(r2.plan.insertion?.mode).toBe('rewrite-block');
    expect(r2.plan.target.editedBlock).toBe(r1.prepared.editId);
    expect(r2.plan.runs.map((x) => x.text).join('')).toBe(r1.text);
    expect(r2.prepared.block.objectNumber).toBe(r1.prepared.block.objectNumber);
    expect(r2.prepared.changedObjects).toEqual(
      expect.arrayContaining([r1.prepared.block.objectNumber]),
    );
    const blocks = pageContext(doc, 0).editBlocks;
    expect(blocks).toEqual([
      { editId: r2.prepared.editId, objectNumber: r1.prepared.block.objectNumber },
    ]);
    expect((contentOf(doc).match(/Do/g) ?? []).length).toBe(1);
    await expectOrder(bytesOf(doc), 0, 'It has two lines.', 'Second rewrite.', 'Charlie paragraph');
  });

  it('new session after reopening: restores the start state (shape, format) from /PdfEditorFormat', () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r1 = editParagraph(ctx, fm, p.id, 'Saved block text 저장 블록.');
    const doc2 = reopen(doc, 'garbage=yes,compress,objstms');
    const ctx2 = pageContext(doc2, 0);
    expect(ctx2.editBlocks).toHaveLength(1);
    const fm2 = new FontManager(doc2, fallbackFor(doc2));
    const p2 = findParagraph(ctx2, 'Saved block text');
    const plan = editParagraph(ctx2, fm2, p2.id, 'Edited again after reopen.').plan;
    expect(plan.insertion?.mode).toBe('rewrite-block');
    expect(plan.runs.map((x) => x.text).join('')).toBe(r1.text);
    expect(plan.format.area).toEqual(r1.plan.format.area);
    // sourceChar is determined again from the characters inside the block (current PageModel).
    const sc = plan.runs[0]!.style.sourceChar;
    expect(ctx2.model.chars[sc]!.text).toBe('S');
    expect(plan.charIndexOfOffset.filter((c) => c >= 0).length).toBeGreaterThan(10);
  });

  it('also reads /PdfEditorFormat from an earlier build (overflow shrink, fontScale 0.85) and discards those fields', () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r1 = editParagraph(ctx, fm, p.id, 'Legacy block text 이전 블록.');
    // Fix it to the shape written by the earlier build: format.overflow 'shrink', shrink ratio 0.85.
    const block = doc.newIndirect(r1.prepared.block.objectNumber);
    const json = JSON.parse(block.get('PdfEditorFormat').asString()) as Record<string, unknown> & {
      format: Record<string, unknown>;
    };
    expect(json.format).not.toHaveProperty('overflow');
    json.format.overflow = 'shrink';
    json.format.fontScale = 0.85;
    json.fontScale = 0.85;
    block.put('PdfEditorFormat', doc.newString(JSON.stringify(json)));
    const doc2 = reopen(doc, 'garbage=yes,compress,objstms');
    const ctx2 = pageContext(doc2, 0);
    const fm2 = new FontManager(doc2, fallbackFor(doc2));
    const p2 = findParagraph(ctx2, 'Legacy block text');
    const r2 = editParagraph(ctx2, fm2, p2.id);
    // The block format is used as is (does not fall back to extracted text), and the old fields are absent.
    expect(r2.plan.insertion?.mode).toBe('rewrite-block');
    expect(r2.plan.runs.map((x) => x.text).join('')).toBe(r1.text);
    expect(r2.plan.format).toEqual(r1.plan.format);
    expect(r2.plan.format).not.toHaveProperty('overflow');
    expect(r2.plan.format).not.toHaveProperty('fontScale');
    // They also do not remain in the /PdfEditorFormat of the rewritten block.
    const rewritten = JSON.parse(
      doc2.newIndirect(r2.prepared.block.objectNumber).get('PdfEditorFormat').asString(),
    ) as { format: Record<string, unknown> };
    expect(rewritten.format).not.toHaveProperty('overflow');
    expect(rewritten.format).not.toHaveProperty('fontScale');
    // If the region has a broken format, start with extracted text + block box.
    const block2 = doc2.newIndirect(r2.prepared.block.objectNumber);
    const broken = JSON.parse(block2.get('PdfEditorFormat').asString()) as {
      format: Record<string, unknown>;
    };
    broken.format.area = 'expand';
    block2.put('PdfEditorFormat', doc2.newString(JSON.stringify(broken)));
    const plan3 = editParagraph(pageContext(doc2, 0), fm2, p2.id).plan;
    expect(plan3.format.area).not.toEqual(r1.plan.format.area);
    expect(plan3.format.lineHeight).toBeCloseTo(plan3.runs[0]!.style.size * 1.2, 6);
  });

  it('if another tool modified the block stream, start with extracted text + block box', () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, fallbackFor(doc));
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r1 = editParagraph(ctx, fm, p.id, 'Original block words.');
    const block = doc.newIndirect(r1.prepared.block.objectNumber);
    const s = block
      .readStream()
      .asString()
      .replace(/\[[^\]]*\] TJ/, '[(Tampered)] TJ');
    block.writeStream(s);
    const ctx2 = pageContext(doc, 0);
    const p2 = findParagraph(ctx2, 'Tampered');
    const plan = editParagraph(ctx2, fm, p2.id).plan;
    expect(
      plan.runs
        .map((x) => x.text)
        .join('')
        .replace(/\s+/g, ''),
    ).toBe(p2.text.replace(/\s+/g, ''));
  });
});
