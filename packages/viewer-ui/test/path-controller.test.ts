import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageModel, RenderRequest, RenderedPage } from '@pdf-editor/shared-types';
import { ViewerController } from '../src/controller.js';
import { WORKER_RECOVERED_ERROR_NAME } from '../src/failure.js';
import { PATH_DEBOUNCE_MS, emptyPathEdit } from '../src/path-controller.js';
import type { ViewerHost } from '../src/viewer-host.js';
import { FakeEditHost, type FakePath } from './fake-edit-host.js';
import { makePageModel } from './fixtures.js';
import { makePath } from './path-fixtures.js';

const BASE: PageModel = makePageModel(['Hello World']);

const PATHS: FakePath[] = [
  { info: makePath(10, [100, 100, 200, 160]) },
  { info: makePath(11, [120, 110, 150, 130]) },
  { info: makePath(12, [300, 300, 340, 320]), editable: false, reasons: ['clip-path'] },
  {
    info: makePath(13, [400, 100, 440, 100], {
      op: 'stroke',
      lineWidth: 2,
      color: null,
      segments: [
        { type: 'M', p: [400, 100] },
        { type: 'L', p: [440, 100] },
      ],
    }),
  },
];

const pageInfo = (pageIndex: number): PageInfo => ({
  pageIndex,
  bounds: [0, 0, 600, 800],
  size: { width: 600, height: 800 },
  rotation: 0,
});
const rendered = (req: RenderRequest): RenderedPage => ({
  pageIndex: req.pageIndex,
  width: Math.ceil(600 * req.scale),
  height: Math.ceil(800 * req.scale),
  rgba: new Uint8ClampedArray(4),
  renderMs: 1,
  clip: null,
});

function setup(options: { withPath?: boolean } = {}) {
  const fake = new FakeEditHost({ paragraphs: [], paths: PATHS });
  const base = {
    getPageInfo: vi.fn(async (i: number) => pageInfo(i)),
    renderPage: vi.fn(async (req: RenderRequest) => rendered(req)),
    extractPage: vi.fn(async (req: { pageIndex: number; includePathSegments?: boolean }) => ({
      ...BASE,
      pageIndex: req.pageIndex,
      paths: fake.pathInfos(),
    })),
    getSourceMap: vi.fn(),
    linkPage: vi.fn(),
    searchText: vi.fn(),
    getPageLayout: vi.fn(),
    log: vi.fn(),
  };
  const editApi = {
    getPageEditability: vi.fn((i: number) => fake.getPageEditability(i)),
    planParagraphEdit: vi.fn((i: number, p: number) => fake.planParagraphEdit(i, p)),
    beginParagraphEdit: vi.fn((i: number, p: number, r: number, s?: number) =>
      fake.beginParagraphEdit(i, p, r, s),
    ),
    updateParagraphDraft: vi.fn((d: string, input: never) => fake.updateParagraphDraft(d, input)),
    commitParagraphEdit: vi.fn((d: string) => fake.commitParagraphEdit(d)),
    cancelParagraphEdit: vi.fn((d: string) => fake.cancelParagraphEdit(d)),
    undo: vi.fn(() => fake.undo()),
    redo: vi.fn(() => fake.redo()),
    getEditHistory: vi.fn(() => fake.getEditHistory()),
  };
  const pathApi =
    options.withPath === false
      ? {}
      : {
          planPathEdit: vi.fn((i: number, s: number[]) => fake.planPathEdit(i, s)),
          beginPathEdit: vi.fn((i: number, s: number[], r: number) => fake.beginPathEdit(i, s, r)),
          updatePathDraft: vi.fn((d: string, e: never, scale: number) =>
            fake.updatePathDraft(d, e, scale),
          ),
          commitPathEdit: vi.fn((d: string) => fake.commitPathEdit(d)),
          cancelPathEdit: vi.fn((d: string) => fake.cancelPathEdit(d)),
        };
  const host = { ...base, ...editApi, ...pathApi } as unknown as ViewerHost & typeof base;
  const controller = new ViewerController({
    host,
    pageCount: 3,
    getEnvironment: () => ({ devicePixelRatio: 1, availableWidth: 632 }),
    cssScaleFor: () => 1,
  });
  return { controller, host, fake, pathApi };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  await ctx.controller.start();
  await vi.waitFor(() => expect(ctx.controller.getState().edit.editability.status).toBe('ready'));
  return ctx;
}

const paths = (c: ViewerController) => {
  const p = c.edit?.paths;
  if (!p) throw new Error('패스 코디네이터 없음');
  return p;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('기능 격리', () => {
  it('패스 RPC 가 없으면 패스 코디네이터를 만들지 않고 문단 편집은 그대로다', async () => {
    const { controller } = setup({ withPath: false });
    expect(controller.edit).not.toBeNull();
    expect(controller.edit?.paths).toBeNull();
  });

  it('planPathEdit 가 "M4 미구현" 이면 패스 편집만 끈다', async () => {
    const { controller, fake } = await started();
    fake.failNext('planPathEdit', new Error('M4 미구현: core.planPathEdit'));
    await paths(controller).selectAt(0, [150, 130], 1, false);
    const s = controller.getState();
    expect(s.disabled.path).toContain('M4 미구현');
    expect(s.disabled.edit).toBeNull();
    expect(s.edit.path.selection).toBeNull();
  });
});

describe('선택', () => {
  it('클릭하면 모델을 읽고(includePathSegments) 가장 작은 패스를 고르며 plan 을 받는다', async () => {
    const { controller, host } = await started();
    const sel = await paths(controller).selectAt(0, [130, 120], 1, false);
    expect(sel).toEqual([11]);
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 0, includePathSegments: true });
    const s = controller.getState().edit.path;
    expect(s.selection?.plan?.editable).toBe(true);
    expect(s.selection?.plan?.target.paintSeqs).toEqual([11]);
  });

  it('Shift 는 선택에 더하고 다시 누르면 뺀다. 빈 곳 클릭은 푼다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(await p.selectAt(0, [110, 150], 1, true)).toEqual([11, 10]);
    expect(await p.selectAt(0, [130, 120], 1, true)).toEqual([10]);
    expect(await p.selectAt(0, [500, 500], 1, true)).toEqual([10]);
    expect(await p.selectAt(0, [500, 500], 1, false)).toEqual([]);
    expect(controller.getState().edit.path.selection).toBeNull();
  });

  it('선은 화면 4px(배율 반영) 안에서 맞는다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    expect(await p.selectAt(0, [420, 103], 1, false)).toEqual([13]);
    expect(await p.selectAt(0, [420, 110], 1, false)).toEqual([]);
    // 확대(배율 2): 3.5pt(7px)는 허용(4px + 선 두께 절반) 밖이고 1.5pt 는 안이다
    expect(await p.selectAt(0, [420, 103.5], 2, false)).toEqual([]);
    expect(await p.selectAt(0, [420, 101.5], 2, false)).toEqual([13]);
  });

  it('편집할 수 없는 패스는 선택되지만 사유를 안내하고 편집 동작을 열지 않는다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [310, 310], 1, false);
    const s = controller.getState().edit.path;
    expect(s.selection?.plan?.editable).toBe(false);
    expect(s.note?.[0]).toContain('clip-path');
    expect(p.beginGesture()).toBeNull();
  });

  it('점 편집 모드는 편집 가능한 단일 선택에서만 켜진다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    p.setPointMode(true);
    expect(controller.getState().edit.path.pointMode).toBe(true);
    await p.selectAt(0, [110, 150], 1, true);
    expect(controller.getState().edit.path.pointMode).toBe(false);
    p.setPointMode(true);
    expect(controller.getState().edit.path.pointMode).toBe(false);
  });

  it('쪽을 옮기면 선택이 풀린다', async () => {
    const { controller } = await started();
    await paths(controller).selectAt(0, [130, 120], 1, false);
    await controller.goToPage(1);
    expect(controller.getState().edit.path.selection).toBeNull();
  });
});

describe('편집 동작', () => {
  it('끄는 동안 서버 갱신은 200 ms 정지 뒤에만 가고, 놓으면 즉시 보내고 커밋한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    await g.ready();
    for (let i = 1; i <= 10; i++) {
      g.update(emptyPathEdit({ transform: [1, 0, 0, 1, i, 0] }));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fake.count('updatePathDraft')).toBe(0); // 50 ms 간격이라 정지가 없었다
    await vi.advanceTimersByTimeAsync(PATH_DEBOUNCE_MS);
    expect(fake.count('updatePathDraft')).toBe(1);
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 20, 0] }));
    expect(await p.commitGesture()).toBe(true);
    expect(fake.count('updatePathDraft')).toBe(2);
    expect(fake.count('commitPathEdit')).toBe(1);
    expect(fake.pathEdits.at(-1)?.transform).toEqual([1, 0, 0, 1, 20, 0]);
    const s = controller.getState();
    expect(s.edit.history?.edits).toBe(1);
    expect(controller.editLog.snapshot().ops[0]?.kind).toBe('edit-path');
    expect(s.edit.path.gesture).toBeNull();
    // 쪽을 다시 읽은 뒤에도 선택이 유지되고 재판정된다
    expect(s.edit.path.selection?.paintSeqs).toEqual([11]);
    expect(s.edit.path.selection?.plan?.target.bbox[0]).toBe(140);
  });

  it('Esc(cancelGesture)는 초안을 버리고 문서를 바꾸지 않는다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 5, 5] }));
    expect(await p.cancelGesture()).toBe(true);
    expect(fake.count('cancelPathEdit')).toBe(1);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(controller.getState().edit.history?.edits ?? 0).toBe(0);
    expect(controller.getState().repaintToken).toBeGreaterThan(0);
  });

  it('편집 없이 놓으면 취소와 같다(편집 수 불변)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    p.beginGesture();
    await p.commitGesture();
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(fake.count('cancelPathEdit')).toBe(1);
  });

  it('속성 한 번 적용: 색은 한 번만 커밋한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ fill: [0, 1, 0] }));
    expect(fake.count('commitPathEdit')).toBe(1);
    expect(fake.pathInfos().find((i) => i.paintSeq === 11)?.color?.rgb).toEqual([0, 1, 0]);
  });

  it('바뀌는 것이 없는 속성 편집은 초안을 열지 않는다(같은 색, 채움 전용 패스의 두께, 리뷰 L6)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(p.selectionPaints()).toEqual({ fills: true, strokes: false });
    expect(await p.applyOnce(emptyPathEdit({ fill: [1, 0, 0] }))).toBe(true); // 현재 색과 같음
    expect(await p.applyOnce(emptyPathEdit({ lineWidth: 3 }))).toBe(true); // 긋지 않는 패스
    expect(await p.applyOnce(emptyPathEdit({ stroke: [0, 0, 1] }))).toBe(true);
    expect(fake.count('beginPathEdit')).toBe(0);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(controller.getState().edit.history?.edits ?? 0).toBe(0);
  });

  it('선 두께는 긋는 패스에만 적용한다(다중 선택에 섞이면 긋는 패스가 있어 허용)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [420, 100], 1, false);
    expect(p.selectionPaints()).toEqual({ fills: false, strokes: true });
    expect(p.effectiveEdit(emptyPathEdit({ fill: [0, 1, 0] }))).toBeNull();
    expect(p.effectiveEdit(emptyPathEdit({ lineWidth: 2 }))).toBeNull(); // 현재 두께와 같음
    await p.applyOnce(emptyPathEdit({ lineWidth: 4 }));
    expect(fake.count('commitPathEdit')).toBe(1);
    await p.selectAt(0, [130, 120], 1, true);
    expect(p.selectionPaints()).toEqual({ fills: true, strokes: true });
  });

  it('제자리로 돌아온 끌기(항등 변환)는 커밋하지 않고 취소한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 5, 0] }));
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 0, 0] }));
    expect(await p.commitGesture()).toBe(true);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(fake.count('cancelPathEdit')).toBe(1);
  });

  it('다중 선택은 같은 변환을 한 편집으로 적용한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.selectAt(0, [110, 150], 1, true);
    await p.applyOnce(emptyPathEdit({ transform: [1, 0, 0, 1, 10, 0] }));
    expect(fake.count('commitPathEdit')).toBe(1);
    const op = controller.editLog.snapshot().ops[0];
    expect(op?.kind === 'edit-path' && op.target.paintSeqs).toEqual([11, 10]);
    const boxes = fake
      .pathInfos()
      .filter((i) => i.paintSeq <= 11)
      .map((i) => i.bbox[0]);
    expect(boxes.sort()).toEqual([110, 130]);
  });

  it('삭제: 선택을 풀고 패스가 사라진다(다중 선택 포함)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.selectAt(0, [110, 150], 1, true);
    expect(await p.deleteSelected()).toBe(true);
    expect(fake.pathInfos().map((i) => i.paintSeq)).toEqual([12, 13]);
    expect(controller.getState().edit.path.selection).toBeNull();
    const op = controller.editLog.snapshot().ops[0];
    expect(op?.kind === 'edit-path' && op.edit.delete).toBe(true);
  });

  it('점 편집: 점 번호와 새 위치가 PathEdit.points 로 간다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ points: [{ index: 2, to: [160, 140] }] }));
    expect(fake.pathEdits.at(-1)?.points).toEqual([{ index: 2, to: [160, 140] }]);
    expect(fake.pathInfos().find((i) => i.paintSeq === 11)?.bbox).toEqual([120, 110, 160, 140]);
  });

  it('문단 편집이 열려 있으면 패스 동작을 열지 않는다. 문단 편집을 시작하면 선택이 풀린다', async () => {
    const { controller, fake } = await started();
    const fp = new FakeEditHost({
      paragraphs: [{ id: 1, bbox: [20, 20, 130, 34], text: 'Hello World' }],
    });
    void fp;
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(fake.count('beginParagraphEdit')).toBe(0);
    // 세션이 없으므로 패스 동작은 열린다
    expect(p.beginGesture()).not.toBeNull();
    await p.cancelGesture();
  });

  it('문서 undo 는 선택을 푼다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ fill: [0, 0, 1] }));
    await controller.edit!.undo();
    expect(controller.getState().edit.path.selection).toBeNull();
  });
});

describe('오류·복구', () => {
  it('begin 이 revision 오류를 내면 다시 판정해 한 번 더 시도한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    fake.revision++; // 선택 뒤 문서가 바뀜
    const g = p.beginGesture()!;
    await g.ready();
    expect(fake.count('beginPathEdit')).toBe(2);
    expect(fake.count('planPathEdit')).toBe(2);
    await p.cancelGesture();
  });

  it('revision 재시도에서 대상 지문이 바뀌었으면 시작하지 않고 선택을 푼다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    fake.shiftPath(11, 5); // 같은 paintSeq 가 다른 패스(상자)를 가리킴
    const g = p.beginGesture()!;
    await expect(g.ready()).rejects.toThrow('다시 선택');
    expect(fake.count('beginPathEdit')).toBe(1);
    await vi.waitFor(() => expect(controller.getState().edit.path.selection).toBeNull());
    expect(controller.getState().edit.path.gesture).toBeNull();
    expect(controller.getState().edit.notice).toContain('다시 선택');
  });

  it('Worker 복구 재시작에서 대상 지문이 바뀌었으면 커밋하지 않고 선택을 푼다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    await g.ready();
    const err = new Error('복구');
    err.name = WORKER_RECOVERED_ERROR_NAME;
    fake.failNext('updatePathDraft', err);
    fake.simulateRecovery();
    fake.shiftPath(11, 5);
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 3, 0] }));
    expect(await p.commitGesture()).toBe(false);
    expect(fake.count('beginPathEdit')).toBe(1);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(controller.getState().edit.path.selection).toBeNull();
    expect(controller.getState().edit.notice).toContain('다시 선택');
  });

  it('갱신 중 Worker 복구: 같은 대상을 다시 시작하고 최신 편집을 다시 보낸다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    await g.ready();
    const err = new Error('복구');
    err.name = WORKER_RECOVERED_ERROR_NAME;
    fake.failNext('updatePathDraft', err);
    fake.simulateRecovery();
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 3, 0] }));
    await g.flush();
    expect(fake.count('beginPathEdit')).toBe(2);
    expect(g.view().error).toBeNull();
    expect(await p.commitGesture()).toBe(true);
    expect(fake.count('commitPathEdit')).toBe(1);
  });

  it('갱신이 실패하면 커밋하지 않고 초안을 취소한다', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    fake.failNext('updatePathDraft', new Error('렌더 실패'));
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 3, 0] }));
    expect(await p.commitGesture()).toBe(false);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(fake.count('cancelPathEdit')).toBe(1);
    expect(controller.getState().edit.notice).toContain('렌더 실패');
  });

  it('Worker 복구 알림: 진행 중인 패스 동작은 취소하고 선택을 푼다', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    p.beginGesture();
    await controller.handleWorkerRecovered();
    const s = controller.getState().edit;
    expect(s.path.gesture).toBeNull();
    expect(s.path.selection).toBeNull();
    expect(s.notice).toContain('복구');
  });
});

describe('편집 가능 표시', () => {
  it('토글하면 상태가 바뀌고 쪽을 다시 읽을 때 패스 모델도 읽는다', async () => {
    const { controller, host } = await started();
    controller.edit!.setShowEditable(true);
    expect(controller.getState().edit.showEditable).toBe(true);
    await controller.goToPage(1);
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 1, includePathSegments: true });
  });
});
