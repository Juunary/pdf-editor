/**
 * Tests for fallback font lifetime (V1 scenario), D9 wrapped save and log reapply. The FontManager of the fake adapter imitates the lifetime rule of contract D4 as is (each time it is used,
 * it checks that the object exists and, if not, inserts it again from the loader bytes inside the current operation).
 */
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import { PdfSession } from '../src/index.js';
import { EditStateError } from '../src/edit-engine.js';
import type { EditOp, ReplaceParagraphOp } from '@pdf-editor/shared-types';
import { createFakeAdapter } from './fake-edit-adapter.js';
import { buildPdf } from './pdf-fixtures.js';
import {
  FONT_BYTES,
  MEDIABOX,
  PAGE,
  begin,
  draftInput,
  editParagraph,
  fallbackFonts,
  harness,
  journal,
  text,
  type Harness,
} from './edit-harness.js';

const HANGUL_TEXT = '한글 문장을 넣습니다';

/** Opens the save result as a new document. */
function reopen(bytes: Uint8Array): mupdf.PDFDocument {
  return mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as mupdf.PDFDocument;
}

function reopenedText(bytes: Uint8Array): string {
  const s = new PdfSession();
  s.open(bytes.slice());
  const t = text(s);
  s.close();
  return t;
}

describe('fallback font lifetime (V1, contract D4 amendment 1)', () => {
  it('the fallback font is embedded once on the first begin, just before enabling the journal (outside the operation), and the classification does not change the document', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    await s.planParagraphEdit(0, 1);
    // Classification alone creates no Info, fallback font or journal.
    expect(s.document.getTrailer().get('Info').isNull()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(0);
    expect(s.planSave({ changes: [] }).method).toBe('incremental');

    const { started } = await begin(s, 1);
    const fonts = fallbackFonts(s.document);
    expect(fonts).toHaveLength(1);
    expect(s.document.getTrailer().get('Info').isDictionary()).toBe(true);
    await s.cancelParagraphEdit(started.draftId);
    // Even after cancel the fallback font stays, since it is an object outside the journal.
    expect(fallbackFonts(s.document).map((f) => f.asIndirect())).toEqual(
      fonts.map((f) => f.asIndirect()),
    );
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('a new edit after cancelling a draft that inserted the fallback', async () => {
    const { s } = harness();
    const first = await begin(s, 1);
    await s.updateParagraphDraft(first.started.draftId, draftInput(first.plan, HANGUL_TEXT));
    const fontNumber = fallbackFonts(s.document)[0]!.asIndirect();
    expect(text(s)).toContain(HANGUL_TEXT);
    await s.cancelParagraphEdit(first.started.draftId);
    expect(journal(s)).toEqual({ position: 0, steps: [] });

    // The same font object is used after cancel (not embedded again).
    const again = await begin(s, 1);
    await s.updateParagraphDraft(again.started.draftId, draftInput(again.plan, HANGUL_TEXT));
    expect(fallbackFonts(s.document).map((f) => f.asIndirect())).toEqual([fontNumber]);
    expect(text(s)).toContain(HANGUL_TEXT);
    await s.commitParagraphEdit(again.started.draftId);

    const saved = s.save({ changes: [] });
    expect(reopenedText(saved.bytes)).toContain(HANGUL_TEXT);
    expect(fallbackFonts(reopen(saved.bytes))).toHaveLength(1);
    s.close();
  });

  it('a new edit after undoing an edit that inserted the fallback → save', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    const fontNumber = fallbackFonts(s.document)[0]!.asIndirect();
    await s.undo();
    // The font object remains even after undo (an object outside the journal).
    expect(fallbackFonts(s.document).map((f) => f.asIndirect())).toEqual([fontNumber]);
    await editParagraph(s, 2, '다른 문장 입니다');
    expect(fallbackFonts(s.document).map((f) => f.asIndirect())).toEqual([fontNumber]);
    expect(text(s)).toContain('다른 문장 입니다');
    expect(text(s)).toContain('first paragraph');

    const saved = s.save({ changes: [] });
    const out = reopenedText(saved.bytes);
    expect(out).toContain('다른 문장 입니다');
    expect(out).toContain('first paragraph');
    expect(fallbackFonts(reopen(saved.bytes))).toHaveLength(1);
    // undo/redo also works normally after saving.
    await s.undo();
    expect(text(s)).not.toContain('다른 문장');
    await s.redo();
    expect(text(s)).toContain('다른 문장 입니다');
    s.close();
  });

  it('saving only edits that did not use the fallback font leaves no fallback font in the file (garbage collection removes it)', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin only');
    expect(fallbackFonts(s.document)).toHaveLength(1);
    const saved = s.save({ changes: [] });
    expect(fallbackFonts(reopen(saved.bytes))).toHaveLength(0);
    expect(reopenedText(saved.bytes)).toContain('Latin only');
    s.close();
  });

  it('after stacking two edits that used the fallback, undo → redo in order, with one font in the document', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    await editParagraph(s, 2, '두 번째 한글');
    expect(fallbackFonts(s.document)).toHaveLength(1);
    await s.undo();
    expect(text(s)).toContain(HANGUL_TEXT);
    await s.undo();
    expect(text(s)).not.toContain(HANGUL_TEXT);
    await s.redo();
    await s.redo();
    expect(text(s)).toContain('두 번째 한글');
    expect(text(s)).toContain(HANGUL_TEXT);
    s.close();
  });
});

describe('D9 save: beginOperation → metadata record and subset → saveToBuffer → abandonOperation', () => {
  it('the save result reflects the edits, Info and subset, and the working document and journal remain in the pre-save state', async () => {
    const { s, adapter } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    // The Info record is made inside the commit operation (recorded in the journal and moving together with undo and redo).
    expect(adapter.probe.metadataCalls).toEqual([{ pages: [0], structureNotUpdated: false }]);
    const stepsBefore = journal(s);
    const fontFile = (doc: mupdf.PDFDocument) => {
      const font = fallbackFonts(doc)[0]!;
      return font.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    };
    const workingSize = fontFile(s.document).readStream().asUint8Array().length;

    const saved = s.save({ changes: [] });
    expect(saved.method).toBe('full');
    expect(saved.options).toBe('garbage=yes,compress,objstms');
    expect(adapter.probe.metadataCalls).toHaveLength(1);

    // Output: edits reflected, Info record, fallback subset.
    const out = reopen(saved.bytes);
    expect(out.getTrailer().get('Info').get('PdfEditorEdits').asString()).toBe(
      'pages=1; structure=n/a',
    );
    expect(reopenedText(saved.bytes)).toContain(HANGUL_TEXT);
    const outSize = fontFile(out).readStream().asUint8Array().length;
    expect(outSize).toBeLessThan(workingSize / 10);

    // Working document: journal steps unchanged, full font kept.
    expect(journal(s)).toEqual(stepsBefore);
    expect(fontFile(s.document).readStream().asUint8Array().length).toBe(workingSize);

    // Keep editing after the save (new syllables do not become empty glyphs) and undo/redo.
    await editParagraph(s, 2, '새 음절 곰');
    const again = s.save({ changes: [] });
    expect(reopenedText(again.bytes)).toContain('새 음절 곰');
    expect(reopenedText(again.bytes)).toContain(HANGUL_TEXT);
    await s.undo();
    expect(text(s)).not.toContain('새 음절 곰');
    await s.redo();
    expect(text(s)).toContain('새 음절 곰');
    expect(journal(s).steps).toHaveLength(2);
    s.close();
  });

  it('the Info record moves together with undo and redo', async () => {
    const { s } = harness();
    // The first `beginParagraphEdit` creates an empty Info dictionary (before enabling the journal).
    const warmup = await begin(s, 1);
    await s.cancelParagraphEdit(warmup.started.draftId);
    const info = () => s.document.getTrailer().get('Info').get('PdfEditorEdits');
    expect(info().isNull()).toBe(true);
    await editParagraph(s, 1, 'Latin');
    expect(info().asString()).toBe('pages=1; structure=n/a');
    await s.undo();
    expect(info().isNull()).toBe(true);
    // The save is in a state with no edits, so Info has no edited pages.
    expect(
      reopen(s.save({ changes: [] }).bytes)
        .getTrailer()
        .get('Info')
        .get('PdfEditorEdits')
        .isNull(),
    ).toBe(true);
    await s.redo();
    expect(info().asString()).toBe('pages=1; structure=n/a');
    s.close();
  });

  it('an objstms save creates no journal step, so the first undo right after saving is valid', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Alpha');
    s.save({ changes: [] });
    s.save({ changes: [] });
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit'] });
    await s.undo();
    expect(text(s)).toContain('first paragraph');
    expect(text(s)).not.toContain('Alpha');
    s.close();
  });

  it('planSave: edit summary, change kinds (content-stream, font-embed when the fallback is used), full save', async () => {
    const { s } = harness();
    expect(s.planSave({ changes: [] })).toMatchObject({ method: 'incremental', edits: null });
    await editParagraph(s, 1, 'Latin only');
    let plan = s.planSave({ changes: [] });
    expect(plan.method).toBe('full');
    expect(plan.edits).toEqual({ pages: [0], structureUnlinked: 0, pdfaDeclared: false });
    await editParagraph(s, 2, HANGUL_TEXT);
    plan = s.planSave({ changes: ['annotation'] });
    expect(plan.method).toBe('full');
    expect(plan.reason).toContain('content-stream');
    // Undoing the last edit (fallback) drops font-embed, and undoing all of them leaves no edit summary.
    await s.undo();
    await s.undo();
    plan = s.planSave({ changes: [] });
    expect(plan.edits).toBeNull();
    // A document with edit history (journal enabled) gets a full save even without changes (to avoid traces of reverted objects in the incremental section).
    expect(plan.method).toBe('full');
    expect(plan.reason).toContain('편집을 시작');
    s.close();
  });

  it('once a full save has been done in the session, later saves are full saves too', () => {
    const s = new PdfSession();
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    expect(s.planSave({ changes: [] }).method).toBe('incremental');
    s.save({ changes: ['redaction'] });
    const plan = s.planSave({ changes: [] });
    expect(plan.method).toBe('full');
    expect(plan.reason).toContain('A3-9');
    expect(s.save({ changes: [] }).method).toBe('full');
    s.close();
  });

  it('saving a document whose journal was not enabled (no edit RPC used) is not wrapped', () => {
    const s = new PdfSession({ editAdapter: createFakeAdapter() });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const saved = s.save({ changes: ['annotation'] });
    expect(saved.method).toBe('incremental');
    s.close();
  });

  it('an exception during save discards the operation and keeps the journal', async () => {
    const { s, adapter } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    adapter.probe.failNext.finalize = true;
    expect(() => s.save({ changes: [] })).toThrow('fake finalize 실패');
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit'] });
    expect(s.save({ changes: [] }).bytes.length).toBeGreaterThan(0);
    await s.undo();
    expect(text(s)).toContain('first paragraph');
    s.close();
  });
});

describe('redo step preservation (MuPDF: the first change in an operation discards redo)', () => {
  it('if the fallback was not used, redo remains even after saving following an undo', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin one');
    await editParagraph(s, 2, 'Latin two');
    await s.undo();
    s.save({ changes: [] });
    s.save({ changes: [] });
    expect(await s.getEditHistory()).toMatchObject({ canUndo: true, canRedo: true });
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit', 'paragraph-edit'] });
    await s.redo();
    expect(text(s)).toContain('Latin two');
    s.close();
  });

  it('if there is an edit that used the fallback, saving after undo loses redo, and the core state is cleared to match the journal', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    await editParagraph(s, 2, 'Latin two');
    await s.undo();
    const saved = s.save({ changes: [] });
    expect(reopenedText(saved.bytes)).toContain(HANGUL_TEXT);
    // The subset replacement changed objects inside the operation, so MuPDF discarded the redo steps.
    expect(await s.getEditHistory()).toMatchObject({ canUndo: true, canRedo: false, edits: 1 });
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit'] });
    expect(await s.redo()).toMatchObject({ canRedo: false, affectedPages: [] });
    // undo works normally.
    await s.undo();
    expect(text(s)).toContain('first paragraph');
    s.close();
  });

  it('starting a draft after undo removes redo and it does not come back after cancel', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin one');
    await s.undo();
    expect(await s.getEditHistory()).toMatchObject({ canRedo: true });
    const { started } = await begin(s, 2);
    expect(await s.getEditHistory()).toMatchObject({ canRedo: false, edits: 0 });
    const history = await s.cancelParagraphEdit(started.draftId);
    expect(history).toMatchObject({ canRedo: false, canUndo: false });
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    expect(await s.redo()).toMatchObject({ canRedo: false, affectedPages: [] });
    s.close();
  });

  it('classification alone after undo leaves redo intact', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin one');
    await s.undo();
    await s.getPageEditability(0);
    await s.planParagraphEdit(0, 1);
    expect(await s.getEditHistory()).toMatchObject({ canRedo: true });
    await s.redo();
    expect(text(s)).toContain('Latin one');
    s.close();
  });
});

/** Document state snapshot: page content and edit block stream bytes and characters (for comparing reapply determinism). */
function snapshot(s: PdfSession) {
  const page = s.document.loadPage(0);
  const contents = page.getObject().get('Contents');
  const read = (obj: mupdf.PDFObject): string =>
    new TextDecoder('latin1').decode(obj.readStream().asUint8Array());
  const out = {
    content: read(contents),
    text: text(s),
    blocks: [] as string[],
  };
  const xobjects = page.getObject().get('Resources').get('XObject');
  if (xobjects.isDictionary()) {
    xobjects.forEach((value) => {
      if (value.isStream() && !value.get('PdfEditorEdit').isNull()) out.blocks.push(read(value));
    });
  }
  page.destroy();
  return out;
}

async function recordOps(h: Harness): Promise<EditOp[]> {
  const first = await editParagraph(h.s, 1, HANGUL_TEXT);
  const layout = h.s.getPageLayout(0);
  const blockParagraph = layout.paragraphs.find((p) => p.text.includes(HANGUL_TEXT))!;
  const second = await editParagraph(h.s, blockParagraph.id, `${HANGUL_TEXT} 다시 쓴 문장 Latin`);
  const third = await editParagraph(
    h.s,
    layout.paragraphs.find((p) => p.text.startsWith('Second'))!.id,
    'Third edit',
  );
  return [first.op, second.op, third.op];
}

describe('replayEdits (D6 recovery)', () => {
  it('reapplying the log to a new document gives the same result and the journal is enabled after applying', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const expected = snapshot(live.s);
    const liveIds = (await live.s.getEditHistory()).activeEditIds;

    const fresh = harness();
    const history = await fresh.s.replayEdits(structuredClone(ops));
    expect(history).toMatchObject({
      activeEditIds: liveIds,
      canUndo: false,
      canRedo: false,
      edits: 3,
      affectedPages: [0],
    });
    expect(history.revision).toBe(1);
    // Reapply result = original edit result (determinism frame based on the fake adapter).
    expect(snapshot(fresh.s)).toEqual(expected);
    // The journal was enabled after the reapply finished, so reapplied edits are not undo steps.
    expect(journal(fresh.s)).toEqual({ position: 0, steps: [] });
    expect((await fresh.s.undo()).edits).toBe(3);
    expect(snapshot(fresh.s)).toEqual(expected);

    // Afterwards new edits are undone as usual.
    await editParagraph(fresh.s, 0, 'After recovery');
    expect(text(fresh.s)).toContain('After recovery');
    const undone = await fresh.s.undo();
    expect(undone.activeEditIds).toEqual(liveIds);
    expect(snapshot(fresh.s)).toEqual(expected);
    live.s.close();
    fresh.s.close();
  });

  it('reapplying the same log twice gives the same bytes (determinism)', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const a = harness();
    const b = harness();
    await a.s.replayEdits(structuredClone(ops));
    await b.s.replayEdits(structuredClone(ops));
    expect(snapshot(a.s)).toEqual(snapshot(b.s));
    for (const x of [live, a, b]) x.s.close();
  });

  it('saving after reapply puts the edits in the file and adds the Info record', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const fresh = harness();
    await fresh.s.replayEdits(structuredClone(ops));
    const saved = fresh.s.save({ changes: [] });
    expect(reopenedText(saved.bytes)).toContain('Third edit');
    expect(reopen(saved.bytes).getTrailer().get('Info').get('PdfEditorEdits').asString()).toContain(
      'pages=1',
    );
    live.s.close();
    fresh.s.close();
  });

  it('reapplying an empty log only enables the journal', async () => {
    const { s } = harness();
    const history = await s.replayEdits([]);
    expect(history).toMatchObject({ edits: 0, canUndo: false, activeEditIds: [] });
    await editParagraph(s, 1, 'Fresh');
    expect(await s.undo()).toMatchObject({ edits: 0, canRedo: true });
    s.close();
  });

  it('allowed after a classification RPC (the journal is still off), and rejected in a session that has begun editing', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const { s } = harness();
    await s.getPageEditability(0); // a mouse-over classification during recovery may be called first
    await s.planParagraphEdit(0, 1);
    await expect(s.replayEdits(structuredClone(ops))).resolves.toMatchObject({ edits: 3 });
    await expect(s.replayEdits([])).rejects.toBeInstanceOf(EditStateError);

    const started = harness();
    const { started: draft } = await begin(started.s, 1);
    await started.s.cancelParagraphEdit(draft.draftId);
    await expect(started.s.replayEdits([])).rejects.toBeInstanceOf(EditStateError);
    for (const x of [live, started]) x.s.close();
    s.close();
  });

  it('when the target paragraph is not found, reports the failure position and blocks later edit RPCs', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const fresh = harness();
    const broken = structuredClone(ops);
    (broken[1] as ReplaceParagraphOp).target.glyphSeqs = [999, 1000];
    await expect(fresh.s.replayEdits(broken)).rejects.toThrow('재적용 실패(2/3번째');
    await expect(fresh.s.getPageEditability(0)).rejects.toThrow('다시 열어야');
    await expect(fresh.s.replayEdits([])).rejects.toThrow('다시 열어야');
    live.s.close();
    fresh.s.close();
  });
});

describe('when the session is reopened', () => {
  it('the edit blocks of the saved file appear in the list even without the log, and the area is approximated by BBox', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Persist me');
    const saved = s.save({ changes: [] });
    const reopened = new PdfSession({
      editAdapter: createFakeAdapter(),
      loadFallbackFont: async () => FONT_BYTES,
    });
    reopened.open(saved.bytes.slice());
    const info = await reopened.getPageEdits(0);
    expect(info.blocks).toHaveLength(1);
    expect(info.blocks[0]!.area).toEqual(info.blocks[0]!.contentBox);
    expect(info.blocks[0]!.area[2]).toBeGreaterThan(100);
    s.close();
    reopened.close();
  });
});
