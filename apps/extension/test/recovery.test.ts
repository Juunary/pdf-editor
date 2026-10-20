import { describe, expect, it, vi } from 'vitest';
import type { EditHistoryState, EditOp, PdfWorkerApi } from '@pdf-editor/shared-types';
import { classifyFailure } from '@pdf-editor/viewer-ui';
import {
  ResilientPdf,
  WorkerRecoveredError,
  isFatalWorkerError,
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
  it('wasm 트랩·메모리 부족·Worker 스크립트 오류는 치명, 문서 오류는 아니다', () => {
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

  it('WorkerRecoveredError 는 뷰어 UI 가 recovered 로 분류한다', () => {
    const e = new WorkerRecoveredError('복구', 2);
    expect(classifyFailure(e).kind).toBe('recovered');
  });
});

describe('ResilientPdf', () => {
  it('정상 호출은 그대로 통과하고 일반 오류는 복구하지 않는다', async () => {
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

  it('open 은 원본을 Blob 으로 보관한 뒤 transfer 로 넘긴다', async () => {
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

  it('읽기 호출이 치명 오류면 새 Worker 로 원본 열기 → 로그 재적용 → 같은 호출을 다시 시도한다', async () => {
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
    expect(w2.api.replayEdits).toHaveBeenCalledWith(log);
    // open 이 replayEdits 보다 먼저
    expect(w2.api.open!.mock.invocationCallOrder[0]!).toBeLessThan(
      w2.api.replayEdits!.mock.invocationCallOrder[0]!,
    );
    await flush();
    await new Promise((r) => setTimeout(r, 5));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ replayedEdits: 2, recoveries: 1 });
    expect(infos[0]!.history?.activeEditIds).toEqual(['a', 'b']);
  });

  it('로그가 비어 있으면 replayEdits 를 부르지 않는다', async () => {
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

  it('쓰기 호출(저장 등)은 복구 뒤 다시 시도하지 않고 WorkerRecoveredError 를 던진다', async () => {
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
    // 복구된 Worker 는 계속 쓸 수 있다.
    await expect(pdf.save({ changes: [] })).resolves.toBeDefined();
    expect(w2.api.save).toHaveBeenCalledTimes(1);
  });

  it('응답이 영영 오지 않는 호출도 Worker 가 죽으면(dead) 끊고 복구한다', async () => {
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

  it('동시에 여러 호출이 실패해도 복구는 한 번만 한다', async () => {
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

  it('beginParagraphEdit 는 renderScale 을 Worker 로 넘긴다(R-L1)', async () => {
    const w1 = fakeWorker();
    const { pdf } = setup([w1]);
    await pdf.open(bytes());
    await pdf.beginParagraphEdit(0, 1, 1, 3);
    expect(w1.api.beginParagraphEdit).toHaveBeenCalledWith(0, 1, 1, 3);
  });

  it('복구 전 세대 초안으로 온 호출은 새 Worker 로 보내지 않는다', async () => {
    const w1 = fakeWorker({
      getPageInfo: vi.fn(async () => {
        throw fatal();
      }),
    });
    const w2 = fakeWorker();
    const { pdf } = setup([w1, w2]);
    await pdf.open(bytes());
    const begun = await pdf.beginParagraphEdit(0, 1, 1);
    await pdf.updateParagraphDraft(begun.draftId, {} as never); // 같은 세대: 통과
    await pdf.getPageInfo(0); // 복구가 일어난다
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
    // 새 세대에서 새 초안은 정상
    const again = await pdf.beginParagraphEdit(0, 1, 2);
    await expect(pdf.updateParagraphDraft(again.draftId, {} as never)).resolves.toBeDefined();
  });

  it('초안 호출 중 치명 오류: 복구하고 WorkerRecoveredError 를 던진다', async () => {
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

  it('복구 자체가 실패하면 오류를 던지고 다음 open 까지 문서를 쓸 수 없으며, open 은 새 Worker 로 다시 시작한다', async () => {
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
    expect(spawned()).toBe(2); // 더 시도하지 않는다
    await pdf.open(bytes());
    expect(spawned()).toBe(3);
    expect(bad.terminated()).toBe(true);
    await expect(pdf.getPageInfo(1)).resolves.toEqual({ pageIndex: 1 });
  });

  it('복구 알림 콜백은 복구가 끝난 뒤 비동기로 불려 콜백 안 RPC 가 교착하지 않는다', async () => {
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
        seen.push(await pdfRef.getPageInfo(2)); // 복구 중이면 교착한다
      },
      log: () => {},
    });
    await pdfRef.open(bytes());
    await pdfRef.getPageInfo(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([{ pageIndex: 2 }]);
  });

  it('Redact 보고가 실패하면 null, 성공하면 요약', async () => {
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
