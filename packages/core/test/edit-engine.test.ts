/**
 * 편집 엔진(저널·로그·초안·undo/redo) 단위 시험. pdf-ops·reflow 의 M3 함수 대신 가짜 어댑터를 쓰되 문서·저널·폰트
 * 추가는 실제 MuPDF 위에서 돈다(docs/m3-core.md 3절).
 */
import { describe, expect, it } from 'vitest';
import { PdfSession } from '../src/index.js';
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

describe('판정 RPC', () => {
  it('첫 호출에서 폴백 폰트를 한 번 await 하고, 판정은 문서를 바꾸지 않으며 저널도 켜지 않는다', async () => {
    const { s, fontLoads } = harness();
    const [a, b] = await Promise.all([s.getPageEditability(0), s.getPageEditability(0)]);
    expect(fontLoads.count).toBe(1);
    expect(a.revision).toBe(0);
    expect(a.paragraphs.map((p) => p.editable)).toEqual([true, true, true]);
    expect(b.ms).toBeGreaterThanOrEqual(0);
    await s.planParagraphEdit(0, 1);
    expect(fontLoads.count).toBe(1);
    // Info·폴백 폰트·저널은 첫 시작에서 만든다(계약 5.7 수정 1).
    expect(s.document.getTrailer().get('Info').isNull()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(0);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    expect(s.document.canUndo()).toBe(false);

    const { started } = await begin(s, 1);
    expect(fontLoads.count).toBe(1);
    // 저널을 켜기 직전(작업 밖)에 만든 객체라 취소·undo 로 끊기지 않는다.
    expect(s.document.getTrailer().get('Info').resolve().isDictionary()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(1);
    await s.cancelParagraphEdit(started.draftId);
    expect(s.document.getTrailer().get('Info').resolve().isDictionary()).toBe(true);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('폴백 폰트 로드 실패는 전달하고 다음 호출에서 다시 시도한다', async () => {
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
    await expect(s.getPageEditability(0)).rejects.toThrow('폰트 파일 없음');
    expect((await s.getPageEditability(0)).paragraphs).toHaveLength(3);
    expect(calls).toBe(2);
    s.close();
  });

  it('기본 어댑터(실제 pdf-ops·reflow, M3 통합)로 판정한다', async () => {
    const s = new PdfSession();
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const editability = await s.getPageEditability(0);
    expect(editability.paragraphs.some((p) => p.editable)).toBe(true);
    s.close();
  });

  it('열린 문서가 없으면 예외', async () => {
    const s = new PdfSession();
    await expect(s.getEditHistory()).rejects.toThrow('열린 문서 없음');
  });
});

describe('초안 → 커밋 → undo/redo', () => {
  it('시작 시 원 문단이 편집 블록으로 바뀌고 초안 상태가 렌더·추출·검색에 보인다', async () => {
    const { s } = harness();
    const before = text(s);
    const { plan, started } = await begin(s, 1);
    expect(plan.editable).toBe(true);
    expect(started.plan.revision).toBe(0);
    expect(started.first.region.clip).not.toBeNull();
    expect(started.first.reflow.lines.length).toBeGreaterThan(0);
    // 초안 중에도 같은 글자가 보인다(블록으로 다시 그려진 것).
    expect(text(s)).toContain('first paragraph line one');
    await expect(s.getPageEdits(0)).resolves.toMatchObject({ blocks: [{ editId: 'id-1' }] });

    const update = await s.updateParagraphDraft(started.draftId, draftInput(plan, 'Hello 가나다'));
    expect(update.draftId).toBe(started.draftId);
    expect(update.warnings.map((w) => w.kind)).toEqual(['font-fallback']);
    expect(update.region.clip).not.toBeNull();
    expect(text(s)).toContain('Hello 가나다');
    expect(text(s)).not.toContain('first paragraph');
    expect(s.searchText({ query: 'Hello' }).hits.length).toBeGreaterThan(0);
    // 다른 쪽 글자는 그대로.
    expect(text(s)).toContain('Title Heading');
    expect(text(s)).not.toBe(before);
    // 초안 중 이력 질의는 core 상태로 답한다(MuPDF canUndo 는 작업 중 예외).
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

  it('커밋: 로그·revision·activeEditIds·저널 단계, 쪽 캐시 무효화', async () => {
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
    expect(result.op.runs.map((r) => r.text)).toEqual(['Replaced text']);
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

  it('취소: 문서·블록 목록·저널·revision 이 원상태', async () => {
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
    // 취소 뒤 같은 문단을 같은 revision 으로 다시 시작할 수 있다.
    const again = await s.beginParagraphEdit(0, 1, plan.revision);
    await s.cancelParagraphEdit(again.draftId);
    s.close();
  });

  it('undo/redo: 글자·블록 목록·activeEditIds·영향 쪽·revision', async () => {
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

  it('undo 뒤 새로 커밋하면 redo 를 버린다(뷰어는 activeEditIds 에 없는 EditOp 를 버린다)', async () => {
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

  it('할 일이 없는 undo/redo 는 문서·revision 을 바꾸지 않는다', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    expect(await s.undo()).toMatchObject({ revision: 0, affectedPages: [], canUndo: false });
    expect(await s.redo()).toMatchObject({ revision: 0, affectedPages: [] });
    s.close();
  });

  it('재편집: 편집 블록 문단을 다시 편집해도 블록 하나(중첩 없음)', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Alpha beta');
    const blockParagraph = s
      .getPageLayout(0)
      .paragraphs.find((p) => p.text.includes('Alpha beta'))!;
    const plan = await s.planParagraphEdit(0, blockParagraph.id);
    expect(plan.target.editedBlock).toBe('id-1');
    const second = await editParagraph(s, blockParagraph.id, 'Gamma delta');
    expect(second.op.target.editedBlock).toBe('id-1');
    expect(second.op.id).not.toBe('id-1');
    expect((await s.getPageEdits(0)).blocks).toHaveLength(1);
    // 블록 영역은 가장 나중 편집의 배치 결과다.
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

describe('상태 규칙', () => {
  it('오래된 revision 으로는 시작할 수 없다', async () => {
    const { s } = harness();
    const plan = await s.planParagraphEdit(0, 2);
    await editParagraph(s, 1, 'Changes revision');
    await expect(s.beginParagraphEdit(0, 2, plan.revision)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
    // 저널은 열린 작업 없이 그대로.
    expect(journal(s).steps).toHaveLength(1);
    s.close();
  });

  it('초안은 문서당 1개: 초안 중 다른 편집 RPC·저장 판정·저장은 예외, 렌더·추출·검색은 허용', async () => {
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
    // 다른 초안 id 는 거절.
    await expect(s.updateParagraphDraft('other', draftInput(plan, 'x'))).rejects.toThrow('초안');
    await expect(s.commitParagraphEdit('other')).rejects.toThrow('초안');
    await s.cancelParagraphEdit(started.draftId);
    // 취소 뒤에는 모두 정상.
    expect((await s.getPageEditability(0)).paragraphs).toHaveLength(3);
    s.close();
  });

  it('동시에 시작한 두 번째 초안은 거절되고 첫 초안은 온전하다', async () => {
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

  it('편집할 수 없는 문단은 시작할 수 없고 저널을 열어 두지 않는다', async () => {
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

  it('시작 중 실패(제거·삽입)는 작업을 버리고 문서를 되돌린다', async () => {
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

  it('갱신 실패는 초안을 유지하고 취소할 수 있다', async () => {
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

  it('닫은 문서는 편집 RPC 를 받지 않는다', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    s.close();
    await expect(s.getPageEditability(0)).rejects.toThrow('열린 문서 없음');
  });
});

describe('초안 미리보기·경고', () => {
  it('변경 영역은 이전·새 배치 상자를 모두 덮고 배율은 마지막 쪽 전체 렌더를 따른다', async () => {
    const { s } = harness();
    s.renderPage({ pageIndex: 0, scale: 1.5 });
    const { plan, started } = await begin(s, 1);
    // 시작 미리보기는 원 문단 bbox ∪ 배치 상자를 덮는다. 배율 1.5.
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

  it('경고는 현재 글자 기준이다: 폴백·없는 글자 경고가 글자를 지우면 사라진다', async () => {
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

  it('자동 확장이 영역 상한에 막혀 넘친 글은 초과 유지 + overflow-clipped 경고', async () => {
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

describe('저장 방식·문서 수명', () => {
  it('판정만 한 문서의 변경 없는 저장은 증분 그대로이고, 시작한 문서는 전체 저장이다', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    await s.planParagraphEdit(0, 1);
    const plan = s.planSave({ changes: [] });
    expect(plan).toMatchObject({ method: 'incremental', edits: null });
    expect(s.save({ changes: ['annotation'] }).method).toBe('incremental');
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    // 시작하면 폴백 폰트(미사용 객체)와 Info 가 문서에 들어가므로 취소해도 전체 저장이다(증분은 새 객체를 모두 덧붙인다).
    const { started } = await begin(s, 1);
    await s.cancelParagraphEdit(started.draftId);
    expect(s.planSave({ changes: [] })).toMatchObject({ method: 'full', edits: null });
    expect(s.planSave({ changes: [] }).reason).toContain('편집을 시작');
    const saved = s.save({ changes: [] });
    const reopened = mupdf.PDFDocument.openDocument(
      saved.bytes.slice(),
      'application/pdf',
    ) as mupdf.PDFDocument;
    expect(fallbackFonts(reopened)).toHaveLength(0); // 미사용 폴백 폰트는 garbage 가 뺀다
    s.close();
  });

  it('PDF/A 선언(XMP pdfaid)이 있으면 편집 요약에 표시한다', async () => {
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

  it('초안이 열린 채 닫아도 예외 없이 닫히고, 다시 열면 새 이력으로 시작한다', async () => {
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

describe('쪽 캐시 무효화(계약 5.7)', () => {
  it('커밋하면 그 쪽과 ±2쪽 레이아웃 캐시를 비우고 먼 쪽은 둔다', async () => {
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

  it('초안을 갱신·취소하면 그 쪽 추출 캐시를 다시 만든다', async () => {
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

describe('실패 경로(독립 검토 반영)', () => {
  it('갱신이 쓴 뒤에 실패하면 직전 내용으로 되돌려 로그와 문서가 같다', async () => {
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
    expect(result.op.runs.map((r) => r.text)).toEqual(['Version X']);
    s.close();
  });

  it('되돌리기도 실패하면 초안은 취소만 할 수 있다', async () => {
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

  it('커밋 뒤 블록 목록 재구성이 실패해도 커밋 결과를 돌려준다', async () => {
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
    // 다음에 쓸 때 다시 만든다.
    expect((await s.getPageEdits(0)).blocks).toHaveLength(1);
    s.close();
  });

  it('커밋한 편집이 저널에 없으면 세션을 쓸 수 없게 한다', async () => {
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

describe('구조 연결이 끊긴 문단 수(SavePlan.edits)', () => {
  it('같은 블록을 다시 편집해도 문단 하나로 센다', async () => {
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

describe('Info 사전과 캐시', () => {
  it('trailer /Info 가 직접 사전인 문서도 메타 기록이 undo 로 되돌아간다', async () => {
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

  it('원본 연결 정보 캐시에서 쪽이 빠지면 매칭 캐시도 다시 만든다', () => {
    const s = new PdfSession();
    s.open(buildPdf(Array.from({ length: 18 }, () => ({ content: PAGE, mediabox: MEDIABOX }))));
    const first = s.linkPage(0);
    expect(s.linkPage(0)).toBe(first);
    for (let i = 1; i <= 16; i++) s.getSourceMap(i); // 16쪽 LRU: 0쪽 원본 연결 정보가 밀려난다
    expect(s.linkPage(0)).not.toBe(first);
    s.close();
  });
});
