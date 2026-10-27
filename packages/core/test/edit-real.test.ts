/**
 * M3 integration (docs/m3-contract.md section 7): runs the core edit flow with the real pdf-ops and reflow adapter (defaultEditAdapter).
 * Separately from the journal and log assertions of the fake adapter tests (edit-engine, edit-save-replay), it checks the result that went through real removal, insertion, fonts, placement and writing
 * (text, order, fallback, save, reopen, re-edit, reapply determinism).
 */
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type {
  DraftInput,
  EditOp,
  ParagraphEditPlan,
  ReplaceParagraphOp,
  TextRun,
} from '@pdf-editor/shared-types';
import { validateLayout } from '@pdf-editor/layout-recon';
import { PdfSession } from '../src/index.js';
import { FONT_BYTES, MEDIABOX, PAGE, fallbackFonts } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const source = (): Uint8Array => buildPdf([{ content: PAGE, mediabox: MEDIABOX }]);

/** MuPDF structured text (content order). */
function stext(bytesOrSession: Uint8Array | PdfSession, pageIndex = 0): string {
  if (bytesOrSession instanceof PdfSession) {
    return bytesOrSession
      .extractPage({ pageIndex })
      .chars.map((c) => c.text)
      .join('');
  }
  const doc = mupdf.Document.openDocument(bytesOrSession, 'application/pdf');
  try {
    const page = doc.loadPage(pageIndex);
    const text = page.toStructuredText('preserve-whitespace').asText();
    page.destroy();
    return text;
  } finally {
    doc.destroy();
  }
}

const squash = (t: string): string => t.replace(/\s+/gu, '');

async function paragraphId(s: PdfSession, startsWith: string, pageIndex = 0): Promise<number> {
  const layout = s.getPageLayout(pageIndex);
  const found = layout.paragraphs.find((p) => p.text.startsWith(startsWith));
  if (!found) throw new Error(`문단 없음: ${startsWith}`);
  return found.id;
}

function input(plan: ParagraphEditPlan, text: string): DraftInput {
  const run: TextRun = { text, style: plan.runs[0]!.style };
  return { runs: [run], format: plan.format, composition: null, renderScale: 2 };
}

async function edit(s: PdfSession, startsWith: string, text: string) {
  const id = await paragraphId(s, startsWith);
  const plan = await s.planParagraphEdit(0, id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, id, plan.revision);
  const update = await s.updateParagraphDraft(started.draftId, input(plan, text));
  const commit = await s.commitParagraphEdit(started.draftId);
  return { plan, update, commit };
}

const NEW_TEXT = 'Edited paragraph 한글 문장 漢字 with fallback glyphs and more words to wrap.';

describe('real adapter edit flow (M3 integration)', () => {
  it('classification → begin → update → commit: the new text is at the original position (between the title and the second paragraph) and a fallback warning is raised', async () => {
    const s = session(source());
    const editability = await s.getPageEditability(0);
    expect(editability.paragraphs.filter((p) => p.editable).length).toBeGreaterThanOrEqual(3);

    const { plan, update, commit } = await edit(s, 'first paragraph', NEW_TEXT);
    expect(plan.insertion).not.toBeNull();
    expect(update.reflow.lines.length).toBeGreaterThan(0);
    expect(update.warnings.map((w) => w.kind)).toContain('font-fallback');
    expect(commit.op.kind).toBe('replace-paragraph');

    const t = squash(stext(s));
    expect(t).toContain(squash(NEW_TEXT));
    expect(t).not.toContain('firstparagraphlineone');
    // A9: in content order, title < new paragraph < second paragraph.
    const iTitle = t.indexOf('TitleHeading');
    const iNew = t.indexOf(squash(NEW_TEXT));
    const iSecond = t.indexOf('Secondparagraph');
    expect(iTitle).toBeGreaterThanOrEqual(0);
    expect(iTitle).toBeLessThan(iNew);
    expect(iNew).toBeLessThan(iSecond);
    s.close();
  });

  it('undo and redo move between the original and the edited text, and after cancelling a fallback draft, a new edit → save works (V1)', async () => {
    const s = session(source());
    await edit(s, 'first paragraph', NEW_TEXT);
    await s.undo();
    expect(squash(stext(s))).toContain('firstparagraphlineone');
    await s.redo();
    expect(squash(stext(s))).toContain(squash(NEW_TEXT));

    // Edit another paragraph after cancelling a draft that uses the fallback.
    const id = await paragraphId(s, 'Second');
    const plan = await s.planParagraphEdit(0, id);
    const started = await s.beginParagraphEdit(0, id, plan.revision);
    await s.updateParagraphDraft(started.draftId, input(plan, '취소할 초안 한글'));
    await s.cancelParagraphEdit(started.draftId);
    expect(squash(stext(s))).toContain('Secondparagraphstartshereandends.');
    await edit(s, 'Second', '둘째 문단 새 텍스트');

    const saved = s.save({ changes: [] });
    expect(saved.method).toBe('full');
    const reopened = squash(stext(saved.bytes));
    expect(reopened).toContain(squash(NEW_TEXT));
    expect(reopened).toContain('둘째문단새텍스트');
    s.close();
  });

  it('saved file: the fallback font is a subset, Info /PdfEditorEdits is recorded, and the same block is rewritten in a new session after reopening', async () => {
    const s = session(source());
    await edit(s, 'first paragraph', NEW_TEXT);
    const saved = s.save({ changes: [] });
    s.close();
    const doc = mupdf.Document.openDocument(saved.bytes, 'application/pdf').asPDF()!;
    expect(doc.getTrailer().get('Info').get('PdfEditorEdits').asString()).toContain('pages=1');
    // There is one fallback font (marker /PdfEditorFallback), and FontFile2 is a subset holding only the glyphs used (A7-1).
    // The fixture's F2 contains the whole of the same font, so this is not decided by file size.
    const fallback = fallbackFonts(doc);
    expect(fallback.length).toBe(1);
    const descendant = fallback[0]!.get('DescendantFonts').get(0);
    const fontFile = descendant.get('FontDescriptor').get('FontFile2');
    expect(fontFile.readStream().getLength()).toBeLessThan(FONT_BYTES.byteLength / 10);
    doc.destroy();

    const s2 = session(saved.bytes);
    const id = await paragraphId(s2, 'Edited paragraph');
    const plan = await s2.planParagraphEdit(0, id);
    expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
    expect(plan.insertion?.mode).toBe('rewrite-block');
    expect(squash(plan.runs.map((r) => r.text).join(''))).toBe(squash(NEW_TEXT));
    const started = await s2.beginParagraphEdit(0, id, plan.revision);
    await s2.updateParagraphDraft(started.draftId, input(plan, 'Second session text 다시'));
    await s2.commitParagraphEdit(started.draftId);
    const resaved = s2.save({ changes: [] });
    const t = squash(stext(resaved.bytes));
    expect(t).toContain('Secondsessiontext다시');
    expect(t).not.toContain(squash(NEW_TEXT));
    s2.close();
  });

  it('reapply (D6): applying the same log twice to a new document gives the same text as the original edit, and the render and text of the saved file are the same too', async () => {
    const live = session(source());
    const ops: EditOp[] = [];
    ops.push((await edit(live, 'first paragraph', NEW_TEXT)).commit.op);
    ops.push((await edit(live, 'Second', '둘째 문단 새 텍스트')).commit.op);
    const expectedText = stext(live);

    const a = session(source());
    const b = session(source());
    await a.replayEdits(structuredClone(ops));
    await b.replayEdits(structuredClone(ops));
    expect(stext(a)).toBe(expectedText);
    expect(stext(b)).toBe(expectedText);
    // Saved bytes are not compared because Info /ModDate (commit time) differs. The render pixels and text of the saved file are compared.
    const pixels = (bytes: Uint8Array) => {
      const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
      const page = doc.loadPage(0);
      const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
      const out = Buffer.from(pix.getPixels());
      pix.destroy();
      page.destroy();
      doc.destroy();
      return out;
    };
    const savedA = a.save({ changes: [] }).bytes;
    const savedB = b.save({ changes: [] }).bytes;
    const savedLive = live.save({ changes: [] }).bytes;
    expect(pixels(savedA).equals(pixels(savedB))).toBe(true);
    expect(pixels(savedA).equals(pixels(savedLive))).toBe(true);
    expect(stext(savedA)).toBe(stext(savedLive));
    for (const x of [live, a, b]) x.close();
  });
});

/** A document using only F1 (Helvetica). tweak modifies the font dictionary (ToUnicode, Encoding). */
function helveticaPdf(
  pages: string[],
  tweak: (doc: mupdf.PDFDocument, f1: mupdf.PDFObject) => void,
) {
  const doc = new mupdf.PDFDocument();
  const f1 = doc.addSimpleFont(new mupdf.Font('Helvetica'));
  tweak(doc, f1);
  for (const content of pages) {
    doc.insertPage(-1, doc.addPage([0, 0, 400, 300], 0, { Font: { F1: f1 } }, content));
  }
  const buffer = doc.saveToBuffer('');
  const bytes = buffer.asUint8Array().slice();
  buffer.destroy();
  doc.destroy();
  return bytes;
}

const toUnicode = (doc: mupdf.PDFDocument, body: string): mupdf.PDFObject =>
  doc.addStream(
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def ' +
      `1 begincodespacerange <00> <FF> endcodespacerange ${body} endcmap ` +
      'CMapName currentdict /CMap defineresource pop end end',
    doc.newDictionary(),
  );

async function editAt(s: PdfSession, pageIndex: number, startsWith: string, text: string) {
  const id = await paragraphId(s, startsWith, pageIndex);
  const plan = await s.planParagraphEdit(pageIndex, id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(pageIndex, id, plan.revision);
  const update = await s.updateParagraphDraft(started.draftId, input(plan, text));
  const commit = await s.commitParagraphEdit(started.draftId);
  return { plan, update, commit };
}

/** Content of the page's edit blocks (/PdfEditorEdit Form). */
function blockContents(s: PdfSession, pageIndex: number): string[] {
  const doc = mupdf.Document.openDocument(s.save({ changes: [] }).bytes, 'application/pdf');
  const pdf = doc.asPDF()!;
  const out: string[] = [];
  pdf
    .findPage(pageIndex)
    .get('Resources')
    .get('XObject')
    .forEach((x) => {
      if (!x.get('PdfEditorEdit').isNull()) out.push(x.readStream().asString());
    });
  doc.destroy();
  return out;
}

describe('milestone review fixes (docs/m3-integration.md section 8)', () => {
  it('H1: original text whose ToUnicode is decomposed (NFD) does not lose characters on a same-text commit either', async () => {
    // Code E9 → "e" + U+0301 (decomposed). The rest of ASCII is unchanged.
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Le caf\\351 et le th\\351 du matin.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
      ],
      (doc, f1) =>
        f1.put(
          'ToUnicode',
          toUnicode(
            doc,
            '1 beginbfrange <20> <7E> <0020> endbfrange 1 beginbfchar <E9> <00650301> endbfchar',
          ),
        ),
    );
    const s = session(bytes);
    const layout = s.getPageLayout(0);
    const target = layout.paragraphs.find((p) => p.text.startsWith('Le caf'))!;
    expect(target.text).toContain('é'); // extraction keeps ToUnicode as is (decomposed)
    const plan = await s.planParagraphEdit(0, target.id);
    const text = plan.runs.map((r) => r.text).join('');
    expect(text).toBe(text.normalize('NFC'));
    expect(text.normalize('NFC')).toBe(target.text.normalize('NFC'));
    expect(plan.charIndexOfOffset).toHaveLength(text.length);
    // 'é' (one NFC position) points to the first character of the original cluster.
    const at = text.indexOf('é');
    expect(layout.paragraphs).toBeDefined();
    expect(plan.charIndexOfOffset[at]).toBeGreaterThanOrEqual(0);
    const started = await s.beginParagraphEdit(0, target.id, plan.revision);
    const update = await s.updateParagraphDraft(started.draftId, {
      runs: plan.runs,
      format: plan.format,
      composition: null,
      renderScale: 2,
    });
    expect(update.warnings.map((w) => w.kind)).not.toContain('glyph-missing');
    expect(update.warnings.map((w) => w.kind)).not.toContain('font-fallback');
    await s.commitParagraphEdit(started.draftId);
    const after = squash(stext(s)).normalize('NFC');
    expect(after).toContain(squash(text));
    const saved = squash(stext(s.save({ changes: [] }).bytes)).normalize('NFC');
    expect(saved).toContain(squash(text));
    s.close();
  });

  it('H1: when only the combining character is absent from both fonts, the base character is kept and only that combining character is glyph-missing', async () => {
    const s = session(source());
    // q + U+0301: there is no precomposed character, and neither Helvetica (WinAnsi) nor the fallback has U+0301.
    const { update } = await edit(s, 'first paragraph', 'Aq́z end.');
    const missing = update.warnings.find((w) => w.kind === 'glyph-missing');
    expect(missing?.message).toContain('́');
    const t = squash(stext(s));
    expect(t).toContain('Aqzend.');
    s.close();
  });

  it('M1: even when only spaces go to the fallback, the saved fallback font is a subset and the change kinds include font-embed', async () => {
    // ToUnicode lacks U+0020, so spaces cannot be written with the original font (they go to the fallback, with no font-fallback warning).
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Hello world first paragraph here.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
      ],
      (doc, f1) =>
        f1.put('ToUnicode', toUnicode(doc, '1 beginbfrange <21> <7E> <0021> endbfrange')),
    );
    const s = session(bytes);
    const { update } = await edit(s, 'Hello', 'New words with spaces inside it');
    expect(update.warnings.map((w) => w.kind)).not.toContain('font-fallback');
    const plan = s.planSave({ changes: [] });
    expect(plan.reason).toContain('font-embed');
    const saved = s.save({ changes: [] });
    s.close();
    const doc = mupdf.Document.openDocument(saved.bytes, 'application/pdf').asPDF()!;
    const fallback = fallbackFonts(doc);
    expect(fallback.length).toBe(1);
    const fontFile = fallback[0]!
      .get('DescendantFonts')
      .get(0)
      .get('FontDescriptor')
      .get('FontFile2');
    expect(fontFile.readStream().getLength()).toBeLessThan(FONT_BYTES.byteLength / 10);
    expect(squash(stext(saved.bytes))).toContain('Newwordswithspacesinsideit');
    doc.destroy();
  });

  it('M3: the same edit is written with the same code regardless of session history (several codes for the same Unicode)', async () => {
    // 'A' = code 65 (WinAnsi) and 200 (Differences). Page 0 uses 200 and page 1 uses 65.
    const bytes = helveticaPdf(
      [
        'BT /F1 12 Tf 50 250 Td (Used \\310 code on page one.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Second paragraph starts here and ends.) Tj ET\n',
        'BT /F1 12 Tf 50 250 Td (Plain A text on page two.) Tj ET\n' +
          'BT /F1 12 Tf 50 120 Td (Another paragraph on page two.) Tj ET\n',
      ],
      (doc, f1) => {
        f1.delete('ToUnicode');
        const enc = doc.newDictionary();
        enc.put('BaseEncoding', doc.newName('WinAnsiEncoding'));
        const diff = doc.newArray();
        diff.push(200);
        diff.push(doc.newName('A'));
        enc.put('Differences', diff);
        f1.put('Encoding', enc);
      },
    );
    // Session 1: edit page 1 first (creating the font from the page 1 state), then edit page 0.
    const s1 = session(bytes);
    await editAt(s1, 1, 'Plain', 'Page two edited.');
    await editAt(s1, 0, 'Used', 'AAA new');
    // Session 2: edit page 0 only.
    const s2 = session(bytes);
    await editAt(s2, 0, 'Used', 'AAA new');
    const b1 = blockContents(s1, 0);
    const b2 = blockContents(s2, 0);
    expect(b1).toHaveLength(1);
    expect(b1).toEqual(b2);
    // Pick the code used in the page 0 state (200 = C8).
    expect(b1[0]!.toLowerCase()).toContain('[<c8> <c8> <c8> <20>');
    s1.close();
    s2.close();
  });
});

describe('fixes after user confirmation (docs/m3-integration.md section 9)', () => {
  it('B1: even if the layout splits a committed edit block into several paragraphs, the edit classification is one block (box = block glyph box)', async () => {
    const s = session(source());
    const { commit } = await edit(s, 'first paragraph', 'Short line one.\nShort line two.');
    // By the M2 rules alone, a short line after a forced line break is a different paragraph, but with the edit block hint (9.6) it is one layout paragraph.
    const layout = s.getPageLayout(0);
    expect(
      validateLayout(s.extractPage({ pageIndex: 0, includePathSegments: true }), layout),
    ).toEqual([]);
    expect(layout.paragraphs.filter((p) => p.text.includes('Short line'))).toHaveLength(1);
    const e = await s.getPageEditability(0);
    const own = e.paragraphs.filter((p) => p.editedBlock === commit.op.id);
    expect(own).toHaveLength(1);
    const lines = layout.paragraphs.filter((p) => p.text.startsWith('Short line'));
    expect(lines[0]!.text).toBe('Short line one. Short line two.');
    expect(own[0]!.paragraphId).toBe(lines[0]!.id);
    const [x0, y0, x1, y1] = own[0]!.bbox;
    for (const p of lines) {
      expect(p.bbox[0]).toBeGreaterThanOrEqual(x0 - 1);
      expect(p.bbox[1]).toBeGreaterThanOrEqual(y0 - 1);
      expect(p.bbox[2]).toBeLessThanOrEqual(x1 + 1);
      expect(p.bbox[3]).toBeLessThanOrEqual(y1 + 1);
    }
    // Editing again with that item targets the whole block.
    const plan = await s.planParagraphEdit(0, own[0]!.paragraphId);
    expect(plan.target.editedBlock).toBe(commit.op.id);
    expect(plan.runs.map((r) => r.text).join('')).toBe('Short line one.\nShort line two.');
    s.close();
  });

  it('automatic expansion (contract 5.4 change): on overflow the bottom edge moves down within the same edit unit, and undo, redo and reapply give the same result', async () => {
    const live = session(source());
    const long = 'Auto expand keeps every line inside the area. '.repeat(6).trim();
    const { plan, update, commit } = await edit(live, 'first paragraph', long);
    // The user area (op.format.area) stays as is; only the area actually written (reflow.area) is lowered to the text height.
    expect(update.reflow.overflow).toBe(false);
    expect(update.reflow.area[3]).toBeGreaterThan(plan.format.area[3] + 1);
    expect(update.reflow.area[3]).toBeCloseTo(update.reflow.contentBox[3], 6);
    expect((commit.op as ReplaceParagraphOp).format).toEqual(plan.format);
    expect((commit.op as ReplaceParagraphOp).format).not.toHaveProperty('overflow');
    const area = (s: PdfSession) => s.getPageEdits(0).then((e) => e.blocks[0]?.area);
    expect(await area(live)).toEqual(update.reflow.area);
    const edited = stext(live);
    // One edit = one undo (the automatic expansion creates no separate step).
    await live.undo();
    expect(squash(stext(live))).toContain('firstparagraphlineone');
    await live.redo();
    expect(stext(live)).toBe(edited);
    // Reapply gives the same area and the same text.
    const replayed = session(source());
    await replayed.replayEdits([structuredClone(commit.op)]);
    expect(stext(replayed)).toBe(edited);
    expect(await area(replayed)).toEqual(update.reflow.area);
    live.close();
    replayed.close();
  });

  it('an EditOp from an earlier build (format.overflow shrink, fontScale 0.85) is also reapplied, and equals the automatic expansion result without shrinking', async () => {
    const live = session(source());
    const long = 'Legacy shrink op is replayed without shrinking. '.repeat(5).trim();
    const op = (await edit(live, 'first paragraph', long)).commit.op;
    const legacy = structuredClone(op) as EditOp & { format: Record<string, unknown> };
    legacy.format.overflow = 'shrink';
    legacy.format.fontScale = 0.85;
    const a = session(source());
    const b = session(source());
    await a.replayEdits([legacy]);
    await b.replayEdits([structuredClone(op)]);
    expect(stext(a)).toBe(stext(b));
    expect(stext(a)).toBe(stext(live));
    const blockA = (await a.getPageEdits(0)).blocks[0]!;
    const blockB = (await b.getPageEdits(0)).blocks[0]!;
    expect(blockA).toMatchObject({ area: blockB.area, contentBox: blockB.contentBox });
    // The old fields do not remain in /PdfEditorFormat of the rewritten block.
    const saved = a.save({ changes: [] }).bytes;
    const doc = mupdf.Document.openDocument(saved, 'application/pdf') as mupdf.PDFDocument;
    let formats = 0;
    for (let n = 1; n < doc.countObjects(); n++) {
      const obj = doc.newIndirect(n);
      if (!obj.isStream() || obj.get('PdfEditorFormat').isNull()) continue;
      const json = JSON.parse(obj.get('PdfEditorFormat').asString()) as { format: object };
      expect(json.format).not.toHaveProperty('overflow');
      expect(json.format).not.toHaveProperty('fontScale');
      formats++;
    }
    expect(formats).toBe(1);
    doc.destroy();
    for (const x of [live, a, b]) x.close();
  });

  it('B1: even when the block merges with a neighboring paragraph into one layout paragraph, the classification box covers only the block glyphs', async () => {
    const s = session(source());
    const long = 'Short line one. Next starts. '.repeat(8).trim();
    const { commit } = await edit(s, 'first paragraph', long);
    const e = await s.getPageEditability(0);
    const own = e.paragraphs.filter((p) => p.editedBlock === commit.op.id);
    expect(own).toHaveLength(1);
    // The line of the second paragraph (baseline y = 792 − 640 = 152) is outside the box.
    expect(own[0]!.bbox[3]).toBeLessThan(150);
    // Layout (9.6): the block lines form one paragraph, and the second paragraph remains separate.
    const layout = s.getPageLayout(0);
    const block = layout.paragraphs.filter((p) => p.text.includes('Short line one'));
    expect(block).toHaveLength(1);
    expect(squash(block[0]!.text)).toBe(squash(long));
    const second = layout.paragraphs.filter((p) => p.text.includes('Second paragraph'));
    expect(second.map((p) => p.text)).toEqual(['Second paragraph starts here and ends.']);
    s.close();
  });

  it('9.6 layout: in a two-column page, a paragraph edited with forced line breaks and long text is one layout paragraph, and is recomputed after undo and redo', async () => {
    const col = (x: number, y: number, lines: string[]) =>
      `BT /F1 10 Tf ${x} ${y} Td 12 TL ` + lines.map((l) => `(${l}) '`).join(' ') + ' ET';
    const fill = 'words that fill the narrow column well';
    const content = [
      'BT /F1 16 Tf 72 740 Td (Two Column Page) Tj ET',
      col(72, 712, [fill, fill, fill, 'left first ends here.']),
      col(72, 652, ['Target paragraph begins', fill, fill, 'target ends here.']),
      col(72, 592, ['Below paragraph keeps', fill, fill, 'below ends here.']),
      col(320, 712, ['Right column text', fill, fill, 'right first ends.']),
      col(320, 652, ['Right second para', fill, fill, 'right second ends.']),
    ].join('\n');
    const s = session(buildPdf([{ content, mediabox: MEDIABOX }]));
    const before = s.getPageLayout(0);
    const target = before.paragraphs.find((p) => p.text.startsWith('Target paragraph'))!;
    const right = before.paragraphs.filter((p) => p.text.startsWith('Right'));
    expect(right).toHaveLength(2);
    const id = await paragraphId(s, 'Target paragraph');
    const plan = await s.planParagraphEdit(0, id);
    expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
    const text =
      'Edited.\nTiny.\n' + 'Longer edited sentence wraps across lines. '.repeat(5).trim();
    const started = await s.beginParagraphEdit(0, id, plan.revision);
    await s.updateParagraphDraft(started.draftId, input(plan, text));
    const commit = await s.commitParagraphEdit(started.draftId);
    const check = () => {
      const model = s.extractPage({ pageIndex: 0, includePathSegments: true });
      const layout = s.getPageLayout(0);
      expect(validateLayout(model, layout)).toEqual([]);
      const blockParas = layout.paragraphs.filter((p) => /Edited|Tiny|Longer/u.test(p.text));
      expect(blockParas).toHaveLength(1);
      expect(squash(blockParas[0]!.text)).toBe(squash(text));
      expect(blockParas[0]!.column).toBe(
        layout.paragraphs.find((p) => p.text.startsWith('words that fill'))!.column,
      );
      // Neighbor paragraphs are separate (the lower-left paragraph and the two paragraphs of the right column).
      expect(layout.paragraphs.filter((p) => p.text.startsWith('Below paragraph'))).toHaveLength(1);
      expect(
        layout.paragraphs.filter((p) => p.text.startsWith('Right')).map((p) => p.text),
      ).toEqual(right.map((p) => p.text));
      return blockParas[0]!;
    };
    const para = check();
    const e = await s.getPageEditability(0);
    expect(e.paragraphs.filter((p) => p.editedBlock === commit.op.id)).toHaveLength(1);
    expect(e.paragraphs.find((p) => p.editedBlock === commit.op.id)!.paragraphId).toBe(para.id);
    // undo: returns to the original paragraphs (no hint), redo: one paragraph again.
    await s.undo();
    const undone = s.getPageLayout(0);
    expect(undone.paragraphs.map((p) => p.text)).toContain(target.text);
    await s.redo();
    check();
    // The same after save → reopen (blocks are found again via /PdfEditorEdit).
    const saved = s.save({ changes: [] }).bytes;
    s.close();
    const r = session(saved);
    const layout = r.getPageLayout(0);
    expect(layout.paragraphs.filter((p) => /Edited|Tiny|Longer/u.test(p.text))).toHaveLength(1);
    r.close();
  });
});
