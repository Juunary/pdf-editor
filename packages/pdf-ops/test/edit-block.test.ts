import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { TextRun } from '@pdf-editor/shared-types';
import { FontManager, pdfaDeclared, planParagraphEdit, recordEditMetadata } from '../src/index.js';
import { parseEditsInfo } from '../src/edit-meta.js';
import { findParagraph, loadModules, pageContext } from './helpers/edit-context.js';
import { editParagraph, fallbackFor } from './helpers/edit-driver.js';
import { inkInside, raster } from './helpers/engines.js';
import { bytesOf, engines, makeDoc, stextChars, wordOrigins } from './helpers/fixtures-m3.js';

/** 계약 5.5 쓰기·5.6 메타. */
beforeAll(async () => {
  await loadModules();
});

const blockStream = (doc: mupdf.PDFDocument, num: number) =>
  doc.newIndirect(num).readStream().asString();

describe('writeEditBlock(5.5)', () => {
  it('텍스트 상태를 모두 명시하고 BT·ET 를 q·Q 로 감싼다', () => {
    const doc = makeDoc(['BT /F1 12 Tf 2 Tc 3 Tw 80 Tz 5 Ts 50 200 Td (State paragraph.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const r = editParagraph(ctx, fm, findParagraph(ctx, 'State paragraph').id);
    const s = blockStream(doc, r.prepared.block.objectNumber);
    expect(s.startsWith('q\n0 Tc 0 Tw 100 Tz 0 TL 0 Ts\nBT\n')).toBe(true);
    expect(s.trimEnd().endsWith('ET\nQ')).toBe(true);
    expect(s).toContain('0 Tr');
    const res = doc.newIndirect(r.prepared.block.objectNumber).get('Resources');
    expect(res.get('Font').get('F0').asIndirect()).toBe(
      doc.findPage(0).get('Resources').get('Font').get('F1').asIndirect(),
    );
  });

  it('채움 색을 원래 색공간 그대로 쓴다(CMYK·CalRGB 리소스 복사)', () => {
    const doc = makeDoc(
      [
        'BT /F1 12 Tf 0.1 0.2 0.3 0.4 k 50 240 Td (Cmyk paragraph text.) Tj ET ' +
          '/CS0 cs 0.2 0.4 0.6 sc BT /F1 12 Tf 50 160 Td (Calrgb paragraph text.) Tj ET',
      ],
      (src) => ({
        ColorSpace: { CS0: src.addObject(['CalRGB', { WhitePoint: [0.9505, 1, 1.089] }]) },
      }),
    );
    const fm = new FontManager(doc, fallbackFor(doc));
    const r1 = editParagraph(
      pageContext(doc, 0),
      fm,
      findParagraph(pageContext(doc, 0), 'Cmyk').id,
    );
    expect(blockStream(doc, r1.prepared.block.objectNumber)).toContain('0.1 0.2 0.3 0.4 k');
    const ctx = pageContext(doc, 0);
    const r2 = editParagraph(ctx, fm, findParagraph(ctx, 'Calrgb').id);
    const s = blockStream(doc, r2.prepared.block.objectNumber);
    expect(s).toContain('/CS0 cs\n0.2 0.4 0.6 sc');
    const cs = doc
      .newIndirect(r2.prepared.block.objectNumber)
      .get('Resources')
      .get('ColorSpace')
      .get('CS0');
    expect(cs.resolve().get(0).asName()).toBe('CalRGB');
  });

  it('원 글자의 ExtGState 가 삽입점과 다르면 블록 안에서 gs 로 재현한다', async () => {
    const doc = makeDoc(['BT /GS1 gs /F1 24 Tf 50 200 Td (Halfalpha) Tj ET'], (src) => ({
      ExtGState: { GS1: src.addObject({ Type: 'ExtGState', ca: 0.5 }) },
    }));
    const before = bytesOf(doc);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Halfalpha');
    const r = editParagraph(ctx, fm, p.id);
    expect(r.plan.insertion?.mode).toBe('before-bt');
    const s = blockStream(doc, r.prepared.block.objectNumber);
    expect(s).toContain('/GS0 gs');
    const gs = doc
      .newIndirect(r.prepared.block.objectNumber)
      .get('Resources')
      .get('ExtGState')
      .get('GS0');
    expect(gs.get('ca').asNumber()).toBe(0.5);
    // 같은 텍스트·같은 알파: 렌더가 원본과 같다(MuPDF).
    const a = await raster('mupdf', before, 0);
    const b = await raster('mupdf', bytesOf(doc), 0);
    expect(Math.abs(inkInside(a, p.bbox) - inkInside(b, p.bbox))).toBeLessThan(
      inkInside(a, p.bbox) * 0.05 + 4,
    );
  });

  it('글리프 위치 = 배치 결과(TJ 숫자 보정), 줄 끝 공백 글리프를 쓴다', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 230 Td (Position check paragraph.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Position check');
    // 좁은 영역으로 줄 나눔을 만든다.
    const plan0 = { ...p, bbox: [50, p.bbox[1], 130, p.bbox[3]] as typeof p.bbox };
    const ctxN = { ...ctx, layout: { ...ctx.layout, paragraphs: [plan0] } };
    const r = editParagraph(ctxN, fm, p.id, 'alpha beta gamma delta epsilon zeta');
    expect(r.result.lines.length).toBeGreaterThan(1);
    expect(r.result.lines[0]!.at(-1)!.code).toEqual(Uint8Array.of(0x20));
    const st = stextChars(doc, 0);
    for (const line of r.result.lines) {
      for (const g of line) {
        const ch = 'alpha beta gamma delta epsilon zeta'[g.offset]!;
        if (ch === ' ') continue;
        const hit = st.find(
          (c) => c.c === ch && Math.abs(c.x - g.x) < 0.01 && Math.abs(c.y - g.y) < 0.01,
        );
        expect(hit, `${ch}@${g.x},${g.y}`).toBeDefined();
      }
    }
    const words = stextChars(doc, 0)
      .map((c) => c.c)
      .join('');
    expect(words).toMatch(/beta\s/);
  });

  it('폴백 폰트 굵게·기울임 구간은 합성(2 Tr·선 두께, Tm 기울기)과 경고', async () => {
    const doc = makeDoc(['BT /F1 14 Tf 50 200 Td (Styled paragraph.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Styled');
    const start = planParagraphEdit(ctx, fm, p.id).runs[0]!.style;
    const runs: TextRun[] = [
      { text: '굵은 ', style: { ...start, bold: true } },
      { text: '기울임', style: { ...start, italic: true } },
    ];
    const r = editParagraph(ctx, fm, p.id, runs);
    expect(r.warnings.map((w) => w.kind)).toContain('synthetic-style');
    const s = blockStream(doc, r.prepared.block.objectNumber);
    expect(s).toContain('2 Tr');
    expect(s).toMatch(/0\.42 w/);
    expect(s).toMatch(/ 0\.2 1 [\d.]+ [\d.]+ Tm/);
    const bytes = bytesOf(doc);
    for (const e of engines()) {
      expect(inkInside(await raster(e, bytes, 0), r.result.summary.contentBox), e).toBeGreaterThan(
        50,
      );
    }
    const st = stextChars(doc, 0);
    expect(wordOrigins(st, '굵은')).not.toBeNull();
  });
});

describe('저장 메타(5.6)', () => {
  it('Info /PdfEditorEdits 합집합, /ModDate 갱신, /Producer 유지', () => {
    const doc = makeDoc(['', '', '']);
    const info = doc.addObject(doc.newDictionary());
    info.put('Producer', doc.newString('Original producer'));
    doc.getTrailer().put('Info', info);
    recordEditMetadata(doc, { pages: [0], structureNotUpdated: false });
    const d = doc.getTrailer().get('Info');
    expect(d.get('PdfEditorEdits').asString()).toBe('pages=1; structure=n/a');
    recordEditMetadata(doc, { pages: [2, 0], structureNotUpdated: true });
    expect(d.get('PdfEditorEdits').asString()).toBe('pages=1,3; structure=not-updated');
    expect(d.get('ModDate').asString()).toMatch(/^D:\d{14}Z$/);
    expect(d.get('Producer').asString()).toBe('Original producer');
    expect(parseEditsInfo('pages=2,5; structure=n/a')).toEqual({ pages: [2, 5], structure: 'n/a' });
  });

  it('PDF/A 선언(XMP pdfaid:part) 확인', () => {
    const doc = makeDoc(['']);
    expect(pdfaDeclared(doc)).toBe(false);
    const xmp =
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part></rdf:Description></rdf:RDF></x:xmpmeta>';
    const meta = doc.addStream(xmp, { Type: 'Metadata', Subtype: 'XML' });
    doc.getTrailer().get('Root').put('Metadata', meta);
    expect(pdfaDeclared(doc)).toBe(true);
  });
});
