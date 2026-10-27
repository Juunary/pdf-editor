/**
 * Recovery checkpoint (contract D4 user decision 2026-10-21): open the saved bytes as the checkpoint and reapply only the edits made after saving.
 * Check that with the real adapter, save → edit → checkpoint reapply gives the same result as the original session, that edits made before saving are not applied twice, and that after reapply the
 * undo history and journal estimate behave like a new session. Split application (`more`) must also equal the result of applying all at once.
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

/** Edits the layout paragraph starting with `startsWith` (if it is an edit block, the whole block is the target). */
async function edit(s: PdfSession, startsWith: string, value: string): Promise<EditOp> {
  const paragraph = s.getPageLayout(0).paragraphs.find((p) => p.text.startsWith(startsWith));
  if (!paragraph) throw new Error(`문단 없음: ${startsWith}`);
  const plan = await s.planParagraphEdit(0, paragraph.id);
  expect(plan.editable, JSON.stringify(plan.limits)).toBe(true);
  const started = await s.beginParagraphEdit(0, paragraph.id, plan.revision);
  await s.updateParagraphDraft(started.draftId, input(plan, value));
  return (await s.commitParagraphEdit(started.draftId)).op;
}

/** 2 edits before save (one with fallback characters) → save → 2 edits after save (1 new paragraph, 1 re-edit of a pre-save block). */
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

describe('recovery checkpoint (D4): saved bytes + reapply of post-save edits', () => {
  it('checkpoint reapply result = original session = original + full log reapply, and pre-save edits appear only once', async () => {
    const { live, before, after, saved, savedIds } = await scenario();
    expect(savedIds).toEqual(before.map((o) => o.id));
    const expected = text(live);
    expect(count(expected.replace(/\s/gu, ''), 'Savededittwo.')).toBe(1);

    const fromBaseline = session(saved);
    const history = await fromBaseline.replayEdits(structuredClone(after));
    expect(text(fromBaseline)).toBe(expected);
    expect(count(text(fromBaseline).replace(/\s/gu, ''), 'Savededittwo.')).toBe(1);
    expect(count(text(fromBaseline).replace(/\s/gu, ''), 'changedaftersave.')).toBe(1);
    // The checkpoint session's history contains only post-save edits and cannot be undone (the pre-recovery undo history is gone).
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

  it('after checkpoint reapply: the journal estimate starts at 0, new edits can be undone, and undoing returns to the reapply result', async () => {
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
    // Reapplied edits cannot be undone.
    expect((await s.undo()).activeEditIds).toEqual(after.map((o) => o.id));
    expect(text(s)).toBe(replayed);
    live.close();
    s.close();
  });

  it('with no post-save edits, opening only the checkpoint is enough (0 reapplies) and equals the save result', async () => {
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

describe('split reapply (D4 progress display)', () => {
  it('result of applying one at a time with more = result of applying all at once, and the journal is enabled on the last call', async () => {
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
    // The save result is also the same (the metadata record is written once, on the last call).
    const a = whole.save({ changes: [] }).bytes;
    const b = parts.save({ changes: [] }).bytes;
    expect(text(session(b))).toBe(text(session(a)));
    for (const s of [live, whole, parts]) s.close();
  });

  it('rejects starting an edit while a continuation is in progress, and cannot reapply again after the last call', async () => {
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
