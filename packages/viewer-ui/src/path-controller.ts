/**
 * 벡터 패스 편집 코디네이터(DOM 비의존, M4 계약 4.5): 패스 모델 로드·선택(Shift 다중)·점 편집 모드·편집 동작
 * (끌기·속성·삭제)·편집 가능 표시 토글. `EditController` 가 소유하고 상태는 `EditState.path` 로 전달한다.
 *
 * 편집 동작 하나 = 초안 1개 = 편집 1개(`PathGesture`). 선택만으로는 초안을 열지 않는다(초안은 문서당 1개이므로
 * 선택이 문단 편집을 막지 않게 한다).
 */
import type {
  CommitResult,
  EditHistoryState,
  PageModel,
  PathEdit,
  PathEditPlan,
  Point,
} from '@pdf-editor/shared-types';
import { limitLabel } from './edit-labels.js';
import type { EditContext, EditLoadable } from './edit-controller.js';
import { classifyFailure } from './failure.js';
import { buildCandidates, pickPath, STROKE_HIT_PX, type PathCandidate } from './path-geometry.js';
import {
  PathGesture,
  type PathCommitOutcome,
  type PathGestureView,
  type PathRpc,
} from './path-gesture.js';

/** 서버 갱신을 보내기 전 정지 시간(ms, 계약 4.5). */
export const PATH_DEBOUNCE_MS = 200;

export interface PathSelection {
  pageIndex: number;
  paintSeqs: number[];
  /** 선택 판정(편집 가능 여부·현재 색·두께). 다시 판정하는 동안 이전 값을 유지한다. */
  plan: PathEditPlan | null;
}

export interface PathState {
  /** 선택·점 편집용 패스 모델(includePathSegments). */
  model: EditLoadable<PageModel>;
  selection: PathSelection | null;
  /** 점 편집 모드(선택이 하나일 때만). */
  pointMode: boolean;
  /** 진행 중인 편집 동작. */
  gesture: PathGestureView | null;
  /** 제한 사유 안내(선택한 패스가 편집 불가일 때). */
  note: string[] | null;
}

export function initialPathState(): PathState {
  return {
    model: { status: 'idle' },
    selection: null,
    pointMode: false,
    gesture: null,
    note: null,
  };
}

export interface PathContext extends EditContext {
  pathRpc: PathRpc;
  /** 패스 편집 기능만 영구 비활성화한다("M4 미구현"). */
  disablePath(reason: string): void;
  /** 패스 모델(includePathSegments)을 읽는다. */
  extractPaths(pageIndex: number): Promise<PageModel>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  patchPath(partial: Partial<PathState>): void;
  getPath(): PathState;
}

export class PathController {
  private gesture: PathGesture | null = null;
  private ending: Promise<boolean> | null = null;

  constructor(private readonly ctx: PathContext) {}

  get active(): boolean {
    return this.gesture !== null;
  }

  // ── 모델·후보 ────────────────────────────────────────────────────────

  async ensureModel(pageIndex: number): Promise<void> {
    const cur = this.ctx.getPath().model;
    if ((cur.status === 'ready' || cur.status === 'loading') && cur.pageIndex === pageIndex) return;
    this.ctx.patchPath({ model: { status: 'loading', pageIndex } });
    try {
      const value = await this.ctx.extractPaths(pageIndex);
      if (this.ctx.isStalePage(pageIndex)) {
        this.ctx.patchPath({ model: { status: 'idle' } });
        return;
      }
      this.ctx.patchPath({ model: { status: 'ready', pageIndex, value } });
    } catch (e) {
      const failure = classifyFailure(e);
      this.ctx.logEvent('path-model-error', { pageIndex, error: failure.message });
      this.ctx.patchPath({ model: { status: 'error', pageIndex, message: failure.message } });
    }
  }

  /** 지금 쪽의 선택 후보(모델 + 쪽 판정). 준비되지 않았으면 빈 목록. */
  candidates(pageIndex: number): PathCandidate[] {
    const model = this.ctx.getPath().model;
    const edit = this.ctx.getState().editability;
    if (
      model.status !== 'ready' ||
      model.pageIndex !== pageIndex ||
      edit.status !== 'ready' ||
      edit.pageIndex !== pageIndex
    ) {
      return [];
    }
    return buildCandidates(model.value.paths, edit.value.paths);
  }

  // ── 선택 ─────────────────────────────────────────────────────────────

  /**
   * 점 p(페이지 공간)에서 패스를 고른다. additive(Shift)면 선택에 더하거나 뺀다. 맞는 패스가 없으면
   * (additive 가 아닐 때) 선택을 푼다. 선택된 패스 목록을 돌려준다.
   */
  async selectAt(
    pageIndex: number,
    point: Point,
    cssScale: number,
    additive: boolean,
  ): Promise<number[]> {
    if (this.gesture || this.ctx.getState().session || this.ctx.getState().starting) {
      return this.ctx.getPath().selection?.paintSeqs ?? [];
    }
    await this.ensureModel(pageIndex);
    const hit = pickPath(this.candidates(pageIndex), point, STROKE_HIT_PX / cssScale);
    const cur = this.ctx.getPath().selection;
    const base = cur && cur.pageIndex === pageIndex ? cur.paintSeqs : [];
    let next: number[];
    if (!hit) next = additive ? base : [];
    else if (!additive) next = [hit.paintSeq];
    else
      next = base.includes(hit.paintSeq)
        ? base.filter((s) => s !== hit.paintSeq)
        : [...base, hit.paintSeq];
    if (next.length === 0) {
      this.clear();
      return [];
    }
    this.ctx.patchPath({
      selection: {
        pageIndex,
        paintSeqs: next,
        plan: cur?.pageIndex === pageIndex ? cur.plan : null,
      },
      pointMode: next.length === 1 ? this.ctx.getPath().pointMode : false,
      note: null,
    });
    await this.replan();
    return next;
  }

  /** 선택을 다시 판정한다(선택 직후·편집 뒤 쪽을 다시 읽은 뒤). */
  async replan(): Promise<PathEditPlan | null> {
    const sel = this.ctx.getPath().selection;
    if (!sel) return null;
    try {
      const plan = await this.ctx.pathRpc.planPathEdit(sel.pageIndex, sel.paintSeqs);
      const now = this.ctx.getPath().selection;
      if (
        !now ||
        now.pageIndex !== sel.pageIndex ||
        now.paintSeqs.join() !== sel.paintSeqs.join()
      ) {
        return plan;
      }
      this.ctx.patchPath({
        selection: { ...now, plan },
        note: plan.editable ? null : noteOf(plan),
        pointMode: plan.editable ? this.ctx.getPath().pointMode : false,
      });
      return plan;
    } catch (e) {
      this.handleFailure(e, '패스를 판정하지 못했습니다');
      return null;
    }
  }

  clear(): void {
    const p = this.ctx.getPath();
    if (p.selection || p.pointMode || p.note) {
      this.ctx.patchPath({ selection: null, pointMode: false, note: null });
    }
  }

  dismissNote(): void {
    if (this.ctx.getPath().note) this.ctx.patchPath({ note: null });
  }

  setPointMode(on: boolean): void {
    const sel = this.ctx.getPath().selection;
    const ok = sel !== null && sel.paintSeqs.length === 1 && sel.plan?.editable === true;
    this.ctx.patchPath({ pointMode: on && ok });
  }

  // ── 편집 동작 ────────────────────────────────────────────────────────

  /** 끌기 등 연속 편집을 시작한다. 선택이 편집 가능이 아니거나 다른 편집이 열려 있으면 null. */
  beginGesture(): PathGesture | null {
    const sel = this.ctx.getPath().selection;
    const state = this.ctx.getState();
    if (!sel || !sel.plan || !sel.plan.editable) return null;
    if (this.gesture || state.session || state.starting || state.busy) return null;
    const g = new PathGesture(
      {
        rpc: this.ctx.pathRpc,
        renderScale: () => this.ctx.currentView()?.renderScale ?? 1,
        debounceMs: PATH_DEBOUNCE_MS,
        setTimer: (fn, ms) => this.ctx.setTimer(fn, ms),
        clearTimer: (h) => this.ctx.clearTimer(h),
        log: (event, data) => this.ctx.logEvent(event, data),
        onChange: (v) => {
          if (this.gesture === g) this.ctx.patchPath({ gesture: v });
        },
      },
      sel.pageIndex,
      sel.paintSeqs,
      sel.plan,
      async () => {
        const plan = await this.ctx.pathRpc.planPathEdit(sel.pageIndex, sel.paintSeqs);
        return plan;
      },
    );
    this.gesture = g;
    this.ctx.patchPath({ gesture: g.view() });
    g.ready().catch((e) => {
      if (this.gesture !== g) return;
      this.gesture = null;
      this.ctx.patchPath({ gesture: null });
      this.handleFailure(e, '패스 편집을 시작하지 못했습니다');
    });
    return g;
  }

  /** 놓을 때: 최신 편집을 보내고 커밋한다. 성공하면 true. */
  commitGesture(): Promise<boolean> {
    if (!this.gesture) return Promise.resolve(true);
    return (this.ending ??= this.doCommit().finally(() => {
      this.ending = null;
    }));
  }

  private async doCommit(): Promise<boolean> {
    const g = this.gesture;
    const sel = this.ctx.getPath().selection;
    if (!g || !sel) return true;
    const out: PathCommitOutcome = await g.commit();
    this.gesture = null;
    this.ctx.patchPath({ gesture: null });
    if (out.kind === 'failed') {
      this.ctx.repaintPage();
      this.handleFailure(new Error(out.error), '패스 편집을 반영하지 못했습니다');
      return false;
    }
    if (out.kind === 'cancelled') {
      if (out.history) this.recordHistory(out.history);
      this.ctx.repaintPage();
      return true;
    }
    await this.afterCommit(out.result, sel.pageIndex);
    return true;
  }

  private recordHistory(history: EditHistoryState): void {
    this.ctx.log.recordHistory(history);
    this.ctx.patch({ history });
  }

  private async afterCommit(result: CommitResult, pageIndex: number): Promise<void> {
    this.ctx.log.recordCommit(result);
    this.ctx.patch({ history: result.history });
    const edit = result.op.kind === 'edit-path' ? result.op.edit : null;
    if (edit?.delete) this.clear();
    await this.ctx.invalidatePages([...new Set([pageIndex, ...result.history.affectedPages])]);
    this.ctx.logEvent('path-commit', { pageIndex, edits: result.history.edits });
    if (!edit?.delete) {
      await this.ensureModel(pageIndex);
      await this.replan();
    }
  }

  /** Esc: 진행 중인 동작을 취소한다. 동작이 없으면 false. */
  async cancelGesture(): Promise<boolean> {
    const g = this.gesture;
    if (!g) return false;
    this.gesture = null;
    this.ctx.patchPath({ gesture: null });
    const history = await g.cancel();
    if (history) this.recordHistory(history);
    this.ctx.repaintPage();
    return true;
  }

  /** 속성·삭제처럼 한 번에 끝나는 편집. */
  async applyOnce(edit: PathEdit): Promise<boolean> {
    const g = this.beginGesture();
    if (!g) return false;
    g.update(edit);
    return this.commitGesture();
  }

  async deleteSelected(): Promise<boolean> {
    return this.applyOnce(emptyPathEdit({ delete: true }));
  }

  // ── 편집 가능 표시(D6) ───────────────────────────────────────────────

  setShowEditable(on: boolean): void {
    this.ctx.patch({ showEditable: on });
  }

  // ── 공통 ─────────────────────────────────────────────────────────────

  /** 쪽을 바꾸거나 문서 undo/redo 를 하기 전: 선택·모델을 비운다. */
  reset(): void {
    this.gesture = null;
    this.ctx.patchPath(initialPathState());
  }

  /** 쪽 캐시를 버릴 때: 모델을 다시 읽게 하고 선택은 유지한다(편집 뒤 재판정 대상). */
  invalidateModel(): void {
    this.ctx.patchPath({ model: { status: 'idle' } });
  }

  private handleFailure(e: unknown, prefix: string): void {
    const failure = classifyFailure(e);
    if (failure.kind === 'unimplemented') {
      this.ctx.disablePath(failure.message);
      this.ctx.logOnce('path-unavailable', 'path-unavailable', {
        feature: '벡터 편집',
        reason: failure.message,
      });
      this.clear();
      return;
    }
    this.ctx.logEvent('path-error', {
      error: failure.message,
      recovered: failure.kind === 'recovered',
    });
    this.ctx.patch({
      notice:
        failure.kind === 'recovered'
          ? '문서를 복구했습니다. 패스를 다시 선택하세요.'
          : `${prefix}: ${failure.message}`,
    });
    if (failure.kind === 'recovered') this.clear();
  }
}

export function emptyPathEdit(partial: Partial<PathEdit> = {}): PathEdit {
  return {
    transform: null,
    fill: null,
    stroke: null,
    lineWidth: null,
    points: null,
    delete: false,
    ...partial,
  };
}

function noteOf(plan: PathEditPlan): string[] {
  const items = plan.limits.map((l) => (l.detail !== '' ? l.detail : limitLabel(l.reason)));
  return items.length > 0 ? [...new Set(items)] : ['이 패스는 편집할 수 없습니다.'];
}
