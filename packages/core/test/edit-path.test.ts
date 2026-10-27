/**
 * M4 path edit engine tests (docs/m4-contract.md 4.4, docs/m4-core.md). Verifies the journal, log,
 * revision, reapply, warning and save logic of core with a fake adapter (one line = one path). The correctness of pdf-ops path writing is not verified.
 */
import { describe, expect, it } from 'vitest';
import type { EditPathOp, EditOp, PathEdit } from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { EditStateError, StaleRevisionError } from '../src/edit-engine.js';
import { createFakeAdapter, type FakeAdapter } from './fake-edit-adapter.js';
import { buildPdf } from './pdf-fixtures.js';
import {
  FONT_BYTES,
  MEDIABOX,
  PAGE,
  begin,
  draftInput,
  editParagraph,
  journal,
} from './edit-harness.js';

const PATH_PAGE = [PAGE, '0.5 g', '100 300 80 40 re f', '1 0 0 rg', '300 300 60 30 re f'].join(
  '\n',
);

const NO_EDIT: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};
const move = (dx: number, dy: number): PathEdit => ({
  ...NO_EDIT,
  transform: [1, 0, 0, 1, dx, dy],
});

function open(adapter: FakeAdapter = createFakeAdapter()): { s: PdfSession; adapter: FakeAdapter } {
  let n = 0;
  const s = new PdfSession({
    editAdapter: adapter,
    loadFallbackFont: async () => FONT_BYTES,
    createId: () => `id-${++n}`,
  });
  s.open(buildPdf([{ content: PATH_PAGE, mediabox: MEDIABOX }]));
  return { s, adapter };
}

const seqs = (s: PdfSession): number[] =>
  s.extractPage({ pageIndex: 0 }).paths.map((p) => p.paintSeq);

/** Page content stream bytes (current document state). */
function pageContent(s: PdfSession): string {
  const page = s.document.loadPage(0);
  try {
    const contents = page.getObject().get('Contents');
    const buf = contents.readStream();
    try {
      return buf.asString();
    } finally {
      buf.destroy();
    }
  } finally {
    page.destroy();
  }
}

async function pathEdit(s: PdfSession, paintSeqs: number[], edit: PathEdit) {
  const plan = await s.planPathEdit(0, paintSeqs);
  const started = await s.beginPathEdit(0, paintSeqs, plan.revision);
  const update = await s.updatePathDraft(started.draftId, edit, 2);
  const committed = await s.commitPathEdit(started.draftId);
  return { plan, started, update, committed };
}

describe('classification', () => {
  it('getPageEditability puts the path classification of the adapter into paths', async () => {
    const { s } = open();
    const e = await s.getPageEditability(0);
    expect(e.paths.map((p) => p.paintSeq)).toEqual(seqs(s));
    expect(e.paths.every((p) => p.editable)).toBe(true);
    s.close();
  });

  it('a path classification error empties only the paths and still returns the paragraph classification (pathError diagnostic, review M4)', async () => {
    const normal = open();
    const expected = (await normal.s.getPageEditability(0)).paragraphs;
    normal.s.close();
    expect(expected.length).toBeGreaterThan(0);
    const adapter = createFakeAdapter();
    adapter.planPathEditability = () => {
      throw new Error('판정 버그');
    };
    const { s } = open(adapter);
    const e = await s.getPageEditability(0);
    expect(e.paths).toEqual([]);
    expect(e.pathError).toBe('판정 버그');
    expect(e.paragraphs).toEqual(expected);
    // Paragraph editing remains usable.
    const plan = await s.planParagraphEdit(0, expected[0]!.paragraphId);
    expect(plan.revision).toBe(0);
    s.close();
  });

  it('a normal classification has no pathError', async () => {
    const { s } = open();
    expect((await s.getPageEditability(0)).pathError).toBeUndefined();
    s.close();
  });

  it('planPathEdit returns the revision and the target fingerprint and does not change the document or journal', async () => {
    const { s } = open();
    const before = pageContent(s);
    const plan = await s.planPathEdit(0, [seqs(s)[0]!]);
    expect(plan.revision).toBe(0);
    expect(plan.editable).toBe(true);
    expect(plan.target.fingerprints).toHaveLength(1);
    expect(pageContent(s)).toBe(before);
    expect(journal(s)).toEqual({ position: 0, steps: [] });
    s.close();
  });
});

describe('draft, commit, undo/redo', () => {
  it('begin → update → commit: the stream changes and edit-path is left in the log', async () => {
    const { s } = open();
    const before = pageContent(s);
    const [first] = seqs(s);
    const { committed, update } = await pathEdit(s, [first!], { ...NO_EDIT, fill: [0, 1, 0] });
    expect(committed.op.kind).toBe('edit-path');
    expect(committed.history.activeEditIds).toEqual([committed.op.id]);
    expect(committed.history.revision).toBe(1);
    expect(committed.history.canUndo).toBe(true);
    expect(update.region.rgba.length).toBeGreaterThan(0);
    const after = pageContent(s);
    expect(after).not.toBe(before);
    expect(after).toContain('0 1 0 rg');
    expect(journal(s).steps).toHaveLength(1);

    const undone = await s.undo();
    expect(undone.affectedPages).toEqual([0]);
    expect(pageContent(s)).toBe(before);
    expect(undone.canRedo).toBe(true);
    await s.redo();
    expect(pageContent(s)).toBe(after);
    s.close();
  });

  it('changed area = previously written box ∪ new box (+2pt), and the previous box of the first update is the target box', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    const u1 = await s.updatePathDraft(started.draftId, move(100, 0), 1);
    const [tx0, ty0, tx1, ty1] = plan.target.bbox;
    expect(u1.region.clip).toEqual([
      expect.closeTo(Math.floor(tx0 - 2), 0),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    // The box after moving is shifted by 100 in x
    expect(u1.bbox[0]).toBeCloseTo(tx0 + 100, 3);
    expect(u1.bbox[1]).toBeCloseTo(ty0, 3);
    const u2 = await s.updatePathDraft(started.draftId, move(0, 50), 1);
    // The second update area covers both the first update box (+100) and the new box (0,+50).
    const clip = u2.region.clip!;
    expect(clip[0]).toBeLessThanOrEqual(u1.bbox[0] + 1e-6);
    expect(clip[2]).toBeGreaterThanOrEqual(u1.bbox[2] - 1e-6);
    expect(clip[3]).toBeGreaterThanOrEqual(u2.bbox[3] - 1e-6);
    void tx1;
    void ty1;
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('an update is an absolute edit relative to the original (even after several updates, the commit is the last edit)', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    await s.updatePathDraft(started.draftId, move(10, 0), 1);
    await s.updatePathDraft(started.draftId, move(20, 0), 1);
    const committed = await s.commitPathEdit(started.draftId);
    expect((committed.op as EditPathOp).edit.transform).toEqual([1, 0, 0, 1, 20, 0]);
    expect(pageContent(s)).toContain('120 300 80 40 re f');
    expect(journal(s).steps).toHaveLength(1);
    s.close();
  });

  it('a multi-selection is one edit unit (1 journal step)', async () => {
    const { s } = open();
    const { committed } = await pathEdit(s, seqs(s), { ...NO_EDIT, fill: [0, 0, 1] });
    expect((committed.op as EditPathOp).target.paintSeqs).toHaveLength(2);
    expect(journal(s).steps).toHaveLength(1);
    expect(pageContent(s).match(/0 0 1 rg/g)).toHaveLength(2);
    s.close();
  });

  it('delete replaces the path line with n', async () => {
    const { s } = open();
    await pathEdit(s, [seqs(s)[0]!], { ...NO_EDIT, delete: true });
    expect(pageContent(s)).toContain('\nn\n');
    s.close();
  });

  it('rejects a commit without changes', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    await expect(s.commitPathEdit(started.draftId)).rejects.toThrow('적용된 변경이 없어');
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('rejects a stale revision', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    await editParagraph(s, 1, 'changed text');
    await expect(s.beginPathEdit(0, [first!], plan.revision)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
    s.close();
  });
});

describe('draft state rules', () => {
  it('a path draft and a paragraph draft cannot be open at the same time, and the RPC pair must match', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    const pplan = await s.planParagraphEdit(0, 1).catch((e: unknown) => e);
    expect(pplan).toBeInstanceOf(EditStateError);
    await expect(s.beginPathEdit(0, [first!], plan.revision)).rejects.toBeInstanceOf(
      EditStateError,
    );
    await expect(s.commitParagraphEdit(started.draftId)).rejects.toThrow('패스 초안');
    await expect(s.undo()).rejects.toBeInstanceOf(EditStateError);
    await expect(s.planPathEdit(0, [first!])).rejects.toBeInstanceOf(EditStateError);
    await s.cancelPathEdit(started.draftId);

    const { plan: paragraphPlan, started: pstarted } = await begin(s, 1);
    await expect(s.commitPathEdit(pstarted.draftId)).rejects.toThrow('문단 초안');
    await expect(s.beginPathEdit(0, [first!], paragraphPlan.revision)).rejects.toBeInstanceOf(
      EditStateError,
    );
    await s.cancelParagraphEdit(pstarted.draftId);
    s.close();
  });

  it('cancel restores the document, and cancelling without changes revives redo', async () => {
    const { s } = open();
    const [first] = seqs(s);
    await pathEdit(s, [first!], { ...NO_EDIT, fill: [0, 1, 0] });
    await s.undo();
    const reference = pageContent(s);

    // Cancel without changes: MuPDF keeps redo, so core keeps redo too.
    let plan = await s.planPathEdit(0, [first!]);
    let started = await s.beginPathEdit(0, [first!], plan.revision);
    expect((await s.getEditHistory()).canRedo).toBe(false);
    const cancelled = await s.cancelPathEdit(started.draftId);
    expect(cancelled.canRedo).toBe(true);
    expect(cancelled.canRedo).toBe(s.document.canRedo());

    // Cancel after writing: the document is restored, and since MuPDF discarded redo, core clears it too.
    plan = await s.planPathEdit(0, [first!]);
    started = await s.beginPathEdit(0, [first!], plan.revision);
    await s.updatePathDraft(started.draftId, move(30, 0), 1);
    const afterCancel = await s.cancelPathEdit(started.draftId);
    expect(pageContent(s)).toBe(reference);
    expect(afterCancel.canRedo).toBe(s.document.canRedo());
    expect(afterCancel.revision).toBe(cancelled.revision);
    s.close();
  });

  it('a preparation failure leaves no draft', async () => {
    const { s, adapter } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    adapter.probe.failNextPath.prepare = true;
    await expect(s.beginPathEdit(0, [first!], plan.revision)).rejects.toThrow('preparePath');
    const retry = await s.beginPathEdit(0, [first!], plan.revision);
    await s.cancelPathEdit(retry.draftId);
    s.close();
  });

  it('even if writing fails midway, it rolls back to the previous edit and the draft is kept', async () => {
    const { s, adapter } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    await s.updatePathDraft(started.draftId, move(10, 0), 1);
    const good = pageContent(s);
    adapter.probe.failNextPath.writeAfter = true;
    await expect(s.updatePathDraft(started.draftId, move(99, 0), 1)).rejects.toThrow('쓴 뒤');
    expect(pageContent(s)).toBe(good);
    const committed = await s.commitPathEdit(started.draftId);
    expect((committed.op as EditPathOp).edit.transform).toEqual([1, 0, 0, 1, 10, 0]);
    s.close();
  });

  it('if the rollback also fails, the draft can only be cancelled', async () => {
    const { s, adapter } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    let calls = 0;
    const original = adapter.writePathEdit;
    adapter.writePathEdit = (...args) => {
      calls++;
      if (calls >= 1) throw new Error('쓰기 불가');
      return original(...args);
    };
    await expect(s.updatePathDraft(started.draftId, move(1, 0), 1)).rejects.toThrow('쓰기 불가');
    adapter.writePathEdit = original;
    await expect(s.updatePathDraft(started.draftId, move(1, 0), 1)).rejects.toThrow('손상');
    await expect(s.commitPathEdit(started.draftId)).rejects.toThrow('손상');
    await s.cancelPathEdit(started.draftId);
    expect(journal(s).steps).toHaveLength(0);
    s.close();
  });
});

describe('warnings', () => {
  it('using a saturated color on a Gray path gives color-space-changed (core approximation)', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    const u = await s.updatePathDraft(started.draftId, { ...NO_EDIT, fill: [1, 0, 0] }, 1);
    expect(u.warnings.map((w) => w.kind)).toContain('color-space-changed');
    const same = await s.updatePathDraft(started.draftId, { ...NO_EDIT, fill: [0.5, 0.5, 0.5] }, 1);
    expect(same.warnings.map((w) => w.kind)).not.toContain('color-space-changed');
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('when write warnings arrive (including an empty array), the core approximation is not used', async () => {
    const { s, adapter } = open();
    adapter.probe.pathWriteWarnings = [];
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    const u = await s.updatePathDraft(started.draftId, { ...NO_EDIT, fill: [1, 0, 0] }, 1);
    expect(u.warnings.map((w) => w.kind)).not.toContain('color-space-changed');
    adapter.probe.pathWriteWarnings = [
      { kind: 'color-space-changed', message: 'a', rects: [[0, 0, 1, 1]] },
    ];
    const v = await s.updatePathDraft(started.draftId, { ...NO_EDIT, fill: [1, 0, 0] }, 1);
    const kinds = v.warnings.map((w) => w.kind);
    expect(kinds.filter((k) => k === 'color-space-changed')).toHaveLength(1);
    expect(v.warnings.find((w) => w.kind === 'color-space-changed')!.rects).toHaveLength(1);
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('merges the warnings of the pdf-ops write result into the draft warnings', async () => {
    const { s, adapter } = open();
    adapter.probe.pathWriteWarnings = [{ kind: 'path-clipped', message: '클립 밖', rects: [] }];
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    const u = await s.updatePathDraft(started.draftId, move(5, 0), 1);
    expect(u.warnings.map((w) => w.kind)).toContain('path-clipped');
    const committed = await s.commitPathEdit(started.draftId);
    expect(committed.op.kind).toBe('edit-path');
    s.close();
  });
});

describe('reapply', () => {
  async function session(): Promise<{ s: PdfSession; ops: EditOp[] }> {
    const { s } = open();
    const [a, b] = seqs(s);
    const ops: EditOp[] = [];
    ops.push((await pathEdit(s, [a!], { ...NO_EDIT, fill: [0, 1, 0] })).committed.op);
    ops.push((await editParagraph(s, 1, 'replayed paragraph text')).op);
    // paintSeq may shift after a paragraph edit, but it is re-determined from the model.
    const seq = seqs(s);
    ops.push(
      (await pathEdit(s, [seq[seq.length === 2 ? 1 : seq.length - 1]!], move(15, 5))).committed.op,
    );
    void b;
    return { s, ops };
  }

  it('reapplying in log order gives the same content and cannot be undone', async () => {
    const { s, ops } = await session();
    const expected = pageContent(s);
    const { s: fresh } = open();
    const state = await fresh.replayEdits(ops);
    expect(state.activeEditIds).toEqual(ops.map((o) => o.id));
    expect(state.canUndo).toBe(false);
    expect(pageContent(fresh)).toBe(expected);
    const again = open().s;
    await again.replayEdits(ops);
    expect(pageContent(again)).toBe(pageContent(fresh));
    s.close();
    fresh.close();
    again.close();
  });

  it('when the fingerprint differs, it fails without editing a different path', async () => {
    const { s, ops } = await session();
    const tampered = ops.map((op) =>
      op.kind === 'edit-path'
        ? {
            ...op,
            target: {
              ...op.target,
              fingerprints: op.target.fingerprints.map((f) => ({ ...f, constructHash: 'x' })),
            },
          }
        : op,
    );
    const { s: fresh } = open();
    const before = pageContent(fresh);
    await expect(fresh.replayEdits(tampered)).rejects.toThrow(
      /재적용 실패\(1\/3번째.*지문|구성 연산 해시/,
    );
    // A partially applied document blocks later edit RPCs.
    await expect(fresh.getEditHistory()).rejects.toThrow('다시 열어야');
    expect(pageContent(fresh)).toBe(before);
    s.close();
    fresh.close();
  });
});

describe('save and summary', () => {
  it('even with path edits only, the page is in the summary and the change kind is content-stream', async () => {
    const { s } = open();
    await pathEdit(s, [seqs(s)[0]!], { ...NO_EDIT, fill: [0, 1, 0] });
    const plan = s.planSave({ changes: [] });
    expect(plan.edits?.pages).toEqual([0]);
    expect(plan.edits?.structureUnlinked).toBe(0);
    expect(plan.method).toBe('full');
    const saved = s.save({ changes: [] });
    expect(saved.bytes.length).toBeGreaterThan(0);
    // A wrapped save creates no journal step.
    expect(journal(s).steps).toHaveLength(1);
    const info = s.document.getTrailer().get('Info').resolve();
    expect(info.get('PdfEditorEdits').asString()).toContain('pages=1');
    s.close();
  });

  it('the tagged-structure-unlinked warning of a path edit counts each item in the structure break count', async () => {
    const { s, adapter } = open();
    adapter.probe.pathWriteWarnings = [
      { kind: 'tagged-structure-unlinked', message: '구조 끊김', rects: [] },
    ];
    await pathEdit(s, [seqs(s)[0]!], move(1, 0));
    await pathEdit(s, [seqs(s)[1]!], move(1, 0));
    expect(s.planSave({ changes: [] }).edits?.structureUnlinked).toBe(2);
    await s.undo();
    expect(s.planSave({ changes: [] }).edits?.structureUnlinked).toBe(1);
    s.close();
  });
});

describe('draft input validation', () => {
  it('RangeError when renderScale is 0 or less', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    await expect(s.updatePathDraft(started.draftId, move(1, 0), 0)).rejects.toBeInstanceOf(
      RangeError,
    );
    await s.cancelPathEdit(started.draftId);
    void draftInput;
    s.close();
  });
});

describe('R-L3 release wiring', () => {
  it('discards the pdf-ops draft state when a draft ends (commit, cancel) and after reapply, and releases the FontManager on close', async () => {
    const { s, adapter } = open();
    const [first, second] = seqs(s);
    const ops: EditOp[] = [(await pathEdit(s, [first!], move(1, 0))).committed.op];
    expect(adapter.probe.releaseCalls).toBe(1);
    const plan = await s.planPathEdit(0, [second!]);
    const started = await s.beginPathEdit(0, [second!], plan.revision);
    await s.cancelPathEdit(started.draftId);
    expect(adapter.probe.releaseCalls).toBe(2);
    ops.push((await editParagraph(s, 0, 'Hello')).op);
    expect(adapter.probe.releaseCalls).toBe(3);
    expect(adapter.probe.fontDisposeCalls).toBe(0);
    s.close();
    expect(adapter.probe.fontDisposeCalls).toBe(1);
    expect(adapter.probe.releaseCalls).toBe(4);
    s.close();
    expect(adapter.probe.fontDisposeCalls).toBe(1);

    const replayAdapter = createFakeAdapter();
    const r = new PdfSession({
      editAdapter: replayAdapter,
      loadFallbackFont: async () => FONT_BYTES,
    });
    r.open(buildPdf([{ content: PATH_PAGE, mediabox: MEDIABOX }]));
    await r.replayEdits(ops);
    expect(replayAdapter.probe.releaseCalls).toBe(ops.length);
    r.close();
  });
});
