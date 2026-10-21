/**
 * 복구 기준점(계약 D4 사용자 결정 2026-10-21): 저장한 바이트를 기준점으로 열고 저장 뒤 편집만 재적용한다.
 * 실제 어댑터로 저장 → 편집 → 기준점 재적용 결과가 원래 세션과 같고, 저장 전 편집이 두 번 들어가지 않으며, 재적용 뒤
 * 되돌리기 이력·저널 추정이 새 세션처럼 동작하는지 본다. 나눠 적용(`more`)도 한 번에 적용한 결과와 같아야 한다.
 */
import { describe, expect, it } from 'vitest';
import type { DraftInput, EditOp, ParagraphEditPlan } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { FONT_BYTES, MEDIABOX, PAGE } from './edit-harness.js';
import { buildPdf } from './pdf-fixtures.js';

const source = (): Uint8Array => buildPdf([{ content: PAGE, mediabox: MEDIABOX }]);

function session(bytes: Uint8Array): PdfSession {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
}

const text = (s: PdfSession): string =>
  s
    .extractPage({ pageIndex: 0 })
    .chars.map((c) => c.text)
    .join('');

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

function input(plan: ParagraphEditPlan, value: string): DraftInput {
  return {
    runs: [{ text: value, style: plan.runs[0]!.style }],
    format: plan.format,
    composition: null,
    renderScale: 2,
  };
}

/** `startsWith` 로 시작하는 레이아웃 문단을 고친다(편집 블록이면 블록 전체가 대상). */
async function edit(s: PdfSession, startsWith: string, value: string): Promise<EditOp> {
  const paragraph = s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(startsWith));
  if (!paragraph) throw new Error(`문단 없음: ${startsWith}`);
  const plan = await s.planParagraphEdit(0, paragraph.id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, paragraph.id, plan.revision);
  await s.updateParagraphDraft(started.draftId, input(plan, value));
  return (await s.commitParagraphEdit(started.draftId)).op;
}

/** 저장 전 2건(한 건은 폴백 글자) → 저장 → 저장 뒤 2건(새 문단 1건, 저장 전 블록 재편집 1건). */
async function scenario() {
  const live = session(source());
  const before = [
    await edit(live, 'first paragraph', 'Saved edit one 한글.'),
    await edit(live, 'Second paragraph', 'Saved edit two.'),
  ];
  const savedIds = (await live.getEditHistory()).activeEditIds;
  const saved = live.save({ changes: [] }).bytes;
  const after = [
    await edit(live, 'Title Heading', 'Title after save'),
    await edit(live, 'Saved edit one', 'Saved edit one 한글 changed after save.'),
  ];
  return { live, before, after, saved, savedIds };
}

describe('복구 기준점(D4): 저장 바이트 + 저장 뒤 편집 재적용', () => {
  it('기준점 재적용 결과 = 원래 세션 = 원본 + 전체 로그 재적용, 저장 전 편집은 한 번만 있다', async () => {
    const { live, before, after, saved, savedIds } = await scenario();
    expect(savedIds).toEqual(before.map((o) => o.id));
    const expected = text(live);
    expect(count(expected.replace(/\s/gu, ''), 'Savededittwo.')).toBe(1);

    const fromBaseline = session(saved);
    const history = await fromBaseline.replayEdits(structuredClone(after));
    expect(text(fromBaseline)).toBe(expected);
    expect(count(text(fromBaseline).replace(/\s/gu, ''), 'Savededittwo.')).toBe(1);
    expect(count(text(fromBaseline).replace(/\s/gu, ''), 'changedaftersave.')).toBe(1);
    // 기준점 세션의 이력은 저장 뒤 편집만이고 되돌릴 수 없다(복구 전 되돌리기 이력은 사라진다).
    expect(history).toMatchObject({
      activeEditIds: after.map((o) => o.id),
      canUndo: false,
      canRedo: false,
      edits: 2,
    });

    const fromOriginal = session(source());
    await fromOriginal.replayEdits(structuredClone([...before, ...after]));
    expect(text(fromOriginal)).toBe(expected);
    for (const s of [live, fromBaseline, fromOriginal]) s.close();
  });

  it('기준점 재적용 뒤: 저널 추정 0 에서 시작하고 새 편집은 되돌릴 수 있으며 되돌리면 재적용 결과로 돌아온다', async () => {
    const { live, after, saved } = await scenario();
    const s = session(saved);
    await s.replayEdits(structuredClone(after));
    const replayed = text(s);
    expect(s.planSave({ changes: [] }).heap.journalBytes ?? 0).toBe(0);
    const advice = s.journalAdvice();
    expect(advice.advised).toBe(false);

    await edit(s, 'Saved edit two', 'Edit after recovery.');
    const h = await s.getEditHistory();
    expect(h.canUndo).toBe(true);
    expect(s.planSave({ changes: [] }).heap.journalBytes ?? 0).toBeGreaterThan(0);
    await s.undo();
    expect(text(s)).toBe(replayed);
    expect((await s.getEditHistory()).activeEditIds).toEqual(after.map((o) => o.id));
    // 재적용한 편집은 되돌릴 수 없다.
    expect((await s.undo()).activeEditIds).toEqual(after.map((o) => o.id));
    expect(text(s)).toBe(replayed);
    live.close();
    s.close();
  });

  it('저장 뒤 편집이 없으면 기준점만 열면 되고(재적용 0건) 저장 결과와 같다', async () => {
    const live = session(source());
    await edit(live, 'first paragraph', 'Only before save.');
    const saved = live.save({ changes: [] }).bytes;
    const expected = text(live);
    const s = session(saved);
    await s.replayEdits([]);
    expect(text(s)).toBe(expected);
    expect((await s.getEditHistory()).edits).toBe(0);
    live.close();
    s.close();
  });
});

describe('나눠 적용하는 재적용(D4 진행 표시)', () => {
  it('more 로 한 건씩 적용한 결과 = 한 번에 적용한 결과, 마지막 호출에서 저널이 켜진다', async () => {
    const { live, before, after } = await scenario();
    const ops = [...before, ...after];
    const whole = session(source());
    const wholeHistory = await whole.replayEdits(structuredClone(ops));

    const parts = session(source());
    for (const [i, op] of ops.entries()) {
      const h = await parts.replayEdits([structuredClone(op)], { more: i < ops.length - 1 });
      expect(h.edits).toBe(i + 1);
    }
    expect(text(parts)).toBe(text(whole));
    const partsHistory = await parts.getEditHistory();
    expect(partsHistory).toMatchObject({
      activeEditIds: wholeHistory.activeEditIds,
      canUndo: false,
      edits: ops.length,
    });
    expect(partsHistory.revision).toBe(wholeHistory.revision);
    // 저장 결과도 같다(메타 기록은 마지막 호출에서 한 번).
    const a = whole.save({ changes: [] }).bytes;
    const b = parts.save({ changes: [] }).bytes;
    expect(text(session(b))).toBe(text(session(a)));
    for (const s of [live, whole, parts]) s.close();
  });

  it('이어 받는 중에는 편집 시작을 거절하고, 마지막 호출 뒤에는 다시 재적용할 수 없다', async () => {
    const { live, before } = await scenario();
    const s = session(source());
    await s.replayEdits([structuredClone(before[0]!)], { more: true });
    const id = s.getPageLayout(0).paragraphs[0]!.id;
    await expect(s.beginParagraphEdit(0, id, (await s.getEditHistory()).revision)).rejects.toThrow(
      '재적용이 끝나지 않았습니다',
    );
    await s.replayEdits([structuredClone(before[1]!)]);
    await expect(s.replayEdits([])).rejects.toThrow('새로 연 문서에서만');
    live.close();
    s.close();
  });
});
