/**
 * Unit tests for the edit engine (journal, log, draft, undo/redo). Uses a fake adapter instead of the M3 functions of pdf-ops and reflow, while the document, journal and font
 * addition run on real MuPDF (docs/m3-core.md section 3).
 */
import { describe, expect, it } from 'vitest';
import { PdfSession } from '../src/index.js';
import type { ReplaceParagraphOp } from '@pdf-editor/shared-types';
import { EditStateError, StaleRevisionError } from '../src/edit-engine.js';
import * as mupdf from 'mupdf';
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
} from './edit-harness.js';

describe('classification RPC', () => {
  it('awaits the fallback font once on the first call, and the classification neither changes the document nor enables the journal', async () => {
    const { s, fontLoads } = harness();
    const [a, b] = await Promise.all([s.getPageEditability(0), s.getPageEditability(0)]);
    expect(fontLoads.count).toBe(1);
    expect(a.revision).toBe(0);
    expect(a.paragraphs.map((p) => p.editable)).toEqual([true, true, true]);
    expect(b.ms).toBeGreaterThanOrEqual(0);
    await s.planParagraphEdit(0, 1);
    expect(fontLoads.count).toBe(1);
    // Info, the fallback font and the journal are created on the first begin (contract 5.7 amendment 1).
    expect(s.document.getTrailer().get('Info').isNull()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(0);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    expect(s.document.canUndo()).toBe(false);

    const { started } = await begin(s, 1);
    expect(fontLoads.count).toBe(1);
    // It is an object created just before enabling the journal (outside the operation), so cancel and undo do not sever it.
    expect(s.document.getTrailer().get('Info').resolve().isDictionary()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(1);
    await s.cancelParagraphEdit(started.draftId);
    expect(s.document.getTrailer().get('Info').resolve().isDictionary()).toBe(true);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('a fallback font load failure proceeds without the fallback and is retried on the next call (R-L5)', async () => {
    let calls = 0;
    const adapter = createFakeAdapter();
    const s = new PdfSession({
      editAdapter: adapter,
      loadFallbackFont: async () => {
        calls++;
        if (calls === 1) throw new Error('폰트 파일 없음');
        return FONT_BYTES;
      },
    });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    expect((await s.getPageEditability(0)).paragraphs).toHaveLength(3);
    expect(s.fallbackLoadError).toBe('폰트 파일 없음');
    expect((await s.getPageEditability(0)).paragraphs).toHaveLength(3);
    expect(calls).toBe(2);
    expect(s.fallbackLoadError).toBeNull();
    s.close();
  });

  it('classifies with the default adapter (real pdf-ops and reflow, M3 integration)', async () => {
    const s = new PdfSession();
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const editability = await s.getPageEditability(0);
    expect(editability.paragraphs.some((p) => p.editable)).toBe(true);
    s.close();
  });

  it('throws when no document is open', async () => {
    const s = new PdfSession();
    await expect(s.getEditHistory()).rejects.toThrow('열린 문서 없음');
  });
});

describe('draft → commit → undo/redo', () => {
  it('on begin the original paragraph becomes an edit block, and the draft state is visible in render, extraction and search', async () => {
    const { s } = harness();
    const before = text(s);
    const { plan, started } = await begin(s, 1);
    expect(plan.editable).toBe(true);
    expect(started.plan.revision).toBe(0);
    expect(started.first.region.clip).not.toBeNull();
    expect(started.first.reflow.lines.length).toBeGreaterThan(0);
    // The same characters are visible during the draft (redrawn as a block).
    expect(text(s)).toContain('first paragraph line one');
    await expect(s.getPageEdits(0)).resolves.toMatchObject({ blocks: [{ editId: 'id-1' }] });

    const update = await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Hello 가나다'));
    expect(update.draftId).toBe(started.draftId);
    expect(update.warnings.map((w) => w.kind)).toEqual(['font-fallback']);
    expect(update.region.clip).not.toBeNull();
    expect(text(s)).toContain('Hello 가나다');
    expect(text(s)).not.toContain('first paragraph');
    expect(s.searchText({ query: 'Hello' }).hits.length).toBeGreaterThan(0);
    // Characters on other pages are unchanged.
    expect(text(s)).toContain('Title Heading');
    expect(text(s)).not.toBe(before);
    // History queries during a draft are answered from core state (MuPDF canUndo throws during an operation).
    expect(await s.getEditHistory()).toMatchObject({
      revision: 0,
      activeEditIds: [],
      canUndo: false,
      canRedo: false,
      edits: 0,
    });
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });

  it('commit: log, revision, activeEditIds, journal step, page cache invalidation', async () => {
    const { s } = harness(1);
    const layoutBefore = s.getPageLayout(0);
    const { plan, started } = await begin(s, 1);
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Replaced text'));
    const result = await s.commitParagraphEdit(started.draftId);
    expect(result.op).toMatchObject({
      kind: 'replace-paragraph',
      id: 'id-1',
      target: { pageIndex: 0, editedBlock: null },
    });
    expect((result.op as ReplaceParagraphOp).runs.map((r) => r.text)).toEqual(['Replaced text']);
    expect(result.history).toEqual({
      revision: 1,
      activeEditIds: ['id-1'],
      canUndo: true,
      canRedo: false,
      edits: 1,
      affectedPages: [0],
    });
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit'] });
    expect(s.getPageLayout(0)).not.toBe(layoutBefore);
    expect(s.getPageLayout(0).paragraphs.some((p) => p.text.includes('Replaced text'))).toBe(true);
    expect((await s.getPageEdits(0)).blocks.map((b) => b.editId)).toEqual(['id-1']);
    s.close();
  });

  it('cancel: document, block list, journal and revision are restored', async () => {
    const { s } = harness();
    const before = text(s);
    const { plan, started } = await begin(s, 1);
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Never kept'));
    const history = await s.cancelParagraphEdit(started.draftId);
    expect(history).toMatchObject({
      revision: 0,
      activeEditIds: [],
      canUndo: false,
      affectedPages: [0],
    });
    expect(text(s)).toBe(before);
    expect((await s.getPageEdits(0)).blocks).toEqual([]);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    // After cancelling, the same paragraph can be started again with the same revision.
    const again = await s.beginParagraphEdit(0, 1, plan.revision);
    await s.cancelParagraphEdit(again.draftId);
    s.close();
  });

  it('undo/redo: characters, block list, activeEditIds, affected pages, revision', async () => {
    const { s } = harness();
    const original = text(s);
    await editParagraph(s, 1, 'First edit');
    const afterFirst = text(s);
    await editParagraph(s, 2, 'Second edit');
    expect(text(s)).toContain('First edit');
    expect(text(s)).toContain('Second edit');

    const undone = await s.undo();
    expect(undone).toEqual({
      revision: 3,
      activeEditIds: ['id-1'],
      canUndo: true,
      canRedo: true,
      edits: 1,
      affectedPages: [0],
    });
    expect(text(s)).toBe(afterFirst);
    expect((await s.getPageEdits(0)).blocks.map((b) => b.editId)).toEqual(['id-1']);
    await s.undo();
    expect(text(s)).toBe(original);
    expect((await s.getPageEdits(0)).blocks).toEqual([]);
    expect(await s.getEditHistory()).toMatchObject({ canUndo: false, canRedo: true, edits: 0 });
    expect(journal(s)).toEqual({ position: 0, steps: ['paragraph-edit', 'paragraph-edit'] });

    const redone = await s.redo();
    expect(redone.activeEditIds).toEqual(['id-1']);
    expect(text(s)).toBe(afterFirst);
    await s.redo();
    expect((await s.getEditHistory()).activeEditIds).toEqual(['id-1', 'id-3']);
    expect(text(s)).toContain('Second edit');
    s.close();
  });

  it('a new commit after undo discards redo (the viewer discards EditOps not in activeEditIds)', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'One');
    await editParagraph(s, 2, 'Two');
    await s.undo();
    const next = await editParagraph(s, 2, 'Three');
    expect(next.history.activeEditIds).toEqual(['id-1', next.op.id]);
    expect(next.history.canRedo).toBe(false);
    expect(text(s)).toContain('Three');
    expect(text(s)).not.toContain('Two');
    expect(journal(s).steps).toHaveLength(2);
    s.close();
  });

  it('an undo/redo with nothing to do does not change the document or revision', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    expect(await s.undo()).toMatchObject({ revision: 0, affectedPages: [], canUndo: false });
    expect(await s.redo()).toMatchObject({ revision: 0, affectedPages: [] });
    s.close();
  });

  it('re-edit: editing an edit block paragraph again still yields a single block (no nesting)', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Alpha beta');
    const blockParagraph = s
      .getPageLayout(0)
      .paragraphs.find((p) => p.text.includes('Alpha beta'))!;
    const plan = await s.planParagraphEdit(0, blockParagraph.id);
    expect(plan.target.editedBlock).toBe('id-1');
    const second = await editParagraph(s, blockParagraph.id, 'Gamma delta');
    expect((second.op as ReplaceParagraphOp).target.editedBlock).toBe('id-1');
    expect(second.op.id).not.toBe('id-1');
    expect((await s.getPageEdits(0)).blocks).toHaveLength(1);
    // The block area is the placement result of the latest edit.
    const third = await begin(s, blockParagraph.id);
    const updated = await s.updateParagraphDraft(
      third.started.draftId,
      draftInput(third.plan, 'Gamma delta '.repeat(6)),
    );
    expect((await s.getPageEdits(0)).blocks[0]!.contentBox).toEqual(updated.reflow.contentBox);
    await s.cancelParagraphEdit(third.started.draftId);
    expect((await s.getPageEdits(0)).blocks[0]!.contentBox).not.toEqual(updated.reflow.contentBox);
    expect(text(s)).toContain('Gamma delta');
    await s.undo();
    expect(text(s)).toContain('Alpha beta');
    s.close();
  });
});

describe('state rules', () => {
  it('cannot begin with a stale revision', async () => {
    const { s } = harness();
    const plan = await s.planParagraphEdit(0, 2);
    await editParagraph(s, 1, 'Changes revision');
    await expect(s.beginParagraphEdit(0, 2, plan.revision)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
    // The journal stays as is, with no open operation.
    expect(journal(s).steps).toHaveLength(1);
    s.close();
  });

  it('one draft per document: other edit RPCs, save classification and save throw during a draft, while render, extraction and search are allowed', async () => {
    const { s } = harness();
    const { plan, started } = await begin(s, 1);
    await expect(s.beginParagraphEdit(0, 2, 0)).rejects.toBeInstanceOf(EditStateError);
    await expect(s.getPageEditability(0)).rejects.toBeInstanceOf(EditStateError);
    await expect(s.planParagraphEdit(0, 2)).rejects.toBeInstanceOf(EditStateError);
    await expect(s.undo()).rejects.toBeInstanceOf(EditStateError);
    await expect(s.redo()).rejects.toBeInstanceOf(EditStateError);
    await expect(s.replayEdits([])).rejects.toBeInstanceOf(EditStateError);
    expect(() => s.planSave({ changes: [] })).toThrow('초안');
    expect(() => s.save({ changes: [] })).toThrow('초안');
    expect(s.renderPage({ pageIndex: 0, scale: 1 }).width).toBe(612);
    expect(text(s)).toContain('Title Heading');
    // A different draft id is rejected.
    await expect(s.updateParagraphDraft('other', draftInput(plan, 'x'))).rejects.toThrow('초안');
    await expect(s.commitParagraphEdit('other')).rejects.toThrow('초안');
    await s.cancelParagraphEdit(started.draftId);
    // Everything works normally after cancel.
    expect((await s.getPageEditability(0)).paragraphs).toHaveLength(3);
    s.close();
  });

  it('a second draft started concurrently is rejected and the first draft stays intact', async () => {
    const { s } = harness();
    const [first, second] = await Promise.allSettled([
      s.beginParagraphEdit(0, 1, 0),
      s.beginParagraphEdit(0, 2, 0),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    const draft = (first as PromiseFulfilledResult<{ draftId: string }>).value;
    await s.cancelParagraphEdit(draft.draftId);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('a paragraph that cannot be edited cannot be started and leaves no journal open', async () => {
    const adapter = createFakeAdapter();
    const s = new PdfSession({ editAdapter: adapter, loadFallbackFont: async () => FONT_BYTES });
    s.open(
      buildPdf([
        {
          content:
            'BT /F1 10 Tf 72 700 Td (LOCKED paragraph) Tj ET\nBT /F1 10 Tf 72 600 Td (free text) Tj ET',
          mediabox: MEDIABOX,
        },
      ]),
    );
    const editability = await s.getPageEditability(0);
    expect(editability.paragraphs.map((p) => [p.editable, p.reasons])).toEqual([
      [false, ['remove-skipped']],
      [true, []],
    ]);
    await expect(s.beginParagraphEdit(0, 0, 0)).rejects.toThrow('remove-skipped');
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    await editParagraph(s, 1, 'works');
    s.close();
  });

  it('a failure during begin (removal, insertion) discards the operation and restores the document', async () => {
    const { s, adapter } = harness();
    const before = text(s);
    adapter.probe.failNext.write = true;
    await expect(s.beginParagraphEdit(0, 1, 0)).rejects.toThrow('fake write 실패');
    expect(text(s)).toBe(before);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    expect((await s.getPageEdits(0)).blocks).toEqual([]);
    adapter.probe.failNext.prepare = true;
    await expect(s.beginParagraphEdit(0, 1, 0)).rejects.toThrow('fake prepare 실패');
    await editParagraph(s, 1, 'recovered');
    expect(text(s)).toContain('recovered');
    s.close();
  });

  it('an update failure keeps the draft and it can be cancelled', async () => {
    const { s, adapter } = harness();
    const { plan, started } = await begin(s, 1);
    adapter.probe.failNext.write = true;
    await expect(s.updateParagraphDraft(started.draftId, draftInput(plan, 'boom'))).rejects.toThrow(
      'fake write 실패',
    );
    const ok = await s.updateParagraphDraft(started.draftId, draftInput(plan, 'fine'));
    expect(ok.reflow.lines.length).toBeGreaterThan(0);
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });

  it('a closed document accepts no edit RPCs', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    s.close();
    await expect(s.getPageEditability(0)).rejects.toThrow('열린 문서 없음');
  });
});

describe('draft preview and warnings', () => {
  it('the changed area covers both the previous and new placed boxes, and the scale follows the last full page render', async () => {
    const { s } = harness();
    s.renderPage({ pageIndex: 0, scale: 1.5 });
    const { plan, started } = await begin(s, 1);
    // The begin preview covers the original paragraph bbox ∪ the placed box. Scale 1.5.
    const [x0, y0, x1, y1] = started.first.region.clip!;
    expect(started.first.region.width).toBeCloseTo((x1 - x0) * 1.5, 6);
    expect(started.first.region.height).toBeCloseTo((y1 - y0) * 1.5, 6);
    const bbox = plan.target.bbox;
    expect(x0).toBeLessThanOrEqual(bbox[0]);
    expect(y1).toBeGreaterThanOrEqual(bbox[3]);
    const box = started.first.reflow.contentBox;
    expect(x0).toBeLessThanOrEqual(box[0]);
    expect(x1).toBeGreaterThanOrEqual(box[2]);

    const long = 'word '.repeat(60);
    const update = await s.updateParagraphDraft(started.draftId, draftInput(plan, long, 3));
    const next = update.reflow.contentBox;
    const [a0, b0, a1, b1] = update.region.clip!;
    expect(a0).toBeLessThanOrEqual(Math.min(box[0], next[0]));
    expect(b0).toBeLessThanOrEqual(Math.min(box[1], next[1]));
    expect(a1).toBeGreaterThanOrEqual(Math.max(box[2], next[2]));
    expect(b1).toBeGreaterThanOrEqual(Math.max(box[3], next[3]));
    expect(update.region.width).toBeCloseTo((a1 - a0) * 3, 6);
    await expect(s.updateParagraphDraft(started.draftId, draftInput(plan, 'x', 0))).rejects.toThrow(
      RangeError,
    );
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });

  it('warnings are based on the current characters: fallback and missing-glyph warnings disappear when the characters are deleted', async () => {
    const { s } = harness();
    const { plan, started } = await begin(s, 1);
    const kinds = async (value: string) =>
      (await s.updateParagraphDraft(started.draftId, draftInput(plan, value))).warnings.map(
        (w) => w.kind,
      );
    expect(await kinds('Latin only')).toEqual([]);
    expect(await kinds('Latin 한글')).toEqual(['font-fallback']);
    expect(await kinds('Latin ☃ 한글')).toEqual(['font-fallback', 'glyph-missing']);
    expect(await kinds('Latin again')).toEqual([]);
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });

  it('text that overflows because the automatic expansion hit the area limit stays overflowing + overflow-clipped warning', async () => {
    const adapter = createFakeAdapter();
    const s = new PdfSession({ editAdapter: adapter, loadFallbackFont: async () => FONT_BYTES });
    s.open(
      buildPdf([
        { content: 'BT /F1 10 Tf 72 30 Td (bottom line of the page) Tj ET', mediabox: MEDIABOX },
      ]),
    );
    const { plan, started } = await begin(s, 0);
    const update = await s.updateParagraphDraft(started.draftId, {
      ...draftInput(plan, 'keep going and going '.repeat(40)),
    });
    expect(update.reflow.overflow).toBe(true);
    expect(update.reflow.area[3]).toBe(plan.areaLimit[3]);
    expect(update.warnings.map((w) => w.kind)).toContain('overflow-clipped');
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });
});

describe('save mode and document lifetime', () => {
  it('a save without changes of a document that was only classified stays incremental, and a document that was begun gets a full save', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    await s.planParagraphEdit(0, 1);
    const plan = s.planSave({ changes: [] });
    expect(plan).toMatchObject({ method: 'incremental', edits: null });
    expect(s.save({ changes: ['annotation'] }).method).toBe('incremental');
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    // Beginning puts the fallback font (an unused object) and Info into the document, so even after cancel it is a full save (an incremental save appends all new objects).
    const { started } = await begin(s, 1);
    await s.cancelParagraphEdit(started.draftId);
    expect(s.planSave({ changes: [] })).toMatchObject({ method: 'full', edits: null });
    expect(s.planSave({ changes: [] }).reason).toContain('편집을 시작');
    const saved = s.save({ changes: [] });
    const reopened = mupdf.PDFDocument.openDocument(
      saved.bytes.slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    expect(fallbackFonts(reopened)).toHaveLength(0); // garbage collection removes the unused fallback font
    s.close();
  });

  it('shows it in the edit summary when there is a PDF/A declaration (XMP pdfaid)', async () => {
    const adapter = createFakeAdapter();
    const s = new PdfSession({ editAdapter: adapter, loadFallbackFont: async () => FONT_BYTES });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const doc = s.document;
    const xmp = doc.addStream(
      '<x:xmpmeta xmlns:x="adobe:ns:meta/"><pdfaid:part>1</pdfaid:part></x:xmpmeta>',
      { Type: doc.newName('Metadata'), Subtype: doc.newName('XML') },
    );
    doc.getTrailer().get('Root').put('Metadata', xmp);
    await editParagraph(s, 1, 'PDF/A edit');
    expect(s.planSave({ changes: [] }).edits).toMatchObject({ pdfaDeclared: true });
    s.close();
  });

  it('closing with a draft open closes without an exception, and reopening starts with a new history', async () => {
    const { s } = harness();
    await begin(s, 1);
    expect(() => s.close()).not.toThrow();
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    expect(await s.getEditHistory()).toMatchObject({ revision: 0, edits: 0, activeEditIds: [] });
    await editParagraph(s, 1, 'After reopen');
    expect(text(s)).toContain('After reopen');
    s.close();
  });
});

describe('page cache invalidation (contract 5.7)', () => {
  it('a commit clears the layout cache of that page and ±2 pages and keeps distant pages', async () => {
    const { s } = harness(7);
    const layouts = Array.from({ length: 7 }, (_, i) => s.getPageLayout(i));
    const model3 = s.extractPage({ pageIndex: 3 });
    const model5 = s.extractPage({ pageIndex: 5 });
    await editParagraph(s, 1, 'Edit on page 3', 3);
    expect(s.extractPage({ pageIndex: 3 })).not.toBe(model3);
    expect(s.extractPage({ pageIndex: 5 })).toBe(model5);
    expect(s.getPageLayout(3)).not.toBe(layouts[3]);
    for (const near of [1, 2, 4, 5]) expect(s.getPageLayout(near)).not.toBe(layouts[near]);
    for (const far of [0, 6]) expect(s.getPageLayout(far)).toBe(layouts[far]);
    s.close();
  });

  it('updating or cancelling a draft rebuilds the extraction cache of that page', async () => {
    const { s } = harness(2);
    const { plan, started } = await begin(s, 1, 1);
    const draftModel = s.extractPage({ pageIndex: 1 });
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Draft body'));
    expect(s.extractPage({ pageIndex: 1 })).not.toBe(draftModel);
    const stale = s.extractPage({ pageIndex: 1 });
    await s.cancelParagraphEdit(started.draftId);
    expect(s.extractPage({ pageIndex: 1 })).not.toBe(stale);
    expect(text(s, 1)).not.toContain('Draft body');
    s.close();
  });
});

describe('failure paths (from independent review)', () => {
  it('when an update fails after writing, it rolls back to the previous content so the log and the document agree', async () => {
    const { s, adapter } = harness();
    const { plan, started } = await begin(s, 1);
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Version X'));
    adapter.probe.failNext.writeAfter = 1;
    await expect(
      s.updateParagraphDraft(started.draftId, draftInput(plan, 'Version Y')),
    ).rejects.toThrow('쓴 뒤');
    expect(text(s)).toContain('Version X');
    expect(text(s)).not.toContain('Version Y');
    const result = await s.commitParagraphEdit(started.draftId);
    expect((result.op as ReplaceParagraphOp).runs.map((r) => r.text)).toEqual(['Version X']);
    s.close();
  });

  it('if the rollback also fails, the draft can only be cancelled', async () => {
    const { s, adapter } = harness();
    const before = text(s);
    const { plan, started } = await begin(s, 1);
    adapter.probe.failNext.writeAfter = 2;
    await expect(
      s.updateParagraphDraft(started.draftId, draftInput(plan, 'Broken')),
    ).rejects.toThrow('쓴 뒤');
    await expect(
      s.updateParagraphDraft(started.draftId, draftInput(plan, 'Again')),
    ).rejects.toThrow('손상');
    await expect(s.commitParagraphEdit(started.draftId)).rejects.toThrow('손상');
    await s.cancelParagraphEdit(started.draftId);
    expect(text(s)).toBe(before);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('returns the commit result even if rebuilding the block list after the commit fails', async () => {
    const { s, adapter } = harness();
    const { plan, started } = await begin(s, 1);
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Committed'));
    const real = adapter.listEditBlocks;
    adapter.listEditBlocks = () => {
      throw new Error('목록 실패');
    };
    const result = await s.commitParagraphEdit(started.draftId);
    adapter.listEditBlocks = real;
    expect(result.history).toMatchObject({ edits: 1, canUndo: true });
    // It is rebuilt on the next use.
    expect((await s.getPageEdits(0)).blocks).toHaveLength(1);
    s.close();
  });

  it('makes the session unusable when the committed edit is not in the journal', async () => {
    const { s } = harness();
    const { plan, started } = await begin(s, 1);
    await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Lost'));
    const doc = s.document;
    doc.getJournal = () => ({ position: 0, steps: [] });
    await expect(s.commitParagraphEdit(started.draftId)).rejects.toThrow('저널에 기록되지 않음');
    await expect(s.getEditHistory()).rejects.toThrow('다시 열어야');
    s.close();
  });
});

describe('number of paragraphs with a broken structure link (SavePlan.edits)', () => {
  it('re-editing the same block still counts as one paragraph', async () => {
    const { s, adapter } = harness();
    adapter.probe.planWarnings = [
      { kind: 'tagged-structure-unlinked', message: '구조 연결 끊김', rects: [] },
    ];
    await editParagraph(s, 1, 'Tagged one');
    expect(s.planSave({ changes: [] }).edits?.structureUnlinked).toBe(1);
    expect(adapter.probe.metadataCalls.at(-1)).toEqual({ pages: [0], structureNotUpdated: true });
    const block = s.getPageLayout(0).paragraphs.find((p) => p.text.includes('Tagged one'))!;
    await editParagraph(s, block.id, 'Tagged two');
    await editParagraph(
      s,
      s.getPageLayout(0).paragraphs.find((p) => p.text.includes('Tagged two'))!.id,
      'Tagged three',
    );
    expect(s.planSave({ changes: [] }).edits?.structureUnlinked).toBe(1);
    await editParagraph(
      s,
      s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith('Second'))!.id,
      'Other paragraph',
    );
    expect(s.planSave({ changes: [] }).edits?.structureUnlinked).toBe(2);
    s.close();
  });
});

describe('Info dictionary and caches', () => {
  it('for a document whose trailer /Info is a direct dictionary, the metadata record is also reverted by undo', async () => {
    const adapter = createFakeAdapter();
    const direct = new mupdf.PDFDocument();
    const f1 = direct.addSimpleFont(new mupdf.Font('Helvetica'));
    direct.insertPage(
      -1,
      direct.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: f1 } },
        'BT /F1 10 Tf 72 700 Td (direct info doc) Tj ET',
      ),
    );
    const info = direct.newDictionary();
    info.put('Title', direct.newString('t'));
    direct.getTrailer().put('Info', info);
    const buffer = direct.saveToBuffer('');
    const bytes = buffer.asUint8Array().slice();
    buffer.destroy();
    const s = new PdfSession({ editAdapter: adapter, loadFallbackFont: async () => FONT_BYTES });
    s.open(bytes);
    expect(s.document.getTrailer().get('Info').isIndirect()).toBe(false);
    await editParagraph(s, 0, 'Edited direct');
    const key = () => s.document.getTrailer().get('Info').get('PdfEditorEdits');
    expect(key().isNull()).toBe(false);
    await s.undo();
    expect(key().isNull()).toBe(true);
    expect(s.document.getTrailer().get('Info').get('Title').asString()).toBe('t');
    await s.redo();
    expect(key().isNull()).toBe(false);
    s.close();
  });

  it('when a page drops out of the source link info cache, the matching cache is rebuilt too', () => {
    const s = new PdfSession();
    s.open(buildPdf(Array.from({ length: 18 }, () => ({ content: PAGE, mediabox: MEDIABOX }))));
    const first = s.linkPage(0);
    expect(s.linkPage(0)).toBe(first);
    for (let i = 1; i <= 16; i++) s.getSourceMap(i); // 16-page LRU: the source link info of page 0 is evicted
    expect(s.linkPage(0)).not.toBe(first);
    s.close();
  });
});
