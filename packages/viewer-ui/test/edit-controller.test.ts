import { describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageModel, RenderRequest, RenderedPage } from '@pdf-editor/shared-types';
import { ViewerController } from '../src/controller.js';
import { EditLog } from '../src/edit-log.js';
import { REDO_DISCARDED_NOTICE } from '../src/edit-labels.js';
import { WORKER_RECOVERED_ERROR_NAME } from '../src/failure.js';
import { VIEWER_STRINGS, type ViewerStrings } from '../src/strings.js';
import type { ViewerHost } from '../src/viewer-host.js';
import { FakeEditHost, type FakeParagraph } from './fake-edit-host.js';
import { makePageModel } from './fixtures.js';

// Characters 10×14, left 20, top 20. Line 0 "Hello World" (characters 0–10, x 20–130).
const MODEL: PageModel = makePageModel(['Hello World', '표 셀']);
const PARAGRAPHS: FakeParagraph[] = [
  { id: 1, bbox: [20, 20, 130, 34], text: 'Hello World' },
  { id: 2, bbox: [20, 46, 50, 60], text: '표 셀', editable: false },
  { id: 3, bbox: [20, 80, 130, 94], text: 'tagged', tagged: true },
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

function setup(
  options: { withEdit?: boolean; paragraphs?: FakeParagraph[]; strings?: ViewerStrings } = {},
) {
  const edit = new FakeEditHost({ paragraphs: options.paragraphs ?? PARAGRAPHS });
  const base = {
    getPageInfo: vi.fn(async (i: number) => pageInfo(i)),
    renderPage: vi.fn(async (req: RenderRequest) => rendered(req)),
    extractPage: vi.fn(async (req: { pageIndex: number }) => ({
      ...MODEL,
      pageIndex: req.pageIndex,
    })),
    getSourceMap: vi.fn(),
    linkPage: vi.fn(),
    searchText: vi.fn(),
    getPageLayout: vi.fn(),
    log: vi.fn(),
  };
  const editApi =
    options.withEdit === false
      ? {}
      : {
          getPageEditability: vi.fn((i: number) => edit.getPageEditability(i)),
          planParagraphEdit: vi.fn((i: number, p: number) => edit.planParagraphEdit(i, p)),
          beginParagraphEdit: vi.fn((i: number, p: number, r: number, s?: number) =>
            edit.beginParagraphEdit(i, p, r, s),
          ),
          updateParagraphDraft: vi.fn((d: string, input: never) =>
            edit.updateParagraphDraft(d, input),
          ),
          commitParagraphEdit: vi.fn((d: string) => edit.commitParagraphEdit(d)),
          cancelParagraphEdit: vi.fn((d: string) => edit.cancelParagraphEdit(d)),
          undo: vi.fn(() => edit.undo()),
          redo: vi.fn(() => edit.redo()),
          getEditHistory: vi.fn(() => edit.getEditHistory()),
        };
  const host = { ...base, ...editApi } as unknown as ViewerHost & typeof base;
  const editLog = new EditLog();
  const controller = new ViewerController({
    host,
    pageCount: 3,
    getEnvironment: () => ({ devicePixelRatio: 1, availableWidth: 632 }),
    cssScaleFor: () => 1,
    editLog,
    ...(options.strings ? { strings: options.strings } : {}),
  });
  return { controller, host, edit, editLog };
}

async function started(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  await ctx.controller.start();
  await vi.waitFor(() => expect(ctx.controller.getState().edit.editability.status).toBe('ready'));
  return ctx;
}

function recovered(): Error {
  const e = new Error('복구');
  e.name = WORKER_RECOVERED_ERROR_NAME;
  return e;
}

describe('feature isolation', () => {
  it('if the host does not provide edit RPCs, no edit UI is created and rendering is unchanged', async () => {
    const { controller, host } = setup({ withEdit: false });
    await controller.start();
    expect(controller.edit).toBeNull();
    expect(controller.getState().disabled.edit).toBeNull();
    expect(controller.getState().view).not.toBeNull();
    expect(host.renderPage).toHaveBeenCalledTimes(1);
  });

  it('on "M3 미구현", only editing is permanently disabled and the diagnostic log is written just once', async () => {
    const { controller, host } = setup();
    (host.getPageEditability as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('M3 미구현: core.getPageEditability'),
    );
    await controller.start();
    await vi.waitFor(() => expect(controller.getState().disabled.edit).toContain('M3 미구현'));
    await controller.goToPage(1);
    await controller.goToPage(2);
    expect(host.log.mock.calls.filter((c) => c[0] === 'edit-unavailable')).toHaveLength(1);
    expect(controller.getState().view?.pageIndex).toBe(2);
    expect(controller.getState().disabled.text).toBeNull();
    expect(host.getPageEditability).toHaveBeenCalledTimes(1);
  });

  it('a general error fails only that page and is retried on the next page', async () => {
    const { controller, host } = setup();
    (host.getPageEditability as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await controller.start();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('error'));
    expect(controller.getState().disabled.edit).toBeNull();
    await controller.goToPage(1);
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
  });
});

describe('entry', () => {
  it('opening a page loads the per-paragraph editability classification and initializes the history', async () => {
    const { controller } = await started();
    const e = controller.getState().edit;
    expect(e.editability.status === 'ready' && e.editability.value.paragraphs).toHaveLength(3);
    await vi.waitFor(() => expect(controller.getState().edit.history?.canUndo).toBe(false));
  });

  it('a paragraph that cannot be edited shows the reason popover and creates no draft', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 2, [25, 50]);
    const e = controller.getState().edit;
    expect(e.session).toBeNull();
    expect(e.popover?.items).toEqual(['표 셀 안 글자입니다(테스트).']);
    expect(host.beginParagraphEdit).not.toHaveBeenCalled();
    controller.edit!.dismissPopover();
    expect(controller.getState().edit.popover).toBeNull();
  });

  it('given the English table, the popover reasons use the reason-code text instead of the core description (user decision 2026-10-26)', async () => {
    const { controller } = await started({ strings: VIEWER_STRINGS.en });
    await controller.edit!.begin(0, 2, [25, 50]);
    expect(controller.getState().edit.popover?.items).toEqual([
      'Text outside the body flow cannot be edited in this version.',
    ]);
    controller.edit!.showReasons(0, 2, [0, 0, 1, 1], []);
    expect(controller.getState().edit.popover?.items).toEqual(['This paragraph cannot be edited.']);
    controller.edit!.setBlockTagged(true);
    await controller.edit!.begin(0, 3, null);
    expect(controller.getState().edit.popover?.items[0]).toContain('Block tagged PDF edits');
  });

  it('an editable paragraph starts the caret at the clicked character position', async () => {
    const { controller } = await started();
    await controller.edit!.begin(0, 1, [68, 27]); // right half of 'o' (character 4, x 60–70)
    const s = controller.getState().edit.session!;
    expect(s.editor.text).toBe('Hello World');
    expect(s.editor.caret).toBe(5);
    expect(controller.edit!.active).toBe(true);
  });

  it('without a text model, the caret is at the paragraph end', async () => {
    const { controller, host } = setup();
    host.extractPage.mockRejectedValue(new Error('M1 미구현: core.extractPage'));
    await controller.start();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
    await controller.edit!.begin(0, 1, [68, 27]);
    expect(controller.getState().edit.session!.editor.caret).toBe(11);
  });

  it('with the block-tagged-PDF-editing setting on, paragraphs on a tagged page are not started', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 3, null);
    expect(controller.edit!.active).toBe(true); // allowed by default
    await controller.edit!.cancelActive();
    controller.edit!.setBlockTagged(true);
    (host.beginParagraphEdit as ReturnType<typeof vi.fn>).mockClear();
    await controller.edit!.begin(0, 3, null);
    expect(controller.edit!.active).toBe(false);
    expect(controller.getState().edit.popover?.items[0]).toContain('태그 PDF');
    expect(host.beginParagraphEdit).not.toHaveBeenCalled();
    // A paragraph without tags is edited as usual.
    await controller.edit!.begin(0, 1, null);
    expect(controller.edit!.active).toBe(true);
  });

  it('with a stale revision, re-classifies and tries once more', async () => {
    const { controller, host, edit } = await started();
    (host.planParagraphEdit as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (i: number, p: number) => {
        const plan = await edit.planParagraphEdit(i, p);
        edit.revision++; // the document changed between classification and start
        return plan;
      },
    );
    await controller.edit!.begin(0, 1, null);
    expect(controller.edit!.active).toBe(true);
    expect(host.planParagraphEdit).toHaveBeenCalledTimes(2);
  });

  it('does not restart if one is in progress or already editing', async () => {
    const { controller, host } = await started();
    await Promise.all([controller.edit!.begin(0, 1, null), controller.edit!.begin(0, 1, null)]);
    expect(host.beginParagraphEdit).toHaveBeenCalledTimes(1);
    await controller.edit!.begin(0, 3, null);
    expect(host.beginParagraphEdit).toHaveBeenCalledTimes(1);
  });
});

describe('finish', () => {
  it('on commit, updates the history and recovery log, discards the page cache and redraws', async () => {
    const { controller, host, editLog } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('!');
    const renders = host.renderPage.mock.calls.length;
    const extracts = host.extractPage.mock.calls.length;
    expect(await controller.edit!.commitActive()).toBe(true);
    const e = controller.getState().edit;
    expect(e.session).toBeNull();
    expect(e.history).toMatchObject({ canUndo: true, edits: 1 });
    expect(editLog.snapshot().ops).toHaveLength(1);
    await vi.waitFor(() => expect(host.renderPage.mock.calls.length).toBe(renders + 1));
    await vi.waitFor(() => expect(host.extractPage.mock.calls.length).toBe(extracts + 1));
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
  });

  it('committing without changes is the same as cancel and only restores the canvas (no re-render)', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 1, null);
    const before = controller.getState().repaintToken;
    const renders = host.renderPage.mock.calls.length;
    await controller.edit!.commitActive();
    expect(host.commitParagraphEdit).not.toHaveBeenCalled();
    expect(host.cancelParagraphEdit).toHaveBeenCalledTimes(1);
    expect(controller.getState().repaintToken).toBe(before + 1);
    expect(host.renderPage.mock.calls.length).toBe(renders);
  });

  it('edit cancel: discards the draft and restores the page canvas', async () => {
    const { controller, host, editLog } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('zzz');
    const before = controller.getState().repaintToken;
    await controller.edit!.cancelActive();
    expect(controller.edit!.active).toBe(false);
    expect(host.cancelParagraphEdit).toHaveBeenCalledTimes(1);
    expect(host.commitParagraphEdit).not.toHaveBeenCalled();
    expect(controller.getState().repaintToken).toBe(before + 1);
    expect(editLog.snapshot().ops).toHaveLength(0);
  });

  it('even if commit is requested twice at the same time, the RPC is called once', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await Promise.all([controller.edit!.commitActive(), controller.edit!.commitActive()]);
    expect(host.commitParagraphEdit).toHaveBeenCalledTimes(1);
  });

  it('page navigation commits the draft first and then navigates', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.nextPage();
    expect(host.commitParagraphEdit).toHaveBeenCalledTimes(1);
    expect(controller.getState().view?.pageIndex).toBe(1);
    expect(controller.edit!.active).toBe(false);
  });

  it('if the commit must continue editing through recovery, page navigation does not happen', async () => {
    const { controller, host, edit } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.edit!.currentSession()!.settle();
    edit.simulateRecovery();
    (host.commitParagraphEdit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(recovered());
    await controller.nextPage();
    expect(controller.getState().view?.pageIndex).toBe(0);
    expect(controller.edit!.active).toBe(true);
    expect(controller.getState().edit.notice).toContain('복구');
  });

  it('a window resize during editing is held and applied after editing ends', async () => {
    const { controller, host } = await started();
    let width = 632;
    (
      controller as unknown as { options: { getEnvironment: () => unknown } }
    ).options.getEnvironment = () => ({ devicePixelRatio: 2, availableWidth: width });
    await controller.edit!.begin(0, 1, null);
    const renders = host.renderPage.mock.calls.length;
    width = 1000;
    await controller.refreshEnvironment();
    expect(host.renderPage.mock.calls.length).toBe(renders);
    await controller.edit!.cancelActive();
    await controller.afterEditEnded();
    expect(host.renderPage.mock.calls.length).toBe(renders + 1);
  });
});

describe('document undo/redo', () => {
  it('undo and redo redraw the affected pages and follow the active edits of the recovery log', async () => {
    const { controller, host, editLog } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.edit!.commitActive();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
    const renders = host.renderPage.mock.calls.length;
    await controller.edit!.undo();
    expect(controller.getState().edit.history).toMatchObject({ canUndo: false, canRedo: true });
    expect(editLog.snapshot().ops).toHaveLength(0); // removed from the active log
    await vi.waitFor(() => expect(host.renderPage.mock.calls.length).toBe(renders + 1));
    await controller.edit!.redo();
    expect(editLog.snapshot().ops).toHaveLength(1); // restored by redo (the EditOp is kept)
    expect(controller.getState().edit.history).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('starting a new edit after undo shows a notice that the redo history is cleared', async () => {
    const { controller } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.edit!.commitActive();
    await controller.edit!.undo();
    expect(controller.getState().edit.history?.canRedo).toBe(true);
    await controller.edit!.begin(0, 1, null);
    expect(controller.getState().edit.notice).toBe(REDO_DISCARDED_NOTICE);
  });

  it('an action that cannot be done (canUndo=false) does not call RPC, and is blocked during editing', async () => {
    const { controller, host } = await started();
    await vi.waitFor(() => expect(controller.getState().edit.history).not.toBeNull());
    await controller.edit!.undo();
    expect(host.undo).not.toHaveBeenCalled();
    await controller.edit!.begin(0, 1, null);
    await controller.edit!.redo();
    expect(host.redo).not.toHaveBeenCalled();
  });
});

describe('Worker recovery (D6)', () => {
  it('during a draft, restarts the same paragraph draft with the editor model', async () => {
    const { controller, host, edit } = await started();
    await controller.edit!.begin(0, 1, null);
    const session = controller.edit!.currentSession()!;
    session.typeText('가');
    await session.settle();
    edit.simulateRecovery();
    await controller.handleWorkerRecovered();
    expect(host.beginParagraphEdit).toHaveBeenCalledTimes(2);
    expect(controller.getState().edit.notice).toContain('편집 중이던 문단');
    expect(session.view().shown.text).toBe('Hello World가');
    expect(await controller.edit!.commitActive()).toBe(true);
  });

  it('with no draft, discards the page cache and notifies that the undo history is gone', async () => {
    const { controller, host } = await started();
    const renders = host.renderPage.mock.calls.length;
    await controller.handleWorkerRecovered();
    expect(controller.getState().edit.notice).toContain('되돌리기 이력');
    await vi.waitFor(() => expect(host.renderPage.mock.calls.length).toBe(renders + 1));
  });

  it('given the English string table, the toolbar notice is also in English (user request 2026-10-23)', async () => {
    const { controller } = await started({ strings: VIEWER_STRINGS.en });
    await controller.handleWorkerRecovered();
    expect(controller.getState().edit.notice).toBe(VIEWER_STRINGS.en.recoveredHistoryLost);
  });
});

describe('input buffer (M3 handover)', () => {
  function fakeBuffer(text = '한x') {
    const calls: string[] = [];
    return {
      calls,
      open: () => void calls.push('open'),
      take: () => (calls.push('take'), text),
      close: () => void calls.push('close'),
    };
  }

  it('collects from the start (open before plan), and puts them at the caret position when the editor opens', async () => {
    const { controller, host } = await started();
    const buf = fakeBuffer('한x');
    controller.edit!.setInputBuffer(buf);
    const order: string[] = [];
    (host.planParagraphEdit as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (i: number, p: number) => {
        order.push(`plan:${buf.calls.join(',')}`);
        return new FakeEditHost({ paragraphs: PARAGRAPHS }).planParagraphEdit(i, p);
      },
    );
    await controller.edit!.begin(0, 1, [130, 30]);
    expect(order[0]).toBe('plan:open');
    const v = controller.getState().edit.session!;
    expect(v.editor.text.endsWith('한x')).toBe(true);
    expect(v.dirty).toBe(true);
    expect(buf.calls).toEqual(['open', 'take']);
  });

  it('if the editor cannot be opened (restricted paragraph), the collected characters are discarded', async () => {
    const { controller } = await started();
    const buf = fakeBuffer();
    controller.edit!.setInputBuffer(buf);
    await controller.edit!.begin(0, 2, null);
    expect(controller.getState().edit.session).toBeNull();
    expect(buf.calls).toEqual(['open', 'close']);
  });

  it('if there are no collected characters, the text is unchanged (no change)', async () => {
    const { controller } = await started();
    controller.edit!.setInputBuffer(fakeBuffer(''));
    await controller.edit!.begin(0, 1, null);
    expect(controller.getState().edit.session?.dirty).toBe(false);
  });
});
