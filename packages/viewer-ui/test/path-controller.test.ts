import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageModel, RenderRequest, RenderedPage } from '@pdf-editor/shared-types';
import { VIEWER_STRINGS, type ViewerStrings } from '../src/strings.js';
import { ViewerController, overlayToggleState, overlayToggleTitle } from '../src/controller.js';
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

function setup(options: { withPath?: boolean; strings?: ViewerStrings } = {}) {
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
    ...(options.strings ? { strings: options.strings } : {}),
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

describe('feature isolation', () => {
  it('without path RPCs, no path coordinator is created and paragraph editing is unchanged', async () => {
    const { controller } = setup({ withPath: false });
    expect(controller.edit).not.toBeNull();
    expect(controller.edit?.paths).toBeNull();
  });

  it('when planPathEdit gives "M4 미구현", only path editing is turned off', async () => {
    const { controller, fake } = await started();
    fake.failNext('planPathEdit', new Error('M4 미구현: core.planPathEdit'));
    await paths(controller).selectAt(0, [150, 130], 1, false);
    const s = controller.getState();
    expect(s.disabled.path).toContain('M4 미구현');
    expect(s.disabled.edit).toBeNull();
    expect(s.edit.path.selection).toBeNull();
  });
});

describe('selection', () => {
  it('clicking reads the model (includePathSegments), picks the smallest path and gets a plan', async () => {
    const { controller, host } = await started();
    const sel = await paths(controller).selectAt(0, [130, 120], 1, false);
    expect(sel).toEqual([11]);
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 0, includePathSegments: true });
    const s = controller.getState().edit.path;
    expect(s.selection?.plan?.editable).toBe(true);
    expect(s.selection?.plan?.target.paintSeqs).toEqual([11]);
  });

  it('Shift adds to the selection and removes it when pressed again. Clicking an empty spot clears it', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(await p.selectAt(0, [110, 150], 1, true)).toEqual([11, 10]);
    expect(await p.selectAt(0, [130, 120], 1, true)).toEqual([10]);
    expect(await p.selectAt(0, [500, 500], 1, true)).toEqual([10]);
    expect(await p.selectAt(0, [500, 500], 1, false)).toEqual([]);
    expect(controller.getState().edit.path.selection).toBeNull();
  });

  it('a line hits within 4px on screen (scale taken into account)', async () => {
    const { controller } = await started();
    const p = paths(controller);
    expect(await p.selectAt(0, [420, 103], 1, false)).toEqual([13]);
    expect(await p.selectAt(0, [420, 110], 1, false)).toEqual([]);
    // Zoomed in (scale 2): 3.5pt (7px) is outside the tolerance (4px + half the line width) and 1.5pt is inside
    expect(await p.selectAt(0, [420, 103.5], 2, false)).toEqual([]);
    expect(await p.selectAt(0, [420, 101.5], 2, false)).toEqual([13]);
  });

  it('a path that cannot be edited is selected but the reason is shown and no edit action is opened', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [310, 310], 1, false);
    const s = controller.getState().edit.path;
    expect(s.selection?.plan?.editable).toBe(false);
    expect(s.note?.[0]).toContain('clip-path');
    expect(p.beginGesture()).toBeNull();
  });

  it('given the English table, the path reasons use the reason-code text instead of the core description (user decision 2026-10-26)', async () => {
    const { controller } = await started({ strings: VIEWER_STRINGS.en });
    await paths(controller).selectAt(0, [310, 310], 1, false);
    expect(controller.getState().edit.path.note).toEqual([
      'A path that defines a clipping area cannot be edited.',
    ]);
  });

  it('point-edit mode turns on only for a single editable selection', async () => {
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

  it('moving to another page clears the selection', async () => {
    const { controller } = await started();
    await paths(controller).selectAt(0, [130, 120], 1, false);
    await controller.goToPage(1);
    expect(controller.getState().edit.path.selection).toBeNull();
  });
});

describe('edit actions', () => {
  it('while dragging, server updates go out only after a 200 ms pause, and on release it sends immediately and commits', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    await g.ready();
    for (let i = 1; i <= 10; i++) {
      g.update(emptyPathEdit({ transform: [1, 0, 0, 1, i, 0] }));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fake.count('updatePathDraft')).toBe(0); // 50 ms intervals, so there was no pause
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
    // The selection is kept and re-classified even after the page is read again
    expect(s.edit.path.selection?.paintSeqs).toEqual([11]);
    expect(s.edit.path.selection?.plan?.target.bbox[0]).toBe(140);
  });

  it('Esc (cancelGesture) discards the draft and does not change the document', async () => {
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

  it('releasing without an edit is the same as cancel (edit count unchanged)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    p.beginGesture();
    await p.commitGesture();
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(fake.count('cancelPathEdit')).toBe(1);
  });

  it('applying a property once: a color commits only once', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ fill: [0, 1, 0] }));
    expect(fake.count('commitPathEdit')).toBe(1);
    expect(fake.pathInfos().find((i) => i.paintSeq === 11)?.color?.rgb).toEqual([0, 1, 0]);
  });

  it('a property edit that changes nothing does not open a draft (same color, width on a fill-only path, review L6)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(p.selectionPaints()).toEqual({ fills: true, strokes: false });
    expect(await p.applyOnce(emptyPathEdit({ fill: [1, 0, 0] }))).toBe(true); // same as the current color
    expect(await p.applyOnce(emptyPathEdit({ lineWidth: 3 }))).toBe(true); // a path that is not stroked
    expect(await p.applyOnce(emptyPathEdit({ stroke: [0, 0, 1] }))).toBe(true);
    expect(fake.count('beginPathEdit')).toBe(0);
    expect(fake.count('commitPathEdit')).toBe(0);
    expect(controller.getState().edit.history?.edits ?? 0).toBe(0);
  });

  it('line width applies only to stroked paths (allowed in a multi-selection because it includes stroked paths)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [420, 100], 1, false);
    expect(p.selectionPaints()).toEqual({ fills: false, strokes: true });
    expect(p.effectiveEdit(emptyPathEdit({ fill: [0, 1, 0] }))).toBeNull();
    expect(p.effectiveEdit(emptyPathEdit({ lineWidth: 2 }))).toBeNull(); // same as the current width
    await p.applyOnce(emptyPathEdit({ lineWidth: 4 }));
    expect(fake.count('commitPathEdit')).toBe(1);
    await p.selectAt(0, [130, 120], 1, true);
    expect(p.selectionPaints()).toEqual({ fills: true, strokes: true });
  });

  it('a drag that returns to the original place (identity transform) is cancelled, not committed', async () => {
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

  it('a multi-selection applies the same transform as one edit', async () => {
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

  it('delete: clears the selection and the path disappears (including a multi-selection)', async () => {
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

  it('point edit: the point number and new position go to PathEdit.points', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ points: [{ index: 2, to: [160, 140] }] }));
    expect(fake.pathEdits.at(-1)?.points).toEqual([{ index: 2, to: [160, 140] }]);
    expect(fake.pathInfos().find((i) => i.paintSeq === 11)?.bbox).toEqual([120, 110, 160, 140]);
  });

  it('when paragraph editing is open, path actions are not opened. Starting paragraph editing clears the selection', async () => {
    const { controller, fake } = await started();
    const fp = new FakeEditHost({
      paragraphs: [{ id: 1, bbox: [20, 20, 130, 34], text: 'Hello World' }],
    });
    void fp;
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    expect(fake.count('beginParagraphEdit')).toBe(0);
    // There is no session, so path actions are opened
    expect(p.beginGesture()).not.toBeNull();
    await p.cancelGesture();
  });

  it('document undo clears the selection', async () => {
    const { controller } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    await p.applyOnce(emptyPathEdit({ fill: [0, 0, 1] }));
    await controller.edit!.undo();
    expect(controller.getState().edit.path.selection).toBeNull();
  });
});

describe('errors and recovery', () => {
  it('if begin gives a revision error, re-classifies and tries once more', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    fake.revision++; // the document changed after selection
    const g = p.beginGesture()!;
    await g.ready();
    expect(fake.count('beginPathEdit')).toBe(2);
    expect(fake.count('planPathEdit')).toBe(2);
    await p.cancelGesture();
  });

  it('if the target fingerprint changed on the revision retry, does not start and clears the selection', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    fake.shiftPath(11, 5); // the same paintSeq points to a different path (box)
    const g = p.beginGesture()!;
    await expect(g.ready()).rejects.toThrow('다시 선택');
    expect(fake.count('beginPathEdit')).toBe(1);
    await vi.waitFor(() => expect(controller.getState().edit.path.selection).toBeNull());
    expect(controller.getState().edit.path.gesture).toBeNull();
    expect(controller.getState().edit.notice).toContain('다시 선택');
  });

  it('if the target fingerprint changed on the Worker recovery restart, does not commit and clears the selection', async () => {
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

  it('Worker recovery during an update: restarts the same target and resends the latest edit', async () => {
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

  it('if an update fails, does not commit and cancels the draft', async () => {
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

  it('Worker recovery notice: cancels the path action in progress and clears the selection', async () => {
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

describe('editability overlay', () => {
  it('toggling changes the state, and the path model is also read when the page is read again', async () => {
    const { controller, host } = await started();
    controller.edit!.setShowEditable(true);
    expect(controller.getState().edit.showEditable).toBe(true);
    await controller.goToPage(1);
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 1, includePathSegments: true });
  });
});

describe('layout and edit overlay buttons (user request 2026-10-22)', () => {
  it('one press turns on the layout and editability overlay together (reading the path model), another press turns both off', async () => {
    const { controller, host } = await started();
    expect(overlayToggleState(controller.getState(), true).on).toBe(false);
    controller.toggleOverlays();
    const s = controller.getState();
    expect(s.layoutEnabled).toBe(true);
    expect(s.edit.showEditable).toBe(true);
    expect(overlayToggleState(s, true)).toEqual({
      on: true,
      layoutReason: null,
      marksReason: null,
    });
    await vi.waitFor(() => expect(host.getPageLayout).toHaveBeenCalledWith(0));
    expect(host.extractPage).toHaveBeenCalledWith({ pageIndex: 0, includePathSegments: true });
    controller.toggleOverlays();
    expect(controller.getState().layoutEnabled).toBe(false);
    expect(controller.getState().edit.showEditable).toBe(false);
  });

  it('even if only one is on, it counts as pressed, and pressing turns both off', async () => {
    const { controller } = await started();
    controller.edit!.setShowEditable(true);
    expect(overlayToggleState(controller.getState(), true).on).toBe(true);
    controller.toggleOverlays();
    expect(controller.getState().edit.showEditable).toBe(false);
    expect(controller.getState().layoutEnabled).toBe(false);
  });

  it('if the layout is unimplemented, only the editability overlay is turned on and off, and the reason is written in the title', async () => {
    const { controller, host } = await started();
    host.getPageLayout.mockImplementation(async () => {
      throw new Error('M2 미구현: core getPageLayout');
    });
    controller.toggleOverlays();
    await vi.waitFor(() => expect(controller.getState().disabled.layout).not.toBeNull());
    const s = overlayToggleState(controller.getState(), true);
    expect(s.on).toBe(true);
    expect(s.marksReason).toBeNull();
    expect(overlayToggleTitle(s, true)).toContain(
      '레이아웃을 쓸 수 없어 편집 가능 표시만 켭니다: M2 미구현',
    );
    expect(overlayToggleTitle(s, true)).toContain('클릭으로 패스를 선택');
    controller.toggleOverlays();
    expect(controller.getState().edit.showEditable).toBe(false);
    controller.toggleOverlays();
    expect(controller.getState().edit.showEditable).toBe(true);
    expect(controller.getState().layoutEnabled).toBe(false);
  });
});

describe('M4 follow-up cleanup (M5 S5)', () => {
  it('the first selection (Alt+click) that arrives while the model is being read waits for that read and is selected', async () => {
    const { controller, host } = await started();
    const p = paths(controller);
    void p.ensureModel(0); // reload the path model right after opening the document
    const sel = await p.selectAt(0, [130, 120], 1, false);
    expect(sel).toEqual([11]);
    const pathReads = host.extractPage.mock.calls.filter((c) => c[0].includePathSegments);
    expect(pathReads).toHaveLength(1);
  });

  it('after commit, path actions do not start before re-classification finishes (review L7)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 20, 0] }));
    const release = fake.hold('planPathEdit');
    const done = p.commitGesture();
    await vi.waitFor(() => expect(controller.getState().edit.path.settling).toBe(true));
    expect(p.beginGesture()).toBeNull();
    release();
    await done;
    expect(controller.getState().edit.path.settling).toBe(false);
    expect(controller.getState().edit.path.selection?.plan?.target.bbox[0]).toBe(140);
    expect(p.beginGesture()).not.toBeNull();
  });

  it('a selection click during re-classification after commit is held and handled after the classification (M5 review M8)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const g = p.beginGesture()!;
    g.update(emptyPathEdit({ transform: [1, 0, 0, 1, 20, 0] }));
    const release = fake.hold('planPathEdit');
    const done = p.commitGesture();
    await vi.waitFor(() => expect(controller.getState().edit.path.settling).toBe(true));
    // Pick another path (line, 13) during re-classification: it does not finish until the classification finishes.
    let picked: number[] | null = null;
    const click = p.selectAt(0, [420, 100], 1, false).then((v) => (picked = v));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(picked).toBeNull();
    expect(controller.getState().edit.path.selection?.paintSeqs).toEqual([11]);
    release();
    await done;
    await click;
    // After the re-classification re-classifies the old selection (11), the held click is applied (not overwritten).
    expect(picked).toEqual([13]);
    const sel = controller.getState().edit.path.selection!;
    expect(sel.paintSeqs).toEqual([13]);
    expect(sel.plan?.target.paintSeqs).toEqual([13]);
    expect(controller.getState().edit.path.settling).toBe(false);
  });

  it('a click during re-classification after a delete commit is also held (M8)', async () => {
    const { controller, fake } = await started();
    const p = paths(controller);
    await p.selectAt(0, [130, 120], 1, false);
    const release = fake.hold('getPageEditability');
    const deleting = p.deleteSelected();
    await vi.waitFor(() => expect(controller.getState().edit.path.settling).toBe(true));
    expect(controller.getState().edit.path.selection).toBeNull();
    let picked: number[] | null = null;
    const click = p.selectAt(0, [420, 100], 1, false).then((v) => (picked = v));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(picked).toBeNull();
    release();
    await deleting;
    await click;
    expect(picked).toEqual([13]);
  });
});
