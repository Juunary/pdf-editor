/** M3 follow-up (docs/m4-contract.md 1.2): R-M4 save in failed state, R-L5 fallback load failure, R-L2 fallback subset name tag. */
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { EditPathOp } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
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
} from './edit-harness.js';

const HANGUL_TEXT = '한글 문장입니다';
const PATH_PAGE = [PAGE, '0.5 g', '100 300 80 40 re f'].join('\n');

function reopen(bytes: Uint8Array): mupdf.PDFDocument {
  return mupdf.Document.openDocument(bytes, 'application/pdf') as mupdf.PDFDocument;
}

/** Finds all fallback font subsets (Type0 fonts with FontFile2) in the saved file. */
function type0Fonts(doc: mupdf.PDFDocument): mupdf.PDFObject[] {
  const found: mupdf.PDFObject[] = [];
  for (let n = 1; n < doc.countObjects(); n++) {
    const obj = doc.newIndirect(n);
    if (
      obj.isDictionary() &&
      obj.get('Subtype').isName() &&
      obj.get('Subtype').asName() === 'Type0'
    ) {
      found.push(obj);
    }
  }
  return found;
}

describe('R-L5 fallback font load failure', () => {
  function failing(): { s: PdfSession; loads: { count: number } } {
    const loads = { count: 0 };
    const s = new PdfSession({
      editAdapter: createFakeAdapter(),
      loadFallbackFont: async () => {
        loads.count++;
        throw new Error('폰트 서버 불가');
      },
    });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    return { s, loads };
  }

  it('classification and editing proceed without the fallback, and only characters that need the fallback are glyph-missing', async () => {
    const { s } = failing();
    expect((await s.getPageEditability(0)).paragraphs.some((p) => p.editable)).toBe(true);
    const { plan, started } = await begin(s, 1);
    expect(s.fallbackLoadError).toBe('폰트 서버 불가');
    expect(started.first.warnings.map((w) => w.kind)).not.toContain('glyph-missing');
    const update = await s.updateParagraphDraft(
      started.draftId,
      draftInput(plan, `Latin ${HANGUL_TEXT}`),
    );
    expect(update.warnings.map((w) => w.kind)).toContain('glyph-missing');
    expect(update.warnings.map((w) => w.kind)).not.toContain('font-fallback');
    const latin = await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Latin only'));
    expect(latin.warnings.map((w) => w.kind)).not.toContain('glyph-missing');
    await s.commitParagraphEdit(started.draftId);
    expect(fallbackFonts(s.document)).toHaveLength(0);
    // Saving works too.
    expect(s.save({ changes: [] }).bytes.length).toBeGreaterThan(0);
    s.close();
  });

  it('does not retry after the journal is enabled (the fallback font cannot be added)', async () => {
    const { s, loads } = failing();
    await editParagraph(s, 1, 'Latin only');
    const afterBegin = loads.count;
    await editParagraph(s, 2, 'More latin');
    await s.getPageEditability(0).catch(() => undefined);
    expect(loads.count).toBe(afterBegin);
    s.close();
  });

  it('if the load succeeds before the journal is enabled, the fallback is used from then on', async () => {
    let calls = 0;
    const s = new PdfSession({
      editAdapter: createFakeAdapter(),
      loadFallbackFont: async () => {
        calls++;
        if (calls === 1) throw new Error('일시 오류');
        return FONT_BYTES;
      },
    });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    await s.getPageEditability(0);
    expect(s.fallbackLoadError).toBe('일시 오류');
    const { plan, started } = await begin(s, 1);
    expect(s.fallbackLoadError).toBeNull();
    const update = await s.updateParagraphDraft(started.draftId, draftInput(plan, HANGUL_TEXT));
    expect(update.warnings.map((w) => w.kind)).toContain('font-fallback');
    expect(update.warnings.map((w) => w.kind)).not.toContain('glyph-missing');
    await s.cancelParagraphEdit(started.draftId);
    s.close();
  });
});

describe('R-M4 save in failed state', () => {
  /** A session where reapply failed midway (the document was only partly changed). */
  async function failedSession(text = 'kept before failure'): Promise<PdfSession> {
    const source = harness();
    const edited = await editParagraph(source.s, 1, text);
    const ops = [edited.op];
    const s = new PdfSession({
      editAdapter: createFakeAdapter(),
      loadFallbackFont: async () => FONT_BYTES,
    });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const broken = {
      ...ops[0]!,
      id: 'broken',
      target: { ...(ops[0] as { target: object }).target, glyphSeqs: [9999] },
    };
    await expect(s.replayEdits([ops[0]!, broken] as never)).rejects.toThrow('재적용 실패(2/2');
    source.s.close();
    return s;
  }

  it('edit RPCs are blocked, but saving is exported with warnings without being wrapped in the journal', async () => {
    const s = await failedSession();
    await expect(s.getEditHistory()).rejects.toThrow('다시 열어야');
    const plan = s.planSave({ changes: [] });
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warningCodes).toEqual(['edit-engine-failed']); // code for screens in other languages (2026-10-26)
    expect(plan.warnings[0]).toContain('재적용 실패');
    expect(plan.warnings[1]).toContain('일부만');
    expect(plan.warnings[1]).toContain('취소한 초안');
    const saved = s.save({ changes: [] });
    expect(saved.warnings).toEqual(plan.warnings);
    // Edits applied before the failure are in the saved file.
    const doc = reopen(saved.bytes);
    const page = doc.loadPage(0);
    expect(page.toStructuredText('preserve-whitespace').asText()).toContain('kept before failure');
    // Saving creates no journal step (this session exported without journal protection, but it cannot undo anyway, so it is harmless).
    expect(saved.method).toBe('full');
    s.close();
  });

  it('saving in a failed state also does the fallback subset replacement and name tagging (R-L2) on a best-effort basis', async () => {
    const s = await failedSession(HANGUL_TEXT);
    const saved = s.save({ changes: [] });
    expect(saved.warnings).toHaveLength(2);
    const fonts = type0Fonts(reopen(saved.bytes)).filter((f) =>
      /^[A-Z]{6}\+NotoSansKR$/.test(f.get('BaseFont').asName()),
    );
    expect(fonts).toHaveLength(1);
    // Subset: smaller than the full fallback font (FONT_BYTES).
    const file = fonts[0]!.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    const buf = file.readStream();
    try {
      expect(buf.getLength()).toBeLessThan(FONT_BYTES.byteLength);
    } finally {
      buf.destroy();
    }
    // Saving again gives the same name (the tag is not added twice).
    const again = type0Fonts(reopen(s.save({ changes: [] }).bytes)).map((f) =>
      f.get('BaseFont').asName(),
    );
    expect(again).toContain(fonts[0]!.get('BaseFont').asName());
    s.close();
  });

  it('the save warnings of a healthy session are an empty array', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'fine');
    expect(s.planSave({ changes: [] }).warnings).toEqual([]);
    expect(s.planSave({ changes: [] }).warningCodes).toEqual([]);
    expect(s.save({ changes: [] }).warnings).toEqual([]);
    s.close();
  });

  it('saving a healthy session with an open draft is still rejected', async () => {
    const { s } = harness();
    const { started } = await begin(s, 1);
    expect(() => s.save({ changes: [] })).toThrow('초안');
    await s.cancelParagraphEdit(started.draftId);
    expect(journal(s).steps).toHaveLength(0);
    s.close();
  });
});

describe('R-L2 fallback subset name tag', () => {
  it('the subset tag is added to the fallback font /BaseFont and FontName in the saved file, and the working document is unchanged', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    const live = fallbackFonts(s.document)[0]!;
    expect(live.get('BaseFont').asName()).toBe('NotoSansKR');
    const saved = s.save({ changes: [] });
    const fonts = type0Fonts(reopen(saved.bytes)).filter((f) =>
      /\+NotoSansKR$/.test(f.get('BaseFont').asName()),
    );
    expect(fonts).toHaveLength(1);
    const base = fonts[0]!.get('BaseFont').asName();
    expect(base).toMatch(/^[A-Z]{6}\+NotoSansKR$/);
    const descendant = fonts[0]!.get('DescendantFonts').get(0);
    expect(descendant.get('BaseFont').asName()).toBe(base);
    expect(descendant.get('FontDescriptor').get('FontName').asName()).toBe(base);
    // The working document discards the save work, so it keeps the original name (full font kept).
    expect(fallbackFonts(s.document)[0]!.get('BaseFont').asName()).toBe('NotoSansKR');
    // A second save of the same edit state gives the same tag (determinism).
    const again = s.save({ changes: [] });
    const f2 = type0Fonts(reopen(again.bytes)).find((f) =>
      /\+NotoSansKR$/.test(f.get('BaseFont').asName()),
    )!;
    expect(f2.get('BaseFont').asName()).toBe(base);
    s.close();
  });

  it('without using the fallback there is neither a subset font nor a tag', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin only');
    const saved = s.save({ changes: [] });
    expect(
      type0Fonts(reopen(saved.bytes)).some((f) =>
        /^[A-Z]{6}\+NotoSansKR$/.test(f.get('BaseFont').asName()),
      ),
    ).toBe(false);
    s.close();
  });

  it('saving a session with only path edits does not touch the fallback subset', async () => {
    const s = new PdfSession({
      editAdapter: createFakeAdapter(),
      loadFallbackFont: async () => FONT_BYTES,
    });
    s.open(buildPdf([{ content: PATH_PAGE, mediabox: MEDIABOX }]));
    const seq = s.extractPage({ pageIndex: 0 }).paths[0]!.paintSeq;
    const plan = await s.planPathEdit(0, [seq]);
    const started = await s.beginPathEdit(0, [seq], plan.revision);
    await s.updatePathDraft(
      started.draftId,
      {
        transform: null,
        fill: [0, 1, 0],
        stroke: null,
        lineWidth: null,
        points: null,
        delete: false,
      },
      1,
    );
    const { op } = await s.commitPathEdit(started.draftId);
    expect((op as EditPathOp).kind).toBe('edit-path');
    const saved = s.save({ changes: [] });
    expect(
      type0Fonts(reopen(saved.bytes)).some((f) =>
        /^[A-Z]{6}\+NotoSansKR$/.test(f.get('BaseFont').asName()),
      ),
    ).toBe(false);
    expect(journal(s).steps).toHaveLength(1);
    s.close();
  });
});
