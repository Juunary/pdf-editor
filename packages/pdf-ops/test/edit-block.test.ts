import { beforeAll, describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { TextRun } from '@pdf-editor/shared-types';
import { FontManager, pdfaDeclared, planParagraphEdit, recordEditMetadata } from '../src/index.js';
import { parseEditsInfo } from '../src/edit-meta.js';
import { findParagraph, loadModules, pageContext } from './helpers/edit-context.js';
import { editParagraph, fallbackFor } from './helpers/edit-driver.js';
import { inkInside, raster } from './helpers/engines.js';
import { bytesOf, engines, makeDoc, stextChars, wordOrigins } from './helpers/fixtures-m3.js';

/** Contract 5.5 write, 5.6 meta. */
beforeAll(async () => {
  await loadModules();
});

const blockStream = (doc: mupdf.PDFDocument, num: number) =>
  doc.newIndirect(num).readStream().asString();

describe('writeEditBlock(5.5)', () => {
  it('specifies all text state and wraps BT/ET in q/Q', () => {
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

  it('uses the fill color in its original color space (copies CMYK/CalRGB resources)', () => {
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

  it('if the ExtGState of the original character differs from the insertion point, reproduces it with gs inside the block', async () => {
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
    // Same text, same alpha: the render matches the original (MuPDF).
    const a = await raster('mupdf', before, 0);
    const b = await raster('mupdf', bytesOf(doc), 0);
    expect(Math.abs(inkInside(a, p.bbox) - inkInside(b, p.bbox))).toBeLessThan(
      inkInside(a, p.bbox) * 0.05 + 4,
    );
  });

  it('glyph positions = layout result (TJ number correction), writes the trailing-space glyph at line end', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 230 Td (Position check paragraph.) Tj ET']);
    const ctx = pageContext(doc, 0);
    const fm = new FontManager(doc, fallbackFor(doc));
    const p = findParagraph(ctx, 'Position check');
    // Create line breaks with a narrow region.
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

  it('fallback font bold/italic spans are synthesized (2 Tr + line width, Tm slant) with a warning', async () => {
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

describe('save meta (5.6)', () => {
  it('Info /PdfEditorEdits union, /ModDate updated, /Producer kept', () => {
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

  it('contract amendment 4: idempotent over all active edit pages, union with previous-session page numbers', () => {
    const doc = makeDoc(['', '', '']);
    const info = doc.addObject(doc.newDictionary());
    info.put('PdfEditorEdits', doc.newString('pages=5; structure=not-updated'));
    doc.getTrailer().put('Info', info);
    const value = () => doc.getTrailer().get('Info').get('PdfEditorEdits').asString();
    recordEditMetadata(doc, { pages: [0, 2], structureNotUpdated: false });
    expect(value()).toBe('pages=1,3,5; structure=not-updated');
    recordEditMetadata(doc, { pages: [2, 0], structureNotUpdated: false });
    expect(value()).toBe('pages=1,3,5; structure=not-updated');
    // If active edits shrink (another edit commits after undo), this session's page numbers shrink too. Previous-session page numbers remain.
    recordEditMetadata(doc, { pages: [0], structureNotUpdated: false });
    expect(value()).toBe('pages=1,5; structure=not-updated');
  });

  it('contract amendment 4: records made inside a commit operation stay in the journal and move with undo/redo, and a wrapped save with no changes keeps redo', () => {
    const doc = makeDoc(['BT /F1 12 Tf 50 200 Td (Meta paragraph.) Tj ET']);
    const fm = new FontManager(doc, fallbackFor(doc));
    // As in core, Info and the fallback are created before the journal is turned on (contract amendment 1).
    doc.getTrailer().put('Info', doc.addObject(doc.newDictionary()));
    doc.enableJournal();
    const value = () => {
      const v = doc.getTrailer().get('Info').get('PdfEditorEdits');
      return v.isString() ? v.asString() : null;
    };
    const ctx = pageContext(doc, 0);
    doc.beginOperation('edit');
    editParagraph(ctx, fm, findParagraph(ctx, 'Meta paragraph').id, 'Meta edited.');
    recordEditMetadata(doc, { pages: [0], structureNotUpdated: false });
    doc.endOperation();
    expect(value()).toBe('pages=1; structure=n/a');
    doc.undo();
    expect(value()).toBeNull();
    // Edit that used no fallback: the save operation only wraps, with no subset replacement.
    doc.beginOperation('save');
    doc.saveToBuffer('garbage=yes,compress,objstms');
    doc.abandonOperation();
    expect(doc.canRedo()).toBe(true);
    doc.redo();
    expect(value()).toBe('pages=1; structure=n/a');
  });

  it('check the PDF/A declaration (XMP pdfaid:part)', () => {
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
