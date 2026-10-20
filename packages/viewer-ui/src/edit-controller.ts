/**
 * 편집 코디네이터(DOM 비의존): 쪽 편집 가능 판정·진입(plan → begin)·세션 종료(커밋·취소)·문서 undo/redo·복구 로그.
 * `ViewerController` 가 소유하고, 상태는 `ViewerState.edit` 로 컴포넌트에 전달한다.
 *
 * 기능 격리: 편집 RPC 가 "M3 미구현" 예외를 내면 편집 기능만 끈다(`failure.ts`, 계약 4절 연결부).
 */
import type {
  EditHistoryState,
  PageEditability,
  PageModel,
  ParagraphEditPlan,
  Point,
  Rect,
} from '@pdf-editor/shared-types';
import { offsetAtPagePoint } from './edit-geometry.js';
import { limitLabel, TAGGED_BLOCKED_LABEL } from './edit-labels.js';
import type { EditLog } from './edit-log.js';
import type { InputBufferPort } from './input-buffer.js';
import { EditSession, isWorkerRecovered, type EditSessionView } from './edit-session.js';
import { classifyFailure } from './failure.js';
import {
  initialPathState,
  PathController,
  type PathContext,
  type PathState,
} from './path-controller.js';
import type { EditHostApi, PathHostApi } from './viewer-host.js';

export type EditLoadable<T> =
  | { status: 'idle' }
  | { status: 'loading'; pageIndex: number }
  | { status: 'ready'; pageIndex: number; value: T }
  | { status: 'error'; pageIndex: number; message: string };

/** 편집할 수 없는 문단에서 더블클릭했을 때 보여 주는 사유 팝오버. */
export interface EditPopover {
  /** 표 셀이면 'cell'(제목 문구). 없으면 문단. */
  kind?: 'paragraph' | 'cell';
  pageIndex: number;
  paragraphId: number;
  bbox: Rect;
  /** 사유 문구(한국어). */
  items: string[];
}

export interface EditState {
  /** 현재 쪽의 문단별 편집 가능 판정(마우스 오버 테두리). */
  editability: EditLoadable<PageEditability>;
  /** plan·begin 진행 중. */
  starting: boolean;
  popover: EditPopover | null;
  session: EditSessionView | null;
  /** 문서 undo/redo 상태(편집 RPC 가 응답한 뒤 채워진다). */
  history: EditHistoryState | null;
  /** 문서 undo/redo 처리 중. */
  busy: boolean;
  /** 사용자 알림(복구·오류). */
  notice: string | null;
  /** 태그 PDF 편집 막기(설정, 기본 끔, 계약 D1). */
  blockTagged: boolean;
  /** 폴백 글자 점선 밑줄 표시(토글). */
  fallbackUnderline: boolean;
  /** 편집 가능 표시(D6): 문단·셀·패스 테두리를 쪽 위에 모두 그린다. */
  showEditable: boolean;
  /** 벡터 패스 편집(M4) 상태. */
  path: PathState;
}

export function initialEditState(): EditState {
  return {
    editability: { status: 'idle' },
    starting: false,
    popover: null,
    session: null,
    history: null,
    busy: false,
    notice: null,
    blockTagged: false,
    fallbackUnderline: true,
    showEditable: false,
    path: initialPathState(),
  };
}

/** 계획이 태그된 쪽을 가리키는지(MCID 가 있거나 태그 경고가 있음). */
export function isTaggedPlan(plan: ParagraphEditPlan): boolean {
  return (
    plan.warnings.some(
      (w) => w.kind === 'tagged-structure-kept' || w.kind === 'tagged-structure-unlinked',
    ) ||
    (plan.insertion !== null && plan.insertion.mcidKept !== null)
  );
}

export interface CurrentView {
  pageIndex: number;
  /** 변경 영역 렌더 배율(뷰어 scale × devicePixelRatio). */
  renderScale: number;
  /** 추출 모델(없으면 시작 캐럿을 문단 끝으로). */
  text: PageModel | null;
}

export interface EditContext {
  rpc: EditHostApi;
  log: EditLog;
  now(): number;
  getState(): EditState;
  patch(partial: Partial<EditState>): void;
  currentView(): CurrentView | null;
  isStalePage(pageIndex: number): boolean;
  /** 편집 기능을 영구 비활성화한다. */
  disable(reason: string): void;
  logEvent(event: string, data?: unknown): void;
  logOnce(kind: string, event: string, data: unknown): void;
  /** 쪽 캐시를 버리고 다시 그린다(현재 쪽이 포함될 때). */
  invalidatePages(pages: number[]): Promise<void>;
  /** 취소 뒤 쪽 캔버스를 편집 전 렌더로 되돌린다. */
  repaintPage(): void;
  /** 벡터 패스 편집(M4) 연결. 호스트가 패스 RPC 를 주지 않으면 null. */
  paths: {
    rpc: PathHostApi;
    extract(pageIndex: number): Promise<PageModel>;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    disable(reason: string): void;
  } | null;
}

export class EditController {
  private session: EditSession | null = null;
  private ending: Promise<boolean> | null = null;
  /** 벡터 패스 편집(M4). 호스트가 패스 RPC 를 주지 않으면 null. */
  readonly paths: PathController | null;
  /** 편집기가 열리기 전 입력을 모으는 버퍼(DOM 구현은 마운트가 주입한다). */
  private buffer: InputBufferPort | null = null;

  constructor(private readonly ctx: EditContext) {
    const p = ctx.paths;
    this.paths = p
      ? new PathController({
          ...ctx,
          pathRpc: p.rpc,
          extractPaths: (i) => p.extract(i),
          setTimer: (fn, ms) => p.setTimer(fn, ms),
          clearTimer: (h) => p.clearTimer(h),
          disablePath: (reason) => p.disable(reason),
          ensureEditability: (i) => this.ensureEditability(i),
          getPath: () => ctx.getState().path,
          patchPath: (partial) => ctx.patch({ path: { ...ctx.getState().path, ...partial } }),
        } satisfies PathContext)
      : null;
  }

  setInputBuffer(buffer: InputBufferPort | null): void {
    this.buffer?.close();
    this.buffer = buffer;
  }

  get active(): boolean {
    return this.session !== null || (this.paths?.active ?? false);
  }

  /** 테스트·e2e 용: 지금 세션(반응 시간 기록 등). */
  currentSession(): EditSession | null {
    return this.session;
  }

  // ── 쪽 판정·이력 ─────────────────────────────────────────────────────

  /**
   * 쪽 판정을 불러온다. 같은 쪽을 불러오는 중이면 그 요청이 끝날 때까지 기다린다(패스 Alt+클릭 선택이 판정 도착 전에
   * 후보 없음으로 끝나지 않게).
   */
  async ensureEditability(pageIndex: number): Promise<void> {
    const current = this.ctx.getState().editability;
    if (current.status === 'ready' && current.pageIndex === pageIndex) return;
    if (current.status === 'loading' && current.pageIndex === pageIndex) {
      await this.editabilityPending;
      return;
    }
    const pending = this.loadEditability(pageIndex);
    this.editabilityPending = pending;
    try {
      await pending;
    } finally {
      if (this.editabilityPending === pending) this.editabilityPending = null;
    }
  }

  private editabilityPending: Promise<void> | null = null;

  private async loadEditability(pageIndex: number): Promise<void> {
    this.ctx.patch({ editability: { status: 'loading', pageIndex } });
    try {
      const value = await this.ctx.rpc.getPageEditability(pageIndex);
      if (this.ctx.isStalePage(pageIndex)) return this.resetLoading(pageIndex);
      this.ctx.patch({ editability: { status: 'ready', pageIndex, value } });
      // 패스 판정만 실패한 쪽: 문단 편집은 그대로 쓰고 진단 로그만 남긴다.
      if (value.pathError) {
        this.ctx.logEvent('path-editability-error', { pageIndex, error: value.pathError });
      }
      if (this.ctx.getState().history === null) void this.refreshHistory();
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.ctx.disable(failure.message);
        this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
          feature: '문단 편집',
          reason: failure.message,
        });
        this.ctx.patch({ editability: { status: 'error', pageIndex, message: failure.message } });
      } else {
        if (this.ctx.isStalePage(pageIndex)) return this.resetLoading(pageIndex);
        this.ctx.logEvent('edit-editability-error', { pageIndex, error: failure.message });
        this.ctx.patch({ editability: { status: 'error', pageIndex, message: failure.message } });
      }
    }
  }

  private resetLoading(pageIndex: number): void {
    const cur = this.ctx.getState().editability;
    if (cur.status === 'loading' && cur.pageIndex === pageIndex) {
      this.ctx.patch({ editability: { status: 'idle' } });
    }
  }

  invalidateEditability(): void {
    this.ctx.patch({ editability: { status: 'idle' } });
  }

  async refreshHistory(): Promise<void> {
    try {
      const history = await this.ctx.rpc.getEditHistory();
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } catch (e) {
      const failure = classifyFailure(e);
      if (failure.kind === 'unimplemented') {
        this.ctx.disable(failure.message);
        this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
          feature: '문단 편집',
          reason: failure.message,
        });
      } else if (failure.kind !== 'recovered') {
        this.ctx.logEvent('edit-history-error', { error: failure.message });
      }
    }
  }

  // ── 설정 ─────────────────────────────────────────────────────────────

  setBlockTagged(blockTagged: boolean): void {
    this.ctx.patch({ blockTagged });
  }

  setFallbackUnderline(fallbackUnderline: boolean): void {
    this.ctx.patch({ fallbackUnderline });
  }

  /** 편집 가능 표시(D6) 토글. 켜면 패스 선택용 모델을 미리 읽는다. */
  setShowEditable(showEditable: boolean): void {
    this.ctx.patch({ showEditable });
    const view = this.ctx.currentView();
    if (showEditable && view && this.paths) void this.paths.ensureModel(view.pageIndex);
  }

  dismissPopover(): void {
    if (this.ctx.getState().popover) this.ctx.patch({ popover: null });
  }

  dismissNotice(): void {
    if (this.ctx.getState().notice) this.ctx.patch({ notice: null });
  }

  // ── 진입 ─────────────────────────────────────────────────────────────

  /**
   * 문단 편집을 시작한다(더블클릭). 편집할 수 없으면 사유 팝오버를 띄운다.
   * point(페이지 공간)는 시작 캐럿 위치다(원 문서 글자 → 텍스트 위치, 계약 5.3).
   */
  async begin(pageIndex: number, paragraphId: number, point: Point | null): Promise<void> {
    const state = this.ctx.getState();
    if (this.session || state.starting || state.busy || this.paths?.active) return;
    this.paths?.clear();
    this.ctx.patch({ starting: true, popover: null, notice: null });
    // 편집기가 열리는 동안(plan → begin) 친 글자를 모은다. 열리면 넣고, 열리지 못하면 버린다.
    this.buffer?.open();
    let started = false;
    try {
      let plan = await this.ctx.rpc.planParagraphEdit(pageIndex, paragraphId);
      if (!plan.editable) {
        this.showLimits(plan);
        return;
      }
      if (state.blockTagged && isTaggedPlan(plan)) {
        this.ctx.patch({
          popover: {
            pageIndex,
            paragraphId,
            bbox: plan.target.bbox,
            items: [TAGGED_BLOCKED_LABEL],
          },
        });
        return;
      }
      let begun;
      try {
        begun = await this.ctx.rpc.beginParagraphEdit(
          pageIndex,
          paragraphId,
          plan.revision,
          this.ctx.currentView()?.renderScale,
        );
      } catch (e) {
        // 오래된 revision(그 사이 문서가 바뀜): 다시 판정해 한 번 더 시도한다.
        if (!/revision/i.test(classifyFailure(e).message)) throw e;
        plan = await this.ctx.rpc.planParagraphEdit(pageIndex, paragraphId);
        if (!plan.editable) {
          this.showLimits(plan);
          return;
        }
        begun = await this.ctx.rpc.beginParagraphEdit(
          pageIndex,
          paragraphId,
          plan.revision,
          this.ctx.currentView()?.renderScale,
        );
      }
      const view = this.ctx.currentView();
      const text = view?.text ?? null;
      const caret = point && text ? offsetAtPagePoint(text, plan.charIndexOfOffset, point) : null;
      this.session = new EditSession(
        {
          rpc: this.ctx.rpc,
          now: () => this.ctx.now(),
          renderScale: () => this.ctx.currentView()?.renderScale ?? 1,
          log: (event, data) => this.ctx.logEvent(event, data),
          onChange: (v) => this.ctx.patch({ session: v }),
        },
        plan,
        begun,
        caret,
      );
      this.ctx.patch({ session: this.session.view() });
      this.session.start();
      started = true;
      const buffered = this.buffer?.take() ?? '';
      if (buffered !== '') {
        this.session.typeText(buffered);
        this.ctx.logEvent('edit-input-buffered', { length: buffered.length });
      }
      this.ctx.logEvent('edit-begin', {
        pageIndex,
        paragraphId,
        warnings: plan.warnings.map((w) => w.kind),
        planMs: plan.planMs,
      });
    } catch (e) {
      this.handleFailure(e, '편집을 시작하지 못했습니다');
    } finally {
      if (!started) this.buffer?.close();
      this.ctx.patch({ starting: false });
    }
  }

  private isCellParagraph(paragraphId: number): boolean {
    const e = this.ctx.getState().editability;
    return (
      e.status === 'ready' &&
      e.value.paragraphs.some((p) => p.paragraphId === paragraphId && p.cell !== null)
    );
  }

  private showLimits(plan: ParagraphEditPlan): void {
    const details = plan.limits.map((l) => l.detail).filter((d) => d !== '');
    const items = details.length > 0 ? details : plan.limits.map((l) => limitLabel(l.reason));
    this.ctx.patch({
      popover: {
        kind: plan.target.cell || this.isCellParagraph(plan.paragraphId) ? 'cell' : 'paragraph',
        pageIndex: plan.pageIndex,
        paragraphId: plan.paragraphId,
        bbox: plan.target.bbox,
        items: items.length > 0 ? [...new Set(items)] : ['이 문단은 편집할 수 없습니다.'],
      },
    });
  }

  /** getPageEditability 의 사유 코드만으로 팝오버를 띄운다(plan 호출 없이). */
  showReasons(pageIndex: number, paragraphId: number, bbox: Rect, reasons: string[]): void {
    this.ctx.patch({
      popover: {
        pageIndex,
        paragraphId,
        bbox,
        items: reasons.length > 0 ? reasons.map(limitLabel) : ['이 문단은 편집할 수 없습니다.'],
      },
    });
  }

  private handleFailure(e: unknown, prefix: string): void {
    const failure = classifyFailure(e);
    if (failure.kind === 'unimplemented') {
      this.ctx.disable(failure.message);
      this.ctx.logOnce('edit-unavailable', 'edit-unavailable', {
        feature: '문단 편집',
        reason: failure.message,
      });
      return;
    }
    this.ctx.logEvent('edit-error', {
      error: failure.message,
      recovered: failure.kind === 'recovered',
    });
    this.ctx.patch({
      notice:
        failure.kind === 'recovered'
          ? '문서를 복구했습니다. 편집을 다시 시작하세요.'
          : `${prefix}: ${failure.message}`,
    });
  }

  // ── 종료 ─────────────────────────────────────────────────────────────

  private endSession(): void {
    this.session?.dispose();
    this.session = null;
    this.ctx.patch({ session: null });
  }

  /**
   * 초안이 있으면 커밋한다(바깥 클릭·Ctrl+S·쪽 이동). 변경이 없으면 취소와 같다.
   * 편집 모드를 벗어났으면(또는 처음부터 없으면) true, 계속 편집 중이면 false 를 돌려준다.
   */
  commitActive(): Promise<boolean> {
    if (this.paths?.active) return this.paths.commitGesture();
    if (!this.session) return Promise.resolve(true);
    return (this.ending ??= this.doCommit().finally(() => {
      this.ending = null;
    }));
  }

  private async doCommit(): Promise<boolean> {
    const session = this.session;
    if (!session) return true;
    try {
      const out = await session.commit();
      if (out.kind === 'restarted') {
        this.ctx.patch({ notice: '문서를 복구했습니다. 편집을 계속하세요.' });
        return false;
      }
      if (out.kind === 'kept') {
        // 마지막 입력을 초안에 반영하지 못해 커밋하지 않았다. 편집기를 열어 둔다(오류는 편집기 정보 줄에도 보인다).
        this.ctx.patch({ notice: `편집을 반영하지 못했습니다: ${out.error}` });
        return false;
      }
      this.endSession();
      if (out.kind === 'committed') {
        this.ctx.log.recordCommit(out.result);
        this.ctx.patch({ history: out.result.history });
        await this.ctx.invalidatePages([
          ...new Set([session.pageIndex, ...out.result.history.affectedPages]),
        ]);
        this.ctx.logEvent('edit-commit', {
          pageIndex: session.pageIndex,
          edits: out.result.history.edits,
        });
      } else {
        this.ctx.log.recordHistory(out.history);
        this.ctx.patch({ history: out.history });
        this.ctx.repaintPage();
      }
      return true;
    } catch (e) {
      this.handleFailure(e, '편집을 저장하지 못했습니다');
      return false;
    }
  }

  /** 도구 막대 "편집 취소". */
  async cancelActive(): Promise<void> {
    if (await this.paths?.cancelGesture()) return;
    if (this.ending) await this.ending;
    const session = this.session;
    if (!session) return;
    try {
      const history = await session.cancel();
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } catch (e) {
      if (!isWorkerRecovered(e)) {
        this.handleFailure(e, '편집을 취소하지 못했습니다');
        return;
      }
    }
    this.endSession();
    this.ctx.repaintPage();
  }

  // ── 문서 undo/redo ───────────────────────────────────────────────────

  async undo(): Promise<void> {
    await this.step('undo');
  }

  async redo(): Promise<void> {
    await this.step('redo');
  }

  private async step(kind: 'undo' | 'redo'): Promise<void> {
    const state = this.ctx.getState();
    if (this.session || state.starting || state.busy || this.paths?.active) return;
    this.paths?.reset();
    const history = state.history;
    if (history && !(kind === 'undo' ? history.canUndo : history.canRedo)) return;
    this.ctx.patch({ busy: true });
    try {
      const next = await this.ctx.rpc[kind]();
      this.ctx.log.recordHistory(next);
      this.ctx.patch({ history: next });
      await this.ctx.invalidatePages(next.affectedPages);
      this.ctx.logEvent(`edit-${kind}`, { affectedPages: next.affectedPages, edits: next.edits });
    } catch (e) {
      this.handleFailure(e, kind === 'undo' ? '되돌리지 못했습니다' : '다시 실행하지 못했습니다');
    } finally {
      this.ctx.patch({ busy: false });
    }
  }

  // ── 복구 ─────────────────────────────────────────────────────────────

  /**
   * 확장이 Worker 를 새로 만들어 문서를 복구한 뒤 호출한다(계약 D6). 초안 중이었으면 편집기 모델로 같은 문단 초안을
   * 다시 시작하고, 아니면 쪽 캐시를 버린다. 복구 전 undo 이력은 사라지므로 알린다.
   */
  async handleWorkerRecovered(history: EditHistoryState | null): Promise<void> {
    if (history) {
      this.ctx.log.recordHistory(history);
      this.ctx.patch({ history });
    } else {
      this.ctx.patch({ history: null });
    }
    this.ctx.patch({ editability: { status: 'idle' } });
    if (this.paths) {
      const hadGesture = this.paths.active;
      await this.paths.cancelGesture();
      this.paths.reset();
      if (hadGesture) {
        this.ctx.patch({
          notice: '작업 모듈이 중단되어 문서를 복구했습니다. 진행 중이던 패스 편집은 취소했습니다.',
        });
      }
    }
    const session = this.session;
    if (session) {
      try {
        await session.restart();
        this.ctx.patch({
          notice: '작업 모듈이 중단되어 문서를 복구했습니다. 편집 중이던 문단을 다시 열었습니다.',
        });
      } catch (e) {
        this.handleFailure(e, '복구 뒤 편집을 다시 시작하지 못했습니다');
      }
      return;
    }
    this.ctx.patch({
      notice: '작업 모듈이 중단되어 문서를 복구했습니다. 복구 전 되돌리기 이력은 사라졌습니다.',
    });
    const view = this.ctx.currentView();
    if (view) await this.ctx.invalidatePages([view.pageIndex]);
  }
}
