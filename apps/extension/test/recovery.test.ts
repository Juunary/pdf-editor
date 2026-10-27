import { describe, expect, it, vi } from 'vitest';
import type { EditHistoryState, EditOp, PdfWorkerApi } from '@pdf-editor/shared-types';
import { classifyFailure } from '@pdf-editor/viewer-ui';
import {
  ResilientPdf,
  WorkerRecoveredError,
  isFatalWorkerError,
  opsAfterBaseline,
  type RecoveryInfo,
  type WorkerHandle,
} from '../src/viewer/recovery.js';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const history = (ids: string[]): EditHistoryState => ({
  revision: 1,
  activeEditIds: ids,
  canUndo: ids.length > 0,
  canRedo: false,
  edits: ids.length,
  affectedPages: [],
});

const op = (id: string): EditOp =>
  ({ kind: 'replace-paragraph', id, target: {}, runs: [], format: {} }) as unknown as EditOp;

function fatal(message = 'memory access out of bounds'): Error {
  const e = new Error(message);
  e.name = 'RuntimeError';
  return e;
}

type FakeApi = Record<string, ReturnType<typeof vi.fn>>;

interface FakeWorker {
  handle: WorkerHandle;
  api: FakeApi;
  terminated: () => boolean;
  crash(reason?: string): void;
}

function fakeWorker(overrides: FakeApi = {}): FakeWorker {
  let crash!: (e: Error) => void;
  const dead = new Promise<never>((_, reject) => (crash = reject));
  dead.catch(() => {});
  let terminated = false;
  const api: FakeApi = {
    open: vi.fn(async () => ({ pageCount: 3 })),
    getPageInfo: vi.fn(async (i: number) => ({ pageIndex: i })),
    renderPage: vi.fn(async () => ({ ok: true })),
    save: vi.fn(async () => ({ bytes: new Uint8Array(1) })),
    getEditHistory: vi.fn(async () => history([])),
    replayEdits: vi.fn(async () => history([])),
    beginParagraphEdit: vi.fn(async () => ({ draftId: 'd1' })),
    updateParagraphDraft: vi.fn(async () => ({ ok: 1 })),
    commitParagraphEdit: vi.fn(async () => ({ op: op('a'), history: history(['a']) })),
    cancelParagraphEdit: vi.fn(async () => history([])),
    ...overrides,
  };
  return {
    handle: {
      api: api as unknown as PdfWorkerApi,
      dead,
      terminate: () => {
        terminated = true;
      },
    },
    api,
    terminated: () => terminated,
    crash: (reason = 'Worker 오류') => {
      const e = new Error(reason);
      e.name = 'WorkerCrash';
      crash(e);
    },
  };
}

function setup(workers: FakeWorker[], log: EditOp[] = []) {
  let next = 0;
  const infos: RecoveryInfo[] = [];
  const events: string[] = [];
  const pdf = new ResilientPdf({
    spawn: () => workers[next++]!.handle,
    transfer: (b) => b,
    editLog: () => ({ ops: log, activeEditIds: log.map((o) => o.id) }),
    onRecovered: (info) => {
      infos.push(info);
    },
    log: (event) => events.push(event),
  });
  return { pdf, infos, events, spawned: () => next };
}

const bytes = () => new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;

describe('isFatalWorkerError', () => {
  it('wasm trap, out of memory and Worker script errors are fatal; document errors are not', () => {
    expect(isFatalWorkerError(fatal())).toBe(true);
    expect(isFatalWorkerError(new Error('abort(OOM). Build with -sASSERTIONS'))).toBe(true);
    expect(
      isFatalWorkerError(new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded')),
    ).toBe(true);
    const crash = new Error('x');
    crash.name = 'WorkerCrash';
    expect(isFatalWorkerError(crash)).toBe(true);
    expect(isFatalWorkerError(new Error('cannot find object in xref (5 0 R)'))).toBe(false);
    expect(isFatalWorkerError(new Error('M3 미구현: core.getPageEditability'))).toBe(false);
    expect(isFatalWorkerError('문자열')).toBe(false);
  });

  it('WorkerRecoveredError is classified as recovered by the viewer UI', () => {
    const e = new WorkerRecoveredError('복구', 2);
    expect(classifyFailure(e).kind).toBe('recovered');
  });
});

describe('ResilientPdf', () => {
  it('normal calls pass through as is and regular errors do not trigger recovery', async () => {
    const w1 = fakeWorker({
      getPageInfo: vi.fn(async () => {
        throw new Error('page out of range');
      }),
    });
    const { pdf, spawned } = setup([w1]);
    await pdf.open(bytes());
    await expect(pdf.getPageInfo(9)).rejects.toThrow('page out of range');
    expect(spawned()).toBe(1);
    expect(pdf.recoveryCount).toBe(0);
  });

  it('open keeps the original as a Blob and then passes it by transfer', async () => {
    const w1 = fakeWorker();
    const transfer = vi.fn((b: ArrayBuffer) => b);
    const pdf = new ResilientPdf({
      spawn: () => w1.handle,
      transfer,
      editLog: () => ({ ops: [], activeEditIds: [] }),
      onRecovered: () => {},
      log: () => {},
    });
    await pdf.open(bytes());
    expect(transfer).toHaveBeenCalledTimes(1);
    expect(w1.api.open).toHaveBeenCalledTimes(1);
  });

  it('if a read call hits a fatal error: open the original in a new Worker → reapply the log → retry the same call', async () => {
    const log = [op('a'), op('b')];
    const w1 = fakeWorker({
      renderPage: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker({ getEditHistory: vi.fn(async () => history(['a', 'b'])) });
    const { pdf, infos, spawned } = setup([w1, w2], log);
    await pdf.open(bytes());
    const out = await pdf.renderPage({ pageIndex: 0, scale: 1 });
    expect(out).toEqual({ ok: true });
    expect(w1.terminated()).toBe(true);
    expect(spawned()).toBe(2);
    expect(w2.api.open).toHaveBeenCalledTimes(1);
    // Send one at a time (progress display) and turn on the journal on the last call (more: false).
    expect(w2.api.replayEdits!.mock.calls).toEqual([
      [[log[0]], { more: true }],
      [[log[1]], { more: false }],
    ]);
    // open comes before replayEdits
    expect(w2.api.open!.mock.invocationCallOrder[0]!).toBeLessThan(
      w2.api.replayEdits!.mock.invocationCallOrder[0]!,
    );
    await flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ replayedEdits: 2, recoveries: 1 });
    expect(infos[0]!.history?.activeEditIds).toEqual(['a', 'b']);
  });

  describe('recovery checkpoint (D4 user decision 2026-10-21)', () => {
    const crashOnRender = () =>
      fakeWorker({
        renderPage: vi.fn(async () => {
          throw fatal();
        }),
        save: vi.fn(async () => ({ bytes: new Uint8Array([9, 9]) })),
      });
    const openedBytes = (w: FakeWorker) =>
      [...new Uint8Array(w.api.open!.mock.calls[0]![0] as ArrayBuffer)] as number[];

    it('when a user save succeeds, recovery opens the saved bytes, reapplies only the edits after the save, and reports progress', async () => {
      const log = [op('a'), op('b')];
      const w1 = crashOnRender();
      const w2 = fakeWorker();
      let next = 0;
      const workers = [w1, w2];
      const progress: string[] = [];
      const infos: RecoveryInfo[] = [];
      const pdf = new ResilientPdf({
        spawn: () => workers[next++]!.handle,
        transfer: (b) => b,
        editLog: () => ({ ops: log, activeEditIds: log.map((o) => o.id) }),
        onRecovered: (info) => {
          infos.push(info);
        },
        onProgress: (done, total) => progress.push(`${done}/${total}`),
        log: () => {},
      });
      await pdf.open(bytes());
      await pdf.save({ changes: [] });
      pdf.confirmSaved();
      expect(pdf.baselineEditIds).toEqual(['a', 'b']);
      log.push(op('c'));
      await pdf.renderPage({ pageIndex: 0, scale: 1 });
      expect(openedBytes(w2)).toEqual([9, 9]);
      expect(w2.api.replayEdits!.mock.calls).toEqual([[[log[2]], { more: false }]]);
      expect(progress).toEqual(['0/1', '1/1']);
      await new Promise((r) => setTimeout(r, 5));
      expect(infos[0]).toMatchObject({ replayedEdits: 1, fromSavedBaseline: true });
      // After recovering from the checkpoint, the checkpoint is the original (the confirmed checkpoint is cleared).
      expect(pdf.baselineEditIds).toBeNull();
    });

    it('recovering again right after a checkpoint recovery, before the viewer log changes, does not apply the checkpoint edits twice', async () => {
      const log = [op('a'), op('b')];
      const w1 = crashOnRender();
      const w2 = crashOnRender();
      const w3 = fakeWorker();
      const { pdf } = setup([w1, w2, w3], log);
      await pdf.open(bytes());
      await pdf.save({ changes: [] });
      pdf.confirmSaved(); // checkpoint = active [a, b] at save time
      log.push(op('c'));
      // w1 fails → w2 recovers with checkpoint + [c], the retry also fails on w2 → recovers to w3 (retry is only once, so it is reported as an error).
      await expect(pdf.renderPage({ pageIndex: 0, scale: 1 })).rejects.toBeInstanceOf(
        WorkerRecoveredError,
      );
      expect(openedBytes(w2)).toEqual([9, 9]);
      expect(w2.api.replayEdits!.mock.calls.map((c) => (c[0] as EditOp[])[0]!.id)).toEqual(['c']);
      // The log is still [a, b, c]: w3 must reapply only c on top of the checkpoint bytes (now the original).
      expect(openedBytes(w3)).toEqual([9, 9]);
      expect(w3.api.replayEdits!.mock.calls.map((c) => (c[0] as EditOp[])[0]!.id)).toEqual(['c']);
    });

    it('if the save result is not confirmed (cancel, failure, measurement save), the whole log is reapplied from the original', async () => {
      const log = [op('a')];
      const w1 = crashOnRender();
      const w2 = fakeWorker();
      const { pdf, infos } = setup([w1, w2], log);
      await pdf.open(bytes());
      await pdf.save({ changes: [] });
      pdf.discardPendingSave();
      pdf.confirmSaved(); // no candidate to confirm
      expect(pdf.baselineEditIds).toBeNull();
      await pdf.renderPage({ pageIndex: 0, scale: 1 });
      expect(openedBytes(w2)).toEqual([1, 2, 3, 4]);
      expect(w2.api.replayEdits!.mock.calls).toEqual([[[log[0]], { more: false }]]);
      await new Promise((r) => setTimeout(r, 5));
      expect(infos[0]).toMatchObject({ replayedEdits: 1, fromSavedBaseline: false });
    });

    it('if edits made before the save were undone and the active log does not start with the checkpoint, the original + the whole active log', async () => {
      const log = [op('a'), op('b')];
      const w1 = crashOnRender();
      const w2 = fakeWorker();
      const { pdf } = setup([w1, w2], log);
      await pdf.open(bytes());
      await pdf.save({ changes: [] });
      pdf.confirmSaved();
      log.splice(1, 1, op('x')); // undo b and newly commit x
      await pdf.renderPage({ pageIndex: 0, scale: 1 });
      expect(openedBytes(w2)).toEqual([1, 2, 3, 4]);
      expect(w2.api.replayEdits!.mock.calls.map((c) => (c[0] as EditOp[])[0]!.id)).toEqual([
        'a',
        'x',
      ]);
    });

    it('opening another document discards the checkpoint', async () => {
      const w1 = fakeWorker({ save: vi.fn(async () => ({ bytes: new Uint8Array([9]) })) });
      const { pdf } = setup([w1], [op('a')]);
      await pdf.open(bytes());
      await pdf.save({ changes: [] });
      pdf.confirmSaved();
      expect(pdf.baselineEditIds).toEqual(['a']);
      await pdf.open(bytes());
      expect(pdf.baselineEditIds).toBeNull();
    });

    it('opsAfterBaseline: the later edits only on a prefix match, otherwise null', () => {
      const snap = { ops: [op('a'), op('b'), op('c')], activeEditIds: ['a', 'b', 'c'] };
      expect(opsAfterBaseline(snap, ['a', 'b'])!.map((o) => o.id)).toEqual(['c']);
      expect(opsAfterBaseline(snap, [])!.map((o) => o.id)).toEqual(['a', 'b', 'c']);
      expect(opsAfterBaseline(snap, ['a', 'b', 'c'])).toEqual([]);
      expect(opsAfterBaseline(snap, ['b'])).toBeNull();
      expect(opsAfterBaseline(snap, ['a', 'b', 'c', 'd'])).toBeNull();
    });
  });

  it('journalAdvice (D4) is a read call, so it is asked again on the new Worker after recovery', async () => {
    const advice = { advised: true, journalBytes: 9, incrementBytes: 1, thresholdBytes: 5 };
    const w1 = fakeWorker({
      journalAdvice: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker({ journalAdvice: vi.fn(async () => advice) });
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    await expect(pdf.journalAdvice()).resolves.toEqual(advice);
    expect(w2.api.journalAdvice).toHaveBeenCalledTimes(1);
  });

  it('does not call replayEdits when the log is empty', async () => {
    const w1 = fakeWorker({
      renderPage: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    await pdf.renderPage({ pageIndex: 0, scale: 1 });
    expect(w2.api.replayEdits).not.toHaveBeenCalled();
  });

  it('write calls (save, etc.) are not retried after recovery and throw WorkerRecoveredError', async () => {
    const w1 = fakeWorker({
      save: vi.fn(async () => {
        throw fatal('abort(OOM)');
      }),
    });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    await expect(pdf.save({ changes: [] })).rejects.toBeInstanceOf(WorkerRecoveredError);
    expect(w2.api.save).not.toHaveBeenCalled();
    // The recovered Worker can keep being used.
    await expect(pdf.save({ changes: [] })).resolves.toBeDefined();
    expect(w2.api.save).toHaveBeenCalledTimes(1);
  });

  it('a call whose response never comes is also cut off and recovered when the Worker dies (dead)', async () => {
    const never = vi.fn(() => new Promise(() => {}));
    const w1 = fakeWorker({ getPageInfo: never });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    const pending = pdf.getPageInfo(0);
    await flush();
    w1.crash('Worker 스크립트 오류');
    await expect(pending).resolves.toEqual({ pageIndex: 0 });
    expect(w2.api.open).toHaveBeenCalledTimes(1);
  });

  it('even if several calls fail at the same time, recovery runs only once', async () => {
    const boom = vi.fn(async () => {
      throw fatal();
    });
    const w1 = fakeWorker({ getPageInfo: boom, renderPage: boom });
    const w2 = fakeWorker();
    const { pdf, spawned } = setup([w1, w2]);
    await pdf.open(bytes());
    const results = await Promise.all([
      pdf.getPageInfo(0),
      pdf.renderPage({ pageIndex: 0, scale: 1 }),
      pdf.getPageInfo(1),
    ]);
    expect(results).toHaveLength(3);
    expect(spawned()).toBe(2);
    expect(w2.api.open).toHaveBeenCalledTimes(1);
    expect(pdf.recoveryCount).toBe(1);
  });

  it('beginParagraphEdit passes renderScale to the Worker (R-L1)', async () => {
    const w1 = fakeWorker();
    const { pdf } = setup([w1]);
    await pdf.open(bytes());
    await pdf.beginParagraphEdit(0, 1, 1, 3);
    expect(w1.api.beginParagraphEdit).toHaveBeenCalledWith(0, 1, 1, 3);
  });

  it('a call arriving with a draft from a pre-recovery generation is not sent to the new Worker', async () => {
    const w1 = fakeWorker({
      getPageInfo: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    const begun = await pdf.beginParagraphEdit(0, 1, 1);
    await pdf.updateParagraphDraft(begun.draftId, {} as never); // same generation: passes through
    await pdf.getPageInfo(0); // recovery happens
    await expect(pdf.updateParagraphDraft(begun.draftId, {} as never)).rejects.toBeInstanceOf(
      WorkerRecoveredError,
    );
    await expect(pdf.commitParagraphEdit(begun.draftId)).rejects.toBeInstanceOf(
      WorkerRecoveredError,
    );
    await expect(pdf.cancelParagraphEdit(begun.draftId)).rejects.toBeInstanceOf(
      WorkerRecoveredError,
    );
    expect(w2.api.updateParagraphDraft).not.toHaveBeenCalled();
    // In the new generation, a new draft works normally
    const again = await pdf.beginParagraphEdit(0, 1, 2);
    await expect(pdf.updateParagraphDraft(again.draftId, {} as never)).resolves.toBeDefined();
  });

  it('fatal error during a draft call: recovers and throws WorkerRecoveredError', async () => {
    const w1 = fakeWorker({
      updateParagraphDraft: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    const begun = await pdf.beginParagraphEdit(0, 1, 1);
    const error = await pdf
      .updateParagraphDraft(begun.draftId, {} as never)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerRecoveredError);
    expect(classifyFailure(error).kind).toBe('recovered');
  });

  it('if recovery itself fails, an error is thrown and the document is unusable until the next open, and open restarts with a new Worker', async () => {
    const w1 = fakeWorker({
      getPageInfo: vi.fn(async () => {
        throw fatal();
      }),
    });
    const bad = fakeWorker({
      open: vi.fn(async () => {
        throw new Error('open 실패');
      }),
    });
    const w3 = fakeWorker();
    const { pdf, spawned } = setup([w1, bad, w3]);
    await pdf.open(bytes());
    await expect(pdf.getPageInfo(0)).rejects.toThrow('복구하지 못했습니다');
    expect(spawned()).toBe(2);
    await expect(pdf.renderPage({ pageIndex: 0, scale: 1 })).rejects.toThrow('다시 열어 주세요');
    // The on-screen sentence is built from the name (English UI, user decision 2026-10-26).
    await expect(pdf.renderPage({ pageIndex: 0, scale: 1 })).rejects.toMatchObject({
      name: 'RecoveryFailedError',
    });
    expect(spawned()).toBe(2); // no further attempts
    await pdf.open(bytes());
    expect(spawned()).toBe(3);
    expect(bad.terminated()).toBe(true);
    await expect(pdf.getPageInfo(1)).resolves.toEqual({ pageIndex: 1 });
  });

  it('the recovery notification callback is called asynchronously after recovery finishes, so an RPC inside the callback does not deadlock', async () => {
    const w1 = fakeWorker({
      getPageInfo: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker();
    let next = 0;
    const workers = [w1, w2];
    const seen: unknown[] = [];
    const pdfRef: ResilientPdf = new ResilientPdf({
      spawn: () => workers[next++]!.handle,
      transfer: (b) => b,
      editLog: () => ({ ops: [], activeEditIds: [] }),
      onRecovered: async () => {
        seen.push(await pdfRef.getPageInfo(2)); // would deadlock during recovery
      },
      log: () => {},
    });
    await pdfRef.open(bytes());
    await pdfRef.getPageInfo(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([{ pageIndex: 2 }]);
  });

  it('Redact report: null on failure, a summary on success', async () => {
    const w1 = fakeWorker();
    const { pdf } = setup([w1]);
    await pdf.open(bytes());
    w1.api.listRedactAnnots = vi.fn(async () => {
      throw new Error('보고 실패');
    });
    expect(await pdf.tryListRedactAnnots()).toBeNull();
    w1.api.listRedactAnnots = vi.fn(async () => ({ total: 2, pages: [0, 3] }));
    expect(await pdf.tryListRedactAnnots()).toEqual({ total: 2, pages: [0, 3] });
  });
});
