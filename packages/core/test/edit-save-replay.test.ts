/**
 * 폴백 폰트 수명(V1 시나리오)·D9 감싼 저장·로그 재적용 시험. 가짜 어댑터의 FontManager 는 계약 D4 의 수명 규칙(쓸 때마다
 * 객체가 있는지 확인하고 없으면 로더 바이트로 현재 작업 안에서 다시 넣는다)을 그대로 흉내 낸다.
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

/** 저장 결과를 새 문서로 연다. */
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

describe('폴백 폰트 수명(V1, 계약 D4 수정 1)', () => {
  it('폴백 폰트는 첫 시작에서 저널을 켜기 직전(작업 밖)에 한 번 임베딩되고 판정은 문서를 바꾸지 않는다', async () => {
    const { s } = harness();
    await s.getPageEditability(0);
    await s.planParagraphEdit(0, 1);
    // 판정만으로는 Info·폴백 폰트·저널이 생기지 않는다.
    expect(s.document.getTrailer().get('Info').isNull()).toBe(true);
    expect(fallbackFonts(s.document)).toHaveLength(0);
    expect(s.planSave({ changes: [] }).method).toBe('incremental');

    const { started } = await begin(s, 1);
    const fonts = fallbackFonts(s.document);
    expect(fonts).toHaveLength(1);
    expect(s.document.getTrailer().get('Info').isDictionary()).toBe(true);
    await s.cancelParagraphEdit(started.draftId);
    // 취소해도 폴백 폰트는 저널 밖 객체라 그대로다.
    expect(fallbackFonts(s.document).map((f) => f.asIndirect())).toEqual(
      fonts.map((f) => f.asIndirect()),
    );
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });

  it('폴백을 넣은 초안 취소 뒤 새 편집', async () => {
    const { s } = harness();
    const first = await begin(s, 1);
    await s.updateParagraphDraft(first.started.draftId, draftInput(first.plan, HANGUL_TEXT));
    const fontNumber = fallbackFonts(s.document)[0]!.asIndirect();
    expect(text(s)).toContain(HANGUL_TEXT);
    await s.cancelParagraphEdit(first.started.draftId);
    expect(journal(s)).toEqual({ position: 0, steps: [] });

    // 취소 뒤에도 같은 폰트 객체를 쓴다(다시 임베딩하지 않는다).
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

  it('폴백을 넣은 편집 undo 뒤 새 편집 → 저장', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    const fontNumber = fallbackFonts(s.document)[0]!.asIndirect();
    await s.undo();
    // undo 로도 폰트 객체는 남는다(저널 밖 객체).
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
    // 저장 뒤에도 undo/redo 가 정상이다.
    await s.undo();
    expect(text(s)).not.toContain('다른 문장');
    await s.redo();
    expect(text(s)).toContain('다른 문장 입니다');
    s.close();
  });

  it('폴백 폰트를 쓰지 않은 편집만 저장하면 파일에 폴백 폰트가 없다(garbage 가 뺀다)', async () => {
    const { s } = harness();
    await editParagraph(s, 1, 'Latin only');
    expect(fallbackFonts(s.document)).toHaveLength(1);
    const saved = s.save({ changes: [] });
    expect(fallbackFonts(reopen(saved.bytes))).toHaveLength(0);
    expect(reopenedText(saved.bytes)).toContain('Latin only');
    s.close();
  });

  it('폴백을 쓴 편집 둘을 쌓은 뒤 순서대로 undo → redo, 폰트는 문서에 하나', async () => {
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

describe('D9 저장: beginOperation → 메타 기록·서브셋 → saveToBuffer → abandonOperation', () => {
  it('저장 결과에 편집·Info·서브셋이 반영되고 작업 문서·저널은 저장 전 상태로 남는다', async () => {
    const { s, adapter } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    // Info 기록은 커밋 작업 안에서 한다(저널에 기록되어 undo·redo 와 함께 움직인다).
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

    // 출력: 편집 반영, Info 기록, 폴백 서브셋.
    const out = reopen(saved.bytes);
    expect(out.getTrailer().get('Info').get('PdfEditorEdits').asString()).toBe(
      'pages=1; structure=n/a',
    );
    expect(reopenedText(saved.bytes)).toContain(HANGUL_TEXT);
    const outSize = fontFile(out).readStream().asUint8Array().length;
    expect(outSize).toBeLessThan(workingSize / 10);

    // 작업 문서: 저널 단계 불변, 전체 폰트 유지.
    expect(journal(s)).toEqual(stepsBefore);
    expect(fontFile(s.document).readStream().asUint8Array().length).toBe(workingSize);

    // 저장 뒤 계속 편집(새 음절이 빈 글리프가 되지 않음)하고 undo/redo.
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

  it('Info 기록은 undo·redo 와 함께 움직인다', async () => {
    const { s } = harness();
    // 첫 `beginParagraphEdit` 가 빈 Info 사전을 만든다(저널을 켜기 전).
    const warmup = await begin(s, 1);
    await s.cancelParagraphEdit(warmup.started.draftId);
    const info = () => s.document.getTrailer().get('Info').get('PdfEditorEdits');
    expect(info().isNull()).toBe(true);
    await editParagraph(s, 1, 'Latin');
    expect(info().asString()).toBe('pages=1; structure=n/a');
    await s.undo();
    expect(info().isNull()).toBe(true);
    // 저장은 편집이 없는 상태이므로 Info 에 편집 쪽이 없다.
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

  it('objstms 저장이 저널 단계를 만들지 않아 저장 직후 첫 undo 가 유효하다', async () => {
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

  it('planSave: 편집 요약·변경 종류(content-stream, 폴백 사용 시 font-embed)·전체 저장', async () => {
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
    // 마지막 편집(폴백)을 undo 하면 font-embed 가 빠지고, 모두 undo 하면 편집 요약이 없다.
    await s.undo();
    await s.undo();
    plan = s.planSave({ changes: [] });
    expect(plan.edits).toBeNull();
    // 편집 이력이 있는(저널이 켜진) 문서는 변경이 없어도 전체 저장이다(증분 구간에 되돌린 객체 흔적 방지).
    expect(plan.method).toBe('full');
    expect(plan.reason).toContain('편집을 시작');
    s.close();
  });

  it('세션에서 전체 저장을 한 번 했으면 이후 저장도 전체 저장', () => {
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

  it('저널을 켜지 않은 문서(편집 RPC 미사용)의 저장은 감싸지 않는다', () => {
    const s = new PdfSession({ editAdapter: createFakeAdapter() });
    s.open(buildPdf([{ content: PAGE, mediabox: MEDIABOX }]));
    const saved = s.save({ changes: ['annotation'] });
    expect(saved.method).toBe('incremental');
    s.close();
  });

  it('저장 중 예외는 작업을 버리고 저널을 유지한다', async () => {
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

describe('redo 단계 보존(MuPDF: 작업 안 첫 변경이 redo 를 버린다)', () => {
  it('undo 뒤 저장해도 폴백을 쓰지 않았다면 redo 가 남는다', async () => {
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

  it('폴백을 쓴 편집이 있으면 undo 뒤 저장이 redo 를 잃고, core 상태도 저널에 맞춰 비운다', async () => {
    const { s } = harness();
    await editParagraph(s, 1, HANGUL_TEXT);
    await editParagraph(s, 2, 'Latin two');
    await s.undo();
    const saved = s.save({ changes: [] });
    expect(reopenedText(saved.bytes)).toContain(HANGUL_TEXT);
    // 서브셋 교체가 작업 안에서 객체를 바꿔 MuPDF 가 redo 단계를 버렸다.
    expect(await s.getEditHistory()).toMatchObject({ canUndo: true, canRedo: false, edits: 1 });
    expect(journal(s)).toEqual({ position: 1, steps: ['paragraph-edit'] });
    expect(await s.redo()).toMatchObject({ canRedo: false, affectedPages: [] });
    // undo 는 정상.
    await s.undo();
    expect(text(s)).toContain('first paragraph');
    s.close();
  });

  it('undo 뒤 초안을 시작하면 redo 가 없어지고 취소해도 돌아오지 않는다', async () => {
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

  it('undo 뒤 판정만 해서는 redo 가 남는다', async () => {
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

/** 문서 상태 스냅샷: 쪽 콘텐츠·편집 블록 스트림 바이트와 글자(재적용 결정성 비교용). */
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

describe('replayEdits(D6 복구)', () => {
  it('새 문서에 로그를 다시 적용하면 같은 결과이고 저널은 적용 뒤에 켜진다', async () => {
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
    // 재적용 결과 = 원래 편집 결과(가짜 어댑터 기준 결정성 틀).
    expect(snapshot(fresh.s)).toEqual(expected);
    // 저널은 재적용이 끝난 뒤에 켜졌으므로 재적용 편집은 undo 단계가 아니다.
    expect(journal(fresh.s)).toEqual({ position: 0, steps: [] });
    expect((await fresh.s.undo()).edits).toBe(3);
    expect(snapshot(fresh.s)).toEqual(expected);

    // 이어서 새 편집은 평소처럼 undo 된다.
    await editParagraph(fresh.s, 0, 'After recovery');
    expect(text(fresh.s)).toContain('After recovery');
    const undone = await fresh.s.undo();
    expect(undone.activeEditIds).toEqual(liveIds);
    expect(snapshot(fresh.s)).toEqual(expected);
    live.s.close();
    fresh.s.close();
  });

  it('같은 로그를 두 번 재적용해도 같은 바이트(결정성)', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const a = harness();
    const b = harness();
    await a.s.replayEdits(structuredClone(ops));
    await b.s.replayEdits(structuredClone(ops));
    expect(snapshot(a.s)).toEqual(snapshot(b.s));
    for (const x of [live, a, b]) x.s.close();
  });

  it('재적용 뒤 저장하면 편집이 파일에 있고 Info 기록이 붙는다', async () => {
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

  it('빈 로그 재적용은 저널만 켠다', async () => {
    const { s } = harness();
    const history = await s.replayEdits([]);
    expect(history).toMatchObject({ edits: 0, canUndo: false, activeEditIds: [] });
    await editParagraph(s, 1, 'Fresh');
    expect(await s.undo()).toMatchObject({ edits: 0, canRedo: true });
    s.close();
  });

  it('판정 RPC 뒤에는 허용하고(저널이 아직 꺼져 있음), 편집을 시작한 세션에서는 거절한다', async () => {
    const live = harness();
    const ops = await recordOps(live);
    const { s } = harness();
    await s.getPageEditability(0); // 복구 중 마우스 오버 판정이 먼저 불려도 된다
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

  it('대상 문단을 찾지 못하면 실패 위치를 알리고 이후 편집 RPC 를 막는다', async () => {
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

describe('세션을 다시 열었을 때', () => {
  it('저장한 파일의 편집 블록은 로그 없이도 목록에 나오고 영역은 BBox 로 어림한다', async () => {
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
