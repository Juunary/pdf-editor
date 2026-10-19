import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { FontManager } from '../src/index.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { editParagraph, loadFallback } from './helpers/edit-driver.js';
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

/** 계약 8.1 합성 PDF: 제거·삽입(D2·D3)과 V2·V3 세 엔진 확인. */
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

describe('V2 before-bt: 삽입점에 q /이름 Do Q', () => {
  it('영역 밖 렌더 0 px(세 엔진), 재추출 순서는 원래 자리', async () => {
    const doc = makeDoc([THREE]);
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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

  it('제거·삽입으로 바뀐 객체 = 쪽 사전·콘텐츠 스트림·편집 블록(+Info)', () => {
    const doc = makeDoc([THREE, 'BT /F1 12 Tf 50 200 Td (Other page) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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

describe('V2 기하 근접: 같은 MuPDF 블록 안의 두 문단', () => {
  it('붙어 있는 다음 문단을 길게 바꿔도 재추출 순서가 원래 자리(세 엔진)', async () => {
    const doc = makeDoc([
      'BT /F1 11 Tf 13 TL 50 260 Td (First block line one,) Tj T* (first block line two.) Tj T* ' +
        '(Second part line three) Tj T* (second part line four.) Tj ET BT /F1 11 Tf 50 150 Td (Tail paragraph.) Tj ET',
    ]);
    const before = bytesOf(doc);
    const ctx0 = pageContext(doc, 0);
    const a = charsOfText(ctx0, 'First block line one,first block line two.');
    const b = charsOfText(ctx0, 'Second part line threesecond part line four.');
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, a, 0), paragraphOf(ctx0, b, 1)]);
    const fm = new FontManager(doc, loadFallback);
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

describe('V3 split-bt: BT 나누기', () => {
  const ONE_BT =
    'BT /F1 11 Tf 13 TL 0.98 0 0 1.02 50.25 260.125 Tm (Kept first paragraph line.) Tj ' +
    '0 -40 Td (Target paragraph line one) Tj T* (and the target line two.) Tj ' +
    '0 -40 Td (Kept last paragraph stays.) Tj ET';

  it('같은 BT 의 남은 글자 위치·모양 그대로(소수 계수 Tm, 세 엔진 0 px)', async () => {
    const doc = makeDoc([ONE_BT]);
    const before = bytesOf(doc);
    const st0 = stextChars(doc, 0);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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

  it('Tm 이 마지막 줄 설정 연산이면 원 피연산자 바이트를 그대로 쓴다', () => {
    const doc = makeDoc([
      'BT /F1 11 Tf 50 260 Td (Kept first line here.) Tj 0.98 0 0 1.02 50.123456 200.5 Tm (Target words) Tj ET',
    ]);
    const ctx0 = pageContext(doc, 0);
    const target = charsOfText(ctx0, 'Target words');
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, target, 0)]);
    const fm = new FontManager(doc, loadFallback);
    const r = editParagraph(ctx, fm, 0);
    expect(r.plan.insertion?.mode).toBe('split-bt');
    expect(contentOf(doc)).toContain('Do Q BT 0.98 0 0 1.02 50.123456 200.5 Tm');
  });

  it('줄 행렬은 원 줄 설정 연산을 같은 순서로 다시 실행해 되돌린다(Td 누적·TD·T*, 세 엔진 0 px)', async () => {
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
    const fm = new FontManager(doc, loadFallback);
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
    it(`연산 일부만 지우기·연산 안 나누기: ${label}`, async () => {
      const doc = makeDoc([content]);
      const before = bytesOf(doc);
      const st0 = stextChars(doc, 0);
      const ctx0 = pageContext(doc, 0);
      const chars = charsOfText(ctx0, target);
      const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, chars, 0)]);
      const fm = new FontManager(doc, loadFallback);
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

describe('Form 안 텍스트: 사용 경로 바이트 복제(D2)', () => {
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
    it(`${nested ? '중첩 Form(상위 체인 포함)' : '공유 Form'}: 복제본에서 제거, 다른 쪽·원 Form 불변, /StructParents 제거`, async () => {
      const doc = formDoc(nested);
      const before = bytesOf(doc);
      const page1 = doc.findPage(1).toString();
      const ctx = pageContext(doc, 0);
      const fm = new FontManager(doc, loadFallback);
      const p = findParagraph(ctx, 'Form paragraph text one');
      const formNums = ctx.map.ops
        .find((o) => o.text && o.formPath.length > 0)!
        .formPath.map((s) => s.objectNumber);
      const formBytes = formNums.map((n) => doc.newIndirect(n).readStream().asString());
      const r = editParagraph(ctx, fm, p.id, 'Form text replaced in the clone.');
      expect(r.plan.insertion?.container).toBe('form-clone');
      expect(r.plan.removal.formInstances).toBe(nested ? 2 : 1);
      expect(r.plan.warnings.map((w) => w.kind)).toContain('tagged-structure-unlinked');
      // 원 Form 스트림·다른 쪽은 그대로.
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

  it('공유 콘텐츠 스트림: 사본을 만들어 이 쪽 칸만 바꾼다', async () => {
    const src = new mupdf.PDFDocument();
    const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
    src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, { Font: { F1 } }, THREE));
    src.insertPage(-1, src.addPage([0, 0, 400, 300], 0, { Font: { F1 } }, ''));
    src.findPage(1).put('Contents', src.findPage(0).get('Contents'));
    const doc = reopen(src);
    const before = bytesOf(doc);
    const shared = doc.findPage(0).get('Contents').asIndirect();
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r = editParagraph(ctx, fm, p.id, 'Bravo changed.');
    expect(doc.findPage(1).get('Contents').asIndirect()).toBe(shared);
    expect(doc.findPage(0).get('Contents').asIndirect()).not.toBe(shared);
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 1, []);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
  });
});

describe('좌표: y 반전 CTM, /Rotate 90·270, 앞 BT 의 Tr 3, 클립', () => {
  it('y 반전 CTM: 블록 /Matrix 가 상쇄해 새 텍스트가 바로 선다', async () => {
    const doc = makeDoc([
      'q 1 0 0 -1 0 300 cm BT /F1 12 Tf 1 0 0 -1 50 40 Tm (Upright flipped paragraph.) Tj ET ' +
        'BT /F1 12 Tf 1 0 0 -1 50 120 Tm (Second flipped paragraph.) Tj ET Q',
    ]);
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    const p = findParagraph(ctx, 'Upright flipped');
    const r = editParagraph(ctx, fm, p.id, 'Upright text after edit.');
    const after = bytesOf(doc);
    await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
    await expectOrder(after, 0, null, r.text, 'Second flipped paragraph.');
  });

  for (const rotate of [90, 270] as const) {
    it(`/Rotate ${rotate}: 화면 가로 문단 편집`, async () => {
      // 화면(페이지 공간)에서 가로가 되도록 사용자 공간 Tm 을 만든다.
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
      const fm = new FontManager(doc, loadFallback);
      const p = findParagraph(ctx, 'Rotated page first');
      const r = editParagraph(ctx, fm, p.id, 'Rotated page text edited.');
      const after = bytesOf(doc);
      await expectNoChangeOutside(before, after, 0, [p.bbox, r.result.summary.contentBox]);
      await expectOrder(after, 0, null, r.text, 'Rotated page second paragraph.');
      const st = stextChars(doc, 0);
      const w = wordOrigins(st, 'Rotated page text edited.')!;
      // 새 글자는 화면 가로(같은 y, x 증가).
      expect(Math.abs(w.at(-1)!.y - w[0]!.y)).toBeLessThan(0.01);
      expect(w.at(-1)!.x).toBeGreaterThan(w[0]!.x);
    });
  }

  it('앞 BT 가 남긴 Tr 3 을 물려받지 않는다(블록이 Tr 을 명시)', async () => {
    const doc = makeDoc([
      'BT 3 Tr /F1 12 Tf 50 270 Td (hidden ocr layer) Tj ET BT /F1 12 Tf 50 200 Td 0 Tr (Visible paragraph text.) Tj ET',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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

  it('직사각형 클립은 영역 상한(areaLimit)에 들어간다', () => {
    const doc = makeDoc([
      'q 40 150 300 80 re W n BT /F1 12 Tf 50 200 Td (Clipped paragraph text.) Tj ET Q',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    const p = findParagraph(ctx, 'Clipped paragraph');
    const r = editParagraph(ctx, fm, p.id);
    expect(r.plan.areaLimit.map((v) => Math.round(v))).toEqual([40, 70, 340, 150]);
    const block = doc.newIndirect(r.prepared.block.objectNumber);
    expect(block.get('BBox').toString()).toBe('[40 150 340 230]');
  });
});

describe('V5 marked content·ActualText', () => {
  it('BT 바깥 MCID BDC: 블록 호출이 그 MC 안에 들어간다(pdf.js includeMarkedContent)', async () => {
    const doc = makeDoc([
      '/P <</MCID 0>> BDC BT /F1 12 Tf 50 230 Td (Tagged paragraph zero.) Tj ET EMC ' +
        '/P <</MCID 1>> BDC BT /F1 12 Tf 50 160 Td (Tagged paragraph one.) Tj ET EMC',
    ]);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    const p = findParagraph(ctx, 'Tagged paragraph zero');
    const r = editParagraph(ctx, fm, p.id, 'Replaced tagged words.');
    expect(r.plan.insertion?.mcidKept).toBe(true);
    expect(r.plan.warnings.map((w) => w.kind)).toContain('tagged-structure-kept');
    const { pdfjsMarkedText } = await import('./helpers/engines.js');
    const marked = await pdfjsMarkedText(bytesOf(doc), 0);
    expect(marked.get(0)?.replace(/\s+/g, '')).toBe('Replacedtaggedwords.');
    expect(marked.get(1)?.replace(/\s+/g, '')).toBe('Taggedparagraphone.');
  });

  it('BT 안에서 열린 MC: 규칙 3 으로 BDC 앞으로 옮기고, 사이에 남길 글자가 있으면 reading-order-approximate', () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Kept line before.) Tj 0 -40 Td /Span <</MCID 0>> BDC (Kept in mc. ) Tj (Target words here) Tj EMC ET',
    ]);
    const ctx0 = pageContext(doc, 0);
    const ctx = withParagraphs(ctx0, [
      paragraphOf(ctx0, charsOfText(ctx0, 'Target words here'), 0),
    ]);
    const fm = new FontManager(doc, loadFallback);
    const r = editParagraph(ctx, fm, 0, 'New words');
    expect(r.plan.insertion).toEqual({ container: 'page', mode: 'split-bt', mcidKept: false });
    const kinds = r.plan.warnings.map((w) => w.kind);
    expect(kinds).toContain('reading-order-approximate');
    expect(kinds).toContain('tagged-structure-unlinked');
    expect(contentOf(doc)).toMatch(/ET q \/PEB0 Do Q BT [^]*?\/Span <<\/MCID 0>> BDC/);
  });

  it('BT 안 BMC(태그 없음)도 규칙 3 대상: BMC 앞으로 옮긴다', async () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Kept line before.) Tj 0 -40 Td /Artifact BMC (Target in bmc) Tj EMC (after) Tj ET',
    ]);
    const before = bytesOf(doc);
    const ctx0 = pageContext(doc, 0);
    const ctx = withParagraphs(ctx0, [paragraphOf(ctx0, charsOfText(ctx0, 'Target in bmc'), 0)]);
    const fm = new FontManager(doc, loadFallback);
    const r = editParagraph(ctx, fm, 0, 'Moved text');
    expect(r.plan.insertion).toEqual({ container: 'page', mode: 'split-bt', mcidKept: null });
    expect(contentOf(doc)).toMatch(/ET q \/PEB0 Do Q BT [^]*?\/Artifact BMC/);
    await expectNoChangeOutside(before, bytesOf(doc), 0, [
      ctx.layout.paragraphs[0]!.bbox,
      r.result.summary.contentBox,
    ]);
  });

  for (const viaProperties of [false, true]) {
    it(`ActualText 를 모두 지우면 뺀다(${viaProperties ? '/Properties 이름' : '인라인 사전'}), 세 엔진 복사에 옛 텍스트 없음`, async () => {
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
      const fm = new FontManager(doc, loadFallback);
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

describe('저널(MuPDF undo/redo): 작업 안에서 제거·삽입·쓰기', () => {
  it('endOperation → undo 로 원상태, redo 로 편집 상태', async () => {
    const doc = makeDoc([THREE]);
    doc.enableJournal();
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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

  it('abandonOperation 으로 초안 취소, 폴백 폰트가 사라져도 다음 편집에서 다시 넣는다', async () => {
    const doc = makeDoc([THREE]);
    doc.enableJournal();
    const before = bytesOf(doc);
    const fm = new FontManager(doc, loadFallback);
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
    // 폴백 폰트 사전은 표시를 갖는다.
    const font = doc.newIndirect(r.prepared.block.objectNumber).get('Resources').get('Font');
    let marked = 0;
    font.forEach((v) => {
      if (v.get('PdfEditorFallback').isBoolean()) marked++;
    });
    expect(marked).toBe(1);
  });

  it('폴백을 넣은 편집 undo 뒤 새 편집 → 저장: 폰트 다시 넣음', async () => {
    const doc = makeDoc([THREE]);
    doc.enableJournal();
    const fm = new FontManager(doc, loadFallback);
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

describe('재편집(rewrite-block)과 편집 블록 목록', () => {
  it('같은 세션: 블록 글자를 포함한 문단 → 블록만 다시 쓴다(Form 중첩 없음)', async () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, loadFallback);
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

  it('재열기 뒤 새 세션: /PdfEditorFormat 으로 시작 상태(모양·형식)를 복원한다', () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, loadFallback);
    const ctx = pageContext(doc, 0);
    const p = findParagraph(ctx, 'Bravo paragraph');
    const r1 = editParagraph(ctx, fm, p.id, 'Saved block text 저장 블록.');
    const doc2 = reopen(doc, 'garbage=yes,compress,objstms');
    const ctx2 = pageContext(doc2, 0);
    expect(ctx2.editBlocks).toHaveLength(1);
    const fm2 = new FontManager(doc2, loadFallback);
    const p2 = findParagraph(ctx2, 'Saved block text');
    const plan = editParagraph(ctx2, fm2, p2.id, 'Edited again after reopen.').plan;
    expect(plan.insertion?.mode).toBe('rewrite-block');
    expect(plan.runs.map((x) => x.text).join('')).toBe(r1.text);
    expect(plan.format.area).toEqual(r1.plan.format.area);
    // sourceChar 는 블록 안 글자(현재 PageModel)로 다시 정해진다.
    const sc = plan.runs[0]!.style.sourceChar;
    expect(ctx2.model.chars[sc]!.text).toBe('S');
    expect(plan.charIndexOfOffset.filter((c) => c >= 0).length).toBeGreaterThan(10);
  });

  it('다른 도구가 블록 스트림을 고쳤으면 추출 텍스트 + 블록 상자로 시작한다', () => {
    const doc = makeDoc([THREE]);
    const fm = new FontManager(doc, loadFallback);
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
