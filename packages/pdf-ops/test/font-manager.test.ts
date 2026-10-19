import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { TextRun } from '@pdf-editor/shared-types';
import {
  FontManager,
  FULL_SAVE_OPTIONS,
  subsetFontBytes,
  type ParagraphEditContext,
} from '../src/index.js';
import { findParagraph, loadModules, pageContext, reopen } from './helpers/edit-context.js';
import { editParagraph, loadFallback } from './helpers/edit-driver.js';
import { inkInside, pageText, raster, squash } from './helpers/engines.js';
import { engines, makeDoc } from './helpers/fixtures-m3.js';

/** 계약 D4 폰트 배정과 V4(외곽선·폭 판정 = 렌더, 폴백 ToUnicode 복사·검색). */
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

/** 클러스터별 배정 결과: o = 원본, f = 폴백, - = 없음. */
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
 * Noto Sans KR 을 Type0(Identity-H)로 넣은 문서. subsetText 가 있으면 FontFile2 를 그 글자 외곽선만 남긴 서브셋
 * 바이트로 바꾼다(gid 유지, ToUnicode·/W 는 전체 그대로: MuPDF·Word 류 서브셋과 같은 상태).
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

describe('원본 폰트 역매핑(i)·형식(iv)', () => {
  it('Type1(단순, WinAnsi): 라틴·악센트는 원본, 한글은 폴백', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Helvetica sample text.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    expect(faces(fm, ctx, runsOf(ctx, 'Helvetica', 'Héllo 한'))).toBe('oooooof');
  });

  it('TrueType(단순)·Type0(Identity-H) 폰트 역매핑', () => {
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
    const fm = new FontManager(doc, loadFallback);
    expect(faces(fm, ctx, runsOf(ctx, 'Truetype', 'Text 가'))).toBe('ooooof');
    const { doc: d2 } = notoDoc('가나다 abc');
    const c2 = pageContext(d2, 0);
    expect(faces(new FontManager(d2, loadFallback), c2, runsOf(c2, '가나다', '다나가 cab'))).toBe(
      'ooooooo',
    );
  });

  it('후보가 여럿이면 이 쪽에서 쓰인 코드를 우선한다', () => {
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
    const fm = new FontManager(doc, loadFallback);
    const runs = runsOf(ctx, 'Used', 'A');
    const seg = fm.assign(ctx, 'A', runs).segments[0]!;
    expect(seg.face?.kind).toBe('original');
    const enc0 = seg.face!.source.kind === 'pdf-widths' ? seg.face!.source.encode('A') : null;
    expect([...enc0![0]!.code]).toEqual([200]);
  });
});

describe('외곽선(ii)·폭(iii) 판정과 V4(렌더 결과와 같음)', () => {
  it('서브셋이 외곽선만 비운 글리프는 gid 가 있어도 원본으로 쓰지 않는다(세 엔진 잉크로 확인)', async () => {
    const chars = '가나다라마abcxyz';
    const { doc, font } = notoDoc('가나 ab', '가나다 abc');
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
    const decided = faces(fm, ctx, runsOf(ctx, '가나', chars));
    // 서브셋에 남긴 글리프(가나다abc)만 원본.
    expect(decided).toBe('oooffooofff');
    // 같은 폰트로 각 글자를 강제로 그려 세 엔진 잉크를 본다.
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

  it('명세 폭 0 인 코드는 원본으로 쓰지 않는다(pdfTeX 류 /Widths)', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Width zero sample.) Tj ET']);
    // 표준 14 폰트라 /Widths 가 없다. 32–126 폭을 넣고 'x' 만 0 으로 둔다.
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
    const fm = new FontManager(doc, loadFallback);
    expect(faces(fm, ctx, runsOf(ctx, 'Width zero', 'wxy'))).toBe('ofo');
  });
});

describe('글자 단위 폴백과 glyph-missing', () => {
  it('폴백 섞인 줄, 두 폰트 모두 없는 글자는 face null·경고, 줄바꿈은 앞 폰트', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Mixed fallback line.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, loadFallback);
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
    expect(segments.at(-1)!.end).toBe(runs[0]!.text.length);
  });
});

describe('폴백 폰트 수명·저장 서브셋(D4·D9)', () => {
  it('저장 작업 안에서만 서브셋: 저장 파일은 작고 세 엔진이 한글을 추출·검색, 작업 문서는 전체 폰트 유지', async () => {
    const doc = makeDoc([
      'BT /F1 12 Tf 50 250 Td (Before paragraph.) Tj ET BT /F1 12 Tf 50 200 Td (Target paragraph.) Tj ET',
    ]);
    doc.enableJournal();
    const fm = new FontManager(doc, loadFallback);
    const ctx = pageContext(doc, 0);
    doc.beginOperation('edit');
    const r = editParagraph(ctx, fm, findParagraph(ctx, 'Target').id, '서브셋 저장 확인 문장');
    doc.endOperation();
    const fontRef = (() => {
      let ref: mupdf.PDFObject | null = null;
      doc
        .newIndirect(r.prepared.block.objectNumber)
        .get('Resources')
        .get('Font')
        .forEach((v) => {
          if (!v.get('PdfEditorFallback').isNull()) ref = v;
        });
      return ref!;
    })();
    const file = () => fontRef.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    const fullLength = file().readStream().getLength();
    doc.beginOperation('save');
    fm.finalizeForSave();
    const saved = doc.saveToBuffer(FULL_SAVE_OPTIONS).asUint8Array().slice();
    doc.abandonOperation();
    expect(file().readStream().getLength()).toBe(fullLength);
    expect(fontRef.get('PdfEditorFallback').asBoolean()).toBe(true);
    expect(doc.canUndo()).toBe(true);
    const reopened = mupdf.Document.openDocument(saved, 'application/pdf') as mupdf.PDFDocument;
    let subsetLen = 0;
    let mark = '';
    reopened
      .findPage(0)
      .get('Resources')
      .get('XObject')
      .forEach((x) => {
        x.get('Resources')
          .get('Font')
          .forEach((f) => {
            if (f.get('PdfEditorFallback').isNull()) return;
            mark = f.get('PdfEditorFallback').toString();
            subsetLen = f
              .get('DescendantFonts')
              .get(0)
              .get('FontDescriptor')
              .get('FontFile2')
              .readStream()
              .getLength();
          });
      });
    expect(mark).toBe('/Subset');
    expect(subsetLen).toBeGreaterThan(0);
    expect(subsetLen).toBeLessThan(fullLength / 10);
    for (const e of engines()) {
      expect(squash(await pageText(e, saved, 0)), e).toContain('서브셋저장확인문장');
    }
    // MuPDF 검색: 하이라이트 중심이 배치한 글자 상자 안.
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
