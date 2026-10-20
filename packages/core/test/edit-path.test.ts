/**
 * M4 패스 편집 엔진 시험(docs/m4-contract.md 4.4, docs/m4-core.md). 가짜 어댑터(한 줄 = 패스 하나)로 core 의 저널·로그·
 * revision·재적용·경고·저장 로직을 검증한다. pdf-ops 패스 쓰기의 정확성은 검증하지 않는다.
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

/** 쪽 콘텐츠 스트림 바이트(문서 현재 상태). */
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

describe('판정', () => {
  it('getPageEditability 가 어댑터의 패스 판정을 paths 에 싣는다', async () => {
    const { s } = open();
    const e = await s.getPageEditability(0);
    expect(e.paths.map((p) => p.paintSeq)).toEqual(seqs(s));
    expect(e.paths.every((p) => p.editable)).toBe(true);
    s.close();
  });

  it('패스 판정 오류는 숨기지 않는다', async () => {
    const adapter = createFakeAdapter();
    adapter.planPathEditability = () => {
      throw new Error('판정 버그');
    };
    const { s } = open(adapter);
    await expect(s.getPageEditability(0)).rejects.toThrow('판정 버그');
    s.close();
  });

  it('planPathEdit 은 revision 과 대상 지문을 돌려주고 문서·저널을 바꾸지 않는다', async () => {
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

describe('초안·커밋·undo/redo', () => {
  it('시작 → 갱신 → 커밋: 스트림이 바뀌고 로그에 edit-path 가 남는다', async () => {
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

  it('변경 영역 = 직전 쓴 상자 ∪ 새 상자(+2pt), 첫 갱신의 직전 상자는 대상 상자', async () => {
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
    // 옮긴 뒤 상자는 x 가 100 만큼 이동
    expect(u1.bbox[0]).toBeCloseTo(tx0 + 100, 3);
    expect(u1.bbox[1]).toBeCloseTo(ty0, 3);
    const u2 = await s.updatePathDraft(started.draftId, move(0, 50), 1);
    // 두 번째 갱신 영역은 첫 갱신 상자(+100)와 새 상자(0,+50)를 모두 덮는다.
    const clip = u2.region.clip!;
    expect(clip[0]).toBeLessThanOrEqual(u1.bbox[0] + 1e-6);
    expect(clip[2]).toBeGreaterThanOrEqual(u1.bbox[2] - 1e-6);
    expect(clip[3]).toBeGreaterThanOrEqual(u2.bbox[3] - 1e-6);
    void tx1;
    void ty1;
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('갱신은 원본 기준 절대 편집이다(여러 번 갱신해도 커밋은 마지막 편집)', async () => {
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

  it('다중 선택은 한 편집 단위(저널 단계 1개)', async () => {
    const { s } = open();
    const { committed } = await pathEdit(s, seqs(s), { ...NO_EDIT, fill: [0, 0, 1] });
    expect((committed.op as EditPathOp).target.paintSeqs).toHaveLength(2);
    expect(journal(s).steps).toHaveLength(1);
    expect(pageContent(s).match(/0 0 1 rg/g)).toHaveLength(2);
    s.close();
  });

  it('삭제는 패스 줄을 n 으로 바꾼다', async () => {
    const { s } = open();
    await pathEdit(s, [seqs(s)[0]!], { ...NO_EDIT, delete: true });
    expect(pageContent(s)).toContain('\nn\n');
    s.close();
  });

  it('변경 없이 커밋하면 거절한다', async () => {
    const { s } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    const started = await s.beginPathEdit(0, [first!], plan.revision);
    await expect(s.commitPathEdit(started.draftId)).rejects.toThrow('적용된 변경이 없어');
    await s.cancelPathEdit(started.draftId);
    s.close();
  });

  it('낡은 revision 은 거절한다', async () => {
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

describe('초안 상태 규칙', () => {
  it('패스 초안과 문단 초안은 동시에 열 수 없고 RPC 짝이 맞아야 한다', async () => {
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

  it('취소는 문서를 원상태로 되돌리고, 변경 없이 취소하면 redo 를 되살린다', async () => {
    const { s } = open();
    const [first] = seqs(s);
    await pathEdit(s, [first!], { ...NO_EDIT, fill: [0, 1, 0] });
    await s.undo();
    const reference = pageContent(s);

    // 변경 없이 취소: MuPDF 에 redo 가 남으므로 core 의 redo 도 남는다.
    let plan = await s.planPathEdit(0, [first!]);
    let started = await s.beginPathEdit(0, [first!], plan.revision);
    expect((await s.getEditHistory()).canRedo).toBe(false);
    const cancelled = await s.cancelPathEdit(started.draftId);
    expect(cancelled.canRedo).toBe(true);
    expect(cancelled.canRedo).toBe(s.document.canRedo());

    // 쓴 뒤 취소: 문서는 원상태, redo 는 MuPDF 가 버렸으므로 core 도 비운다.
    plan = await s.planPathEdit(0, [first!]);
    started = await s.beginPathEdit(0, [first!], plan.revision);
    await s.updatePathDraft(started.draftId, move(30, 0), 1);
    const afterCancel = await s.cancelPathEdit(started.draftId);
    expect(pageContent(s)).toBe(reference);
    expect(afterCancel.canRedo).toBe(s.document.canRedo());
    expect(afterCancel.revision).toBe(cancelled.revision);
    s.close();
  });

  it('준비 실패는 초안을 남기지 않는다', async () => {
    const { s, adapter } = open();
    const [first] = seqs(s);
    const plan = await s.planPathEdit(0, [first!]);
    adapter.probe.failNextPath.prepare = true;
    await expect(s.beginPathEdit(0, [first!], plan.revision)).rejects.toThrow('preparePath');
    const retry = await s.beginPathEdit(0, [first!], plan.revision);
    await s.cancelPathEdit(retry.draftId);
    s.close();
  });

  it('쓰기가 중간에 실패해도 직전 편집으로 되돌리고 초안은 유지된다', async () => {
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

  it('되돌리기도 실패하면 초안은 취소만 된다', async () => {
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

describe('경고', () => {
  it('Gray 패스에 채도 있는 색을 쓰면 color-space-changed(core 근사)', async () => {
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

  it('쓰기 경고가 오면(빈 배열 포함) core 근사를 쓰지 않는다', async () => {
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

  it('pdf-ops 쓰기 결과의 warnings 를 초안 경고에 합친다', async () => {
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

describe('재적용', () => {
  async function session(): Promise<{ s: PdfSession; ops: EditOp[] }> {
    const { s } = open();
    const [a, b] = seqs(s);
    const ops: EditOp[] = [];
    ops.push((await pathEdit(s, [a!], { ...NO_EDIT, fill: [0, 1, 0] })).committed.op);
    ops.push((await editParagraph(s, 1, 'replayed paragraph text')).op);
    // 문단 편집 뒤 paintSeq 가 밀릴 수 있으나 모델 기준으로 다시 정한다.
    const seq = seqs(s);
    ops.push(
      (await pathEdit(s, [seq[seq.length === 2 ? 1 : seq.length - 1]!], move(15, 5))).committed.op,
    );
    void b;
    return { s, ops };
  }

  it('로그 순서대로 다시 적용하면 같은 콘텐츠가 되고 undo 할 수 없다', async () => {
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

  it('지문이 다르면 다른 패스를 고치지 않고 실패한다', async () => {
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
    // 일부만 적용된 문서는 이후 편집 RPC 를 막는다.
    await expect(fresh.getEditHistory()).rejects.toThrow('다시 열어야');
    expect(pageContent(fresh)).toBe(before);
    s.close();
    fresh.close();
  });
});

describe('저장·요약', () => {
  it('패스 편집만 있어도 요약에 쪽이 들고 변경 종류는 content-stream 이다', async () => {
    const { s } = open();
    await pathEdit(s, [seqs(s)[0]!], { ...NO_EDIT, fill: [0, 1, 0] });
    const plan = s.planSave({ changes: [] });
    expect(plan.edits?.pages).toEqual([0]);
    expect(plan.edits?.structureUnlinked).toBe(0);
    expect(plan.method).toBe('full');
    const saved = s.save({ changes: [] });
    expect(saved.bytes.length).toBeGreaterThan(0);
    // 감싼 저장은 저널 단계를 만들지 않는다.
    expect(journal(s).steps).toHaveLength(1);
    const info = s.document.getTrailer().get('Info').resolve();
    expect(info.get('PdfEditorEdits').asString()).toContain('pages=1');
    s.close();
  });

  it('패스 편집의 tagged-structure-unlinked 경고는 구조 끊김 수에 항목마다 센다', async () => {
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

describe('초안 입력 검증', () => {
  it('renderScale 이 0 이하면 RangeError', async () => {
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
