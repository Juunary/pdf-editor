/** M3 후속(docs/m4-contract.md 1.2): R-M4 실패 상태 저장, R-L5 폴백 로드 실패, R-L2 폴백 서브셋 이름 태그. */
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

/** 저장 파일에서 폴백 폰트 서브셋(FontFile2 가 있는 Type0 폰트)을 모두 찾는다. */
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

describe('R-L5 폴백 폰트 로드 실패', () => {
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

  it('판정·편집이 폴백 없이 진행되고 폴백이 필요한 글자만 glyph-missing 이다', async () => {
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
    // 저장도 된다.
    expect(s.save({ changes: [] }).bytes.length).toBeGreaterThan(0);
    s.close();
  });

  it('저널을 켠 뒤에는 다시 시도하지 않는다(폴백 폰트를 넣을 수 없음)', async () => {
    const { s, loads } = failing();
    await editParagraph(s, 1, 'Latin only');
    const afterBegin = loads.count;
    await editParagraph(s, 2, 'More latin');
    await s.getPageEditability(0).catch(() => undefined);
    expect(loads.count).toBe(afterBegin);
    s.close();
  });

  it('저널을 켜기 전에 로드가 성공하면 그때부터 폴백을 쓴다', async () => {
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

describe('R-M4 실패 상태에서의 저장', () => {
  /** 재적용이 중간에 실패한(문서가 일부만 바뀐) 세션. */
  async function failedSession(): Promise<PdfSession> {
    const source = harness();
    const edited = await editParagraph(source.s, 1, 'kept before failure');
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

  it('편집 RPC 는 막히지만 저장은 저널로 감싸지 않고 경고와 함께 내보낸다', async () => {
    const s = await failedSession();
    await expect(s.getEditHistory()).rejects.toThrow('다시 열어야');
    const plan = s.planSave({ changes: [] });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('재적용 실패');
    const saved = s.save({ changes: [] });
    expect(saved.warnings).toEqual(plan.warnings);
    // 실패 전에 적용된 편집은 저장 파일에 들어 있다.
    const doc = reopen(saved.bytes);
    const page = doc.loadPage(0);
    expect(page.toStructuredText('preserve-whitespace').asText()).toContain('kept before failure');
    // 저장은 저널 단계를 만들지 않는다(이 세션은 저널 보호 없이 내보냈지만 undo 불가 상태라 무해).
    expect(saved.method).toBe('full');
    s.close();
  });

  it('정상 세션의 저장 경고는 빈 배열이다', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'fine');
    expect(s.planSave({ changes: [] }).warnings).toEqual([]);
    expect(s.save({ changes: [] }).warnings).toEqual([]);
    s.close();
  });

  it('초안이 열린 정상 세션의 저장은 여전히 거절한다', async () => {
    const { s } = harness();
    const { started } = await begin(s, 1);
    expect(() => s.save({ changes: [] })).toThrow('초안');
    await s.cancelParagraphEdit(started.draftId);
    expect(journal(s).steps).toHaveLength(0);
    s.close();
  });
});

describe('R-L2 폴백 서브셋 이름 태그', () => {
  it('저장 파일의 폴백 폰트 /BaseFont 와 FontName 에 서브셋 태그가 붙고 작업 문서는 그대로다', async () => {
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
    // 작업 문서는 저장 작업을 버려 원래 이름이다(전체 폰트 유지).
    expect(fallbackFonts(s.document)[0]!.get('BaseFont').asName()).toBe('NotoSansKR');
    // 같은 편집 상태의 두 번째 저장은 같은 태그(결정성).
    const again = s.save({ changes: [] });
    const f2 = type0Fonts(reopen(again.bytes)).find((f) =>
      /\+NotoSansKR$/.test(f.get('BaseFont').asName()),
    )!;
    expect(f2.get('BaseFont').asName()).toBe(base);
    s.close();
  });

  it('폴백을 쓰지 않았으면 서브셋 폰트도 태그도 없다', async () => {
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

  it('패스 편집만 있는 세션 저장은 폴백 서브셋을 건드리지 않는다', async () => {
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
