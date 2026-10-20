import { describe, expect, it, vi } from 'vitest';
import type { PageInfo, PageModel, RenderRequest, RenderedPage } from '@pdf-editor/shared-types';
import { ViewerController } from '../src/controller.js';
import { EditLog } from '../src/edit-log.js';
import { WORKER_RECOVERED_ERROR_NAME } from '../src/failure.js';
import type { ViewerHost } from '../src/viewer-host.js';
import { FakeEditHost, type FakeParagraph } from './fake-edit-host.js';
import { makePageModel } from './fixtures.js';

// 글자 10×14, 왼쪽 20·위쪽 20. 줄 0 "Hello World"(글자 0–10, x 20–130).
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

function setup(options: { withEdit?: boolean; paragraphs?: FakeParagraph[] } = {}) {
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

describe('기능 격리', () => {
  it('호스트가 편집 RPC 를 주지 않으면 편집 UI 를 만들지 않고 렌더는 그대로다', async () => {
    const { controller, host } = setup({ withEdit: false });
    await controller.start();
    expect(controller.edit).toBeNull();
    expect(controller.getState().disabled.edit).toBeNull();
    expect(controller.getState().view).not.toBeNull();
    expect(host.renderPage).toHaveBeenCalledTimes(1);
  });

  it('"M3 미구현" 이면 편집만 영구 비활성화하고 진단 로그는 한 번만 남긴다', async () => {
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

  it('일반 오류는 그 쪽만 실패하고 다음 쪽에서 다시 시도한다', async () => {
    const { controller, host } = setup();
    (host.getPageEditability as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await controller.start();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('error'));
    expect(controller.getState().disabled.edit).toBeNull();
    await controller.goToPage(1);
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
  });
});

describe('진입', () => {
  it('쪽을 열면 문단별 편집 가능 판정을 불러오고 이력을 초기화한다', async () => {
    const { controller } = await started();
    const e = controller.getState().edit;
    expect(e.editability.status === 'ready' && e.editability.value.paragraphs).toHaveLength(3);
    await vi.waitFor(() => expect(controller.getState().edit.history?.canUndo).toBe(false));
  });

  it('편집할 수 없는 문단은 사유 팝오버를 보이고 초안을 만들지 않는다', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 2, [25, 50]);
    const e = controller.getState().edit;
    expect(e.session).toBeNull();
    expect(e.popover?.items).toEqual(['표 셀 안 글자입니다(테스트).']);
    expect(host.beginParagraphEdit).not.toHaveBeenCalled();
    controller.edit!.dismissPopover();
    expect(controller.getState().edit.popover).toBeNull();
  });

  it('편집 가능 문단은 클릭한 글자 위치에서 캐럿을 시작한다', async () => {
    const { controller } = await started();
    await controller.edit!.begin(0, 1, [68, 27]); // 'o'(글자 4, x 60–70)의 오른쪽 절반
    const s = controller.getState().edit.session!;
    expect(s.editor.text).toBe('Hello World');
    expect(s.editor.caret).toBe(5);
    expect(controller.edit!.active).toBe(true);
  });

  it('텍스트 모델이 없으면 캐럿은 문단 끝', async () => {
    const { controller, host } = setup();
    host.extractPage.mockRejectedValue(new Error('M1 미구현: core.extractPage'));
    await controller.start();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
    await controller.edit!.begin(0, 1, [68, 27]);
    expect(controller.getState().edit.session!.editor.caret).toBe(11);
  });

  it('태그 PDF 편집 막기 설정이 켜져 있으면 태그 쪽 문단은 시작하지 않는다', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 3, null);
    expect(controller.edit!.active).toBe(true); // 기본은 허용
    await controller.edit!.cancelActive();
    controller.edit!.setBlockTagged(true);
    (host.beginParagraphEdit as ReturnType<typeof vi.fn>).mockClear();
    await controller.edit!.begin(0, 3, null);
    expect(controller.edit!.active).toBe(false);
    expect(controller.getState().edit.popover?.items[0]).toContain('태그 PDF');
    expect(host.beginParagraphEdit).not.toHaveBeenCalled();
    // 태그 없는 문단은 그대로 편집된다.
    await controller.edit!.begin(0, 1, null);
    expect(controller.edit!.active).toBe(true);
  });

  it('오래된 revision 이면 다시 판정해 한 번 더 시도한다', async () => {
    const { controller, host, edit } = await started();
    (host.planParagraphEdit as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (i: number, p: number) => {
        const plan = await edit.planParagraphEdit(i, p);
        edit.revision++; // 판정과 시작 사이에 문서가 바뀜
        return plan;
      },
    );
    await controller.edit!.begin(0, 1, null);
    expect(controller.edit!.active).toBe(true);
    expect(host.planParagraphEdit).toHaveBeenCalledTimes(2);
  });

  it('진행 중이거나 이미 편집 중이면 다시 시작하지 않는다', async () => {
    const { controller, host } = await started();
    await Promise.all([controller.edit!.begin(0, 1, null), controller.edit!.begin(0, 1, null)]);
    expect(host.beginParagraphEdit).toHaveBeenCalledTimes(1);
    await controller.edit!.begin(0, 3, null);
    expect(host.beginParagraphEdit).toHaveBeenCalledTimes(1);
  });
});

describe('종료', () => {
  it('커밋하면 이력·복구 로그를 갱신하고 쪽 캐시를 버리고 다시 그린다', async () => {
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

  it('변경 없이 커밋하면 취소와 같고 캔버스만 복원한다(재렌더 없음)', async () => {
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

  it('편집 취소: 초안을 버리고 쪽 캔버스를 복원한다', async () => {
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

  it('동시에 두 번 커밋을 요청해도 RPC 는 한 번', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await Promise.all([controller.edit!.commitActive(), controller.edit!.commitActive()]);
    expect(host.commitParagraphEdit).toHaveBeenCalledTimes(1);
  });

  it('쪽 이동은 초안을 먼저 커밋한 뒤 이동한다', async () => {
    const { controller, host } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.nextPage();
    expect(host.commitParagraphEdit).toHaveBeenCalledTimes(1);
    expect(controller.getState().view?.pageIndex).toBe(1);
    expect(controller.edit!.active).toBe(false);
  });

  it('커밋이 복구로 편집을 이어 가야 하면 쪽 이동을 하지 않는다', async () => {
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

  it('편집 중 창 크기 변화는 보류했다가 편집이 끝나면 반영한다', async () => {
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

describe('문서 undo/redo', () => {
  it('undo·redo 는 영향 쪽을 다시 그리고 복구 로그의 활성 편집을 따라간다', async () => {
    const { controller, host, editLog } = await started();
    await controller.edit!.begin(0, 1, null);
    controller.edit!.currentSession()!.typeText('a');
    await controller.edit!.commitActive();
    await vi.waitFor(() => expect(controller.getState().edit.editability.status).toBe('ready'));
    const renders = host.renderPage.mock.calls.length;
    await controller.edit!.undo();
    expect(controller.getState().edit.history).toMatchObject({ canUndo: false, canRedo: true });
    expect(editLog.snapshot().ops).toHaveLength(0); // 활성 로그에서 빠진다
    await vi.waitFor(() => expect(host.renderPage.mock.calls.length).toBe(renders + 1));
    await controller.edit!.redo();
    expect(editLog.snapshot().ops).toHaveLength(1); // redo 로 되살린다(EditOp 는 유지)
    expect(controller.getState().edit.history).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('할 수 없는 동작(canUndo=false)은 RPC 를 부르지 않고, 편집 중에는 막는다', async () => {
    const { controller, host } = await started();
    await vi.waitFor(() => expect(controller.getState().edit.history).not.toBeNull());
    await controller.edit!.undo();
    expect(host.undo).not.toHaveBeenCalled();
    await controller.edit!.begin(0, 1, null);
    await controller.edit!.redo();
    expect(host.redo).not.toHaveBeenCalled();
  });
});

describe('Worker 복구(D6)', () => {
  it('초안 중이면 편집기 모델로 같은 문단 초안을 다시 시작한다', async () => {
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

  it('초안이 없으면 쪽 캐시를 버리고 되돌리기 이력이 사라졌음을 알린다', async () => {
    const { controller, host } = await started();
    const renders = host.renderPage.mock.calls.length;
    await controller.handleWorkerRecovered();
    expect(controller.getState().edit.notice).toContain('되돌리기 이력');
    await vi.waitFor(() => expect(host.renderPage.mock.calls.length).toBe(renders + 1));
  });
});

describe('입력 버퍼(M3 이관)', () => {
  function fakeBuffer(text = '한x') {
    const calls: string[] = [];
    return {
      calls,
      open: () => void calls.push('open'),
      take: () => (calls.push('take'), text),
      close: () => void calls.push('close'),
    };
  }

  it('시작과 동시에 모으고(plan 전에 open), 편집기가 열리면 캐럿 위치에 넣는다', async () => {
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

  it('편집기를 열지 못하면(제한 문단) 모은 글자를 버린다', async () => {
    const { controller } = await started();
    const buf = fakeBuffer();
    controller.edit!.setInputBuffer(buf);
    await controller.edit!.begin(0, 2, null);
    expect(controller.getState().edit.session).toBeNull();
    expect(buf.calls).toEqual(['open', 'close']);
  });

  it('모은 글자가 없으면 텍스트는 그대로(변경 없음)다', async () => {
    const { controller } = await started();
    controller.edit!.setInputBuffer(fakeBuffer(''));
    await controller.edit!.begin(0, 1, null);
    expect(controller.getState().edit.session?.dirty).toBe(false);
  });
});
