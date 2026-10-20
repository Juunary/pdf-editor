/**
 * 편집 세션 하나(DOM 비의존): 초안 1개의 편집 모델·입력 전송(마지막 입력만)·미리보기 프레임·종료(커밋·취소)·복구 재시작.
 *
 * - 입력은 모델에 즉시 반영하고, Worker 로는 처리 중인 요청이 없을 때만 보낸다. 처리 중이면 마지막 입력만 남긴다(계약 D7).
 * - 캐럿·선택·조합 밑줄·초과 표시는 "마지막으로 처리된 프레임"의 `ReflowSummary` 로 그린다. 프레임은 입력 시점의
 *   텍스트·캐럿과 함께 저장해 캔버스 합성 결과와 어긋나지 않게 한다.
 * - Worker 가 복구되면(`WorkerRecoveredError`) 같은 문단 초안을 편집기 모델(텍스트·모양·형식)로 다시 시작한다(계약 D6).
 */
import type {
  BeginEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditWarning,
  ParagraphEditPlan,
  ParagraphFormat,
  Point,
  PdfWorkerApi,
  RenderedPage,
  ReflowSummary,
} from '@pdf-editor/shared-types';
import { offsetAtPoint, lineBoundary, moveVertical } from './edit-geometry.js';
import {
  EditorModel,
  hasSelection,
  selectedText,
  selectionRange,
  toRuns,
  type Affinity,
  type EditorState,
} from './edit-model.js';
import { nextBoundary, nextWordStart, prevBoundary, prevWordStart } from './edit-text.js';
import { classifyFailure } from './failure.js';

/** 편집 RPC 중 세션이 쓰는 것. */
export type EditRpc = Pick<
  PdfWorkerApi,
  | 'planParagraphEdit'
  | 'beginParagraphEdit'
  | 'updateParagraphDraft'
  | 'commitParagraphEdit'
  | 'cancelParagraphEdit'
>;

/** 화면에 합성한 프레임: 입력 시점의 편집 상태와 그 결과 리플로우. */
export interface ShownFrame {
  seq: number;
  text: string;
  caret: number;
  anchor: number;
  affinity: Affinity;
  composition: [number, number] | null;
  reflow: ReflowSummary;
}

/** 쪽 캔버스에 합성할 변경 영역(렌더 결과). seq 가 바뀌면 다시 합성한다. */
export interface DraftRegion {
  seq: number;
  rendered: RenderedPage;
  /** 이 영역에 반영된 가장 오래된 입력의 시각(performance.now, 반응 시간 측정). */
  t0: number;
}

export interface EditSessionView {
  draftId: string;
  pageIndex: number;
  paragraphId: number;
  plan: ParagraphEditPlan;
  /** 편집 모델(입력 즉시 반영). */
  editor: EditorState;
  shown: ShownFrame;
  format: ParagraphFormat;
  warnings: EditWarning[];
  region: DraftRegion | null;
  /** 보낸 입력의 결과를 기다리는 중. */
  updating: boolean;
  /** 커밋 처리 중. */
  committing: boolean;
  /** 문서 복구 뒤 초안을 다시 시작했다는 안내. */
  notice: string | null;
  /** 마지막 갱신 오류(다음 입력에서 다시 시도). */
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** 시작 상태와 다른지(같으면 커밋 = 취소). */
  dirty: boolean;
}

export interface EditSessionDeps {
  rpc: EditRpc;
  now(): number;
  /** 변경 영역 렌더 배율(뷰어 scale × devicePixelRatio). */
  renderScale(): number;
  log(event: string, data?: unknown): void;
  /** 세션 상태가 바뀔 때마다 호출된다. */
  onChange(view: EditSessionView): void;
}

interface Frame {
  input: DraftInput;
  shown: Omit<ShownFrame, 'reflow'>;
  t0: number;
}

/** 반응 시간 표본 보관 상한(긴 편집에서 무한히 늘지 않게). */
const MAX_LATENCY_SAMPLES = 2000;

const RECOVERED_NOTICE =
  '작업 모듈이 중단되어 문서를 복구했습니다. 편집 중이던 문단을 다시 열었고, 복구 전 되돌리기 이력은 사라졌습니다.';

export function isWorkerRecovered(error: unknown): boolean {
  return classifyFailure(error).kind === 'recovered';
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class EditSession {
  readonly model: EditorModel;
  readonly pageIndex: number;
  readonly paragraphId: number;
  readonly latencies: number[] = [];
  private plan: ParagraphEditPlan;
  private draftId: string;
  private format: ParagraphFormat;
  private shown: ShownFrame;
  private warnings: EditWarning[];
  private region: DraftRegion | null = null;
  private seq = 0;
  private inflight: Promise<void> | null = null;
  private pending: Frame | null = null;
  private pendingT0: number | null = null;
  private waiters: (() => void)[] = [];
  private chain: Promise<void> | null = null;
  private committing = false;
  private closed = false;
  private notice: string | null = null;
  private error: string | null = null;
  private goalX: number | null = null;
  private dragAnchor: number | null = null;
  private restartPromise: Promise<void> | null = null;
  private readonly initialText: string;
  private readonly initialFormat: ParagraphFormat;

  constructor(
    private readonly deps: EditSessionDeps,
    plan: ParagraphEditPlan,
    begin: BeginEditResult,
    caret: number | null,
  ) {
    this.plan = plan;
    this.pageIndex = plan.pageIndex;
    this.paragraphId = plan.paragraphId;
    this.draftId = begin.draftId;
    this.format = plan.format;
    this.initialFormat = plan.format;
    this.model = new EditorModel(plan.runs, {
      now: () => deps.now(),
      ...(caret === null ? {} : { caret }),
    });
    this.initialText = this.model.state.text;
    this.warnings = begin.first.warnings;
    const state = this.model.state;
    this.shown = {
      seq: 0,
      text: state.text,
      caret: state.caret,
      anchor: state.anchor,
      affinity: state.affinity,
      composition: null,
      reflow: begin.first.reflow,
    };
    // R-L1(M4): beginParagraphEdit 에 뷰어 렌더 배율을 넘기므로 첫 영역을 그대로 쓴다(시작 갱신 RPC 없음).
    // seq 0 은 입력이 아니므로 반응 시간 표본에 넣지 않는다(reportPainted).
    this.region = { seq: 0, rendered: begin.first.region, t0: deps.now() };
  }

  /** 세션 시작 알림 자리(첫 영역은 begin 결과로 이미 받았다). 호환을 위해 남긴다. */
  start(): void {
    this.emit();
  }

  /** 지금 상태의 불변 스냅샷. */
  view(): EditSessionView {
    const state = this.model.state;
    return {
      draftId: this.draftId,
      pageIndex: this.pageIndex,
      paragraphId: this.paragraphId,
      plan: this.plan,
      editor: state,
      shown: this.shown,
      format: this.format,
      warnings: this.warnings,
      region: this.region,
      updating: this.inflight !== null || this.pending !== null,
      committing: this.committing,
      notice: this.notice,
      error: this.error,
      canUndo: this.model.history.canUndo,
      canRedo: this.model.history.canRedo,
      dirty: this.isDirty(),
    };
  }

  private emit(): void {
    if (!this.closed) this.deps.onChange(this.view());
  }

  isDirty(): boolean {
    return this.model.state.text !== this.initialText || !sameJson(this.format, this.initialFormat);
  }

  get isComposing(): boolean {
    return this.model.state.composition !== null;
  }

  // ── 입력 전송(마지막 입력만) ─────────────────────────────────────────

  private buildFrame(): Frame {
    const s = this.model.state;
    const t0 = this.pendingT0 ?? this.deps.now();
    return {
      input: {
        runs: toRuns(s),
        format: this.format,
        composition: s.composition,
        renderScale: this.deps.renderScale(),
      },
      shown: {
        seq: ++this.seq,
        text: s.text,
        caret: s.caret,
        anchor: s.anchor,
        affinity: s.affinity,
        composition: s.composition,
      },
      t0,
    };
  }

  /** 모델이 바뀌었을 때 호출한다: 화면 갱신 + 입력 전송 예약. */
  private touch(): void {
    if (this.closed) return;
    this.pendingT0 ??= this.deps.now();
    const frame = this.buildFrame();
    if (this.inflight) {
      this.pending = frame; // 처리 중이면 마지막 입력만 남긴다
      this.emit();
      return;
    }
    this.pendingT0 = null;
    this.inflight = this.drain(frame);
    this.emit();
  }

  /** 선택·캐럿만 바뀐 경우: 리플로우는 그대로이므로 프레임을 새로 보내지 않고 그 프레임의 캐럿만 갱신한다. */
  private touchSelectionOnly(): void {
    const s = this.model.state;
    if (this.inflight || this.pending || s.text !== this.shown.text) {
      this.touch();
      return;
    }
    this.shown = {
      ...this.shown,
      caret: s.caret,
      anchor: s.anchor,
      affinity: s.affinity,
      composition: s.composition,
    };
    this.emit();
  }

  private async drain(first: Frame): Promise<void> {
    try {
      let frame: Frame | null = first;
      while (frame && !this.closed) {
        try {
          const update: DraftUpdate = await this.deps.rpc.updateParagraphDraft(
            this.draftId,
            frame.input,
          );
          if (this.closed) break;
          this.apply(frame, update);
        } catch (e) {
          if (this.closed) break;
          await this.recoverFrom(e);
        }
        frame = this.pending;
        this.pending = null;
        if (frame) this.pendingT0 = null;
      }
    } finally {
      this.inflight = null;
      this.emit();
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  /** 갱신 실패 처리: Worker 복구면 초안을 다시 시작하고, 그 밖의 오류는 표시만 하고 다음 입력에서 다시 시도한다. */
  private async recoverFrom(e: unknown): Promise<void> {
    try {
      if (isWorkerRecovered(e)) {
        await this.restart();
        return;
      }
      const failure = classifyFailure(e);
      this.error = failure.message;
      this.deps.log('edit-update-error', { error: failure.message });
    } catch (re) {
      const failure = classifyFailure(re);
      this.error = failure.message;
      this.deps.log('edit-restart-error', { error: failure.message });
    }
  }

  private apply(frame: Frame, update: DraftUpdate): void {
    this.shown = { ...frame.shown, reflow: update.reflow };
    this.warnings = update.warnings;
    this.error = null;
    this.region = { seq: frame.shown.seq, rendered: update.region, t0: frame.t0 };
    this.emit();
  }

  /** 보낸 입력이 모두 처리될 때까지 기다린다. */
  settle(): Promise<void> {
    if (!this.inflight && !this.pending) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 컴포넌트가 변경 영역을 캔버스에 합성한 직후 호출한다(입력 → 합성 반응 시간 기록, 계약 8.4). */
  reportPainted(seq: number): number | null {
    const region = this.region;
    if (!region || region.seq !== seq || seq === 0) return null;
    const end = this.deps.now();
    const ms = end - region.t0;
    this.latencies.push(ms);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) this.latencies.shift();
    try {
      performance.measure('pe-edit-latency', { start: region.t0, end });
    } catch {
      // 측정 API 를 쓸 수 없는 환경은 배열 기록만 남긴다.
    }
    return ms;
  }

  // ── 순서 보장: 줄 기하가 필요한 동작은 앞선 입력 처리 뒤에 실행한다 ──────

  private run(action: () => void, needsSettle: boolean): void {
    if (!needsSettle && this.chain === null) {
      action();
      return;
    }
    const prev = this.chain ?? Promise.resolve();
    const next: Promise<void> = prev.then(async () => {
      if (needsSettle) await this.settle();
      if (!this.closed) action();
    });
    this.chain = next;
    void next.finally(() => {
      if (this.chain === next) this.chain = null;
    });
  }

  /** 대기 중인 동작이 모두 끝날 때까지. */
  async idle(): Promise<void> {
    while (this.chain) await this.chain;
    await this.settle();
  }

  // ── 텍스트 편집 ──────────────────────────────────────────────────────

  /**
   * 커밋·취소 RPC 처리 중에는 텍스트·형식 입력을 받지 않는다(view.committing 으로 표시). 받으면 모델에만 들어가고
   * core 초안에는 가지 않아 커밋 결과에서 빠진다. 캐럿 이동·선택은 텍스트를 바꾸지 않아 막지 않는다.
   */
  private busy(): boolean {
    return this.committing || this.closed;
  }

  private afterTextChange(changed: boolean): void {
    this.goalX = null;
    if (changed) this.touch();
    else this.touchSelectionOnly();
  }

  typeText(text: string): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.insertText(text)), false);
  }

  paste(text: string): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.paste(text)), false);
  }

  backspace(byWord = false): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.deleteBackward(byWord)), false);
  }

  deleteKey(byWord = false): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.deleteForward(byWord)), false);
  }

  /** 선택 텍스트(복사). */
  copyText(): string {
    return selectedText(this.model.state);
  }

  /** 잘라내기: 선택 텍스트를 돌려주고 지운다. */
  cut(): string {
    if (this.busy()) return '';
    const text = selectedText(this.model.state);
    if (text === '') return '';
    this.run(() => this.afterTextChange(this.model.deleteSelection()), false);
    return text;
  }

  undo(): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.undo()), false);
  }

  redo(): void {
    if (this.busy()) return;
    this.run(() => this.afterTextChange(this.model.redo()), false);
  }

  // ── IME ──────────────────────────────────────────────────────────────

  compositionStart(): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionStart();
      this.goalX = null;
      this.touch();
    }, false);
  }

  compositionUpdate(text: string): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionUpdate(text);
      this.goalX = null;
      this.touch();
    }, false);
  }

  compositionEnd(text?: string): void {
    if (this.busy()) return;
    this.run(() => {
      this.model.compositionEnd(text);
      this.goalX = null;
      this.touch();
    }, false);
  }

  // ── 캐럿 이동(키) ────────────────────────────────────────────────────

  /** 좌우 이동. 선택이 있고 Shift 가 없으면 선택 끝으로 접는다. */
  moveHorizontal(dir: -1 | 1, shift: boolean, byWord: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      if (!shift && hasSelection(s)) {
        const [a, b] = selectionRange(s);
        this.model.moveTo(dir < 0 ? a : b);
      } else {
        const to =
          dir < 0
            ? byWord
              ? prevWordStart(s.text, s.caret)
              : prevBoundary(s.text, s.caret)
            : byWord
              ? nextWordStart(s.text, s.caret)
              : nextBoundary(s.text, s.caret);
        this.model.moveTo(to, shift);
      }
      this.touchSelectionOnly();
    }, false);
  }

  /** 위·아래 줄 이동(리플로우 줄 기준). */
  moveVerticalKey(dir: -1 | 1, shift: boolean): void {
    this.run(() => {
      const s = this.model.state;
      const hit = moveVertical(this.shown.reflow, s.text, s.caret, s.affinity, dir, this.goalX);
      this.model.moveTo(hit.offset, shift, hit.affinity);
      this.goalX = hit.goalX;
      this.touchSelectionOnly();
    }, true);
  }

  /** Home/End. Ctrl 이면 문단 처음·끝. */
  moveLineBoundary(which: 'home' | 'end', shift: boolean, wholeText: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      if (wholeText) {
        this.model.moveTo(which === 'home' ? 0 : s.text.length, shift);
      } else {
        const hit = lineBoundary(this.shown.reflow, s.text, s.caret, s.affinity, which);
        this.model.moveTo(hit.offset, shift, hit.affinity);
      }
      this.touchSelectionOnly();
    }, true);
  }

  selectAll(): void {
    this.run(() => {
      this.goalX = null;
      this.model.selectAll();
      this.touchSelectionOnly();
    }, false);
  }

  // ── 포인터 ───────────────────────────────────────────────────────────

  /** 영역 안 마우스 누름. detail 1 = 캐럿(Shift 면 선택 확장), 2 = 단어, 3 이상 = 전체. */
  pointerDown(point: Point, detail: number, shift: boolean): void {
    this.run(() => {
      const s = this.model.state;
      this.goalX = null;
      const hit = offsetAtPoint(this.shown.reflow, s.text, point);
      if (detail >= 3) {
        this.model.selectAll();
        this.dragAnchor = null;
      } else if (detail === 2) {
        this.model.selectWordAt(hit.offset);
        this.dragAnchor = null;
      } else {
        const anchor = shift ? s.anchor : hit.offset;
        this.model.setSelection(anchor, hit.offset, hit.affinity);
        this.dragAnchor = anchor;
      }
      this.touchSelectionOnly();
    }, true);
  }

  pointerDrag(point: Point): void {
    if (this.dragAnchor === null) return;
    const anchor = this.dragAnchor;
    this.run(() => {
      const s = this.model.state;
      const hit = offsetAtPoint(this.shown.reflow, s.text, point);
      this.model.setSelection(anchor, hit.offset, hit.affinity);
      this.touchSelectionOnly();
    }, true);
  }

  pointerUp(): void {
    this.dragAnchor = null;
  }

  // ── 형식(영역) ───────────────────────────────────────────────────────

  setFormat(patch: Partial<ParagraphFormat>): void {
    if (this.busy()) return;
    this.format = { ...this.format, ...patch };
    this.touch();
  }

  // ── 종료 ─────────────────────────────────────────────────────────────

  /** 조합 중이면 현재 조합 문자열로 확정한다(바깥 클릭·저장 전 커밋, 계약 I8). */
  private finishComposition(): void {
    if (this.model.state.composition) {
      this.model.compositionEnd();
      this.touch();
    }
  }

  /**
   * 커밋. 변경이 없으면 취소와 같다. 결과의 history 는 호출자가 이력·복구 로그에 반영한다.
   * 복구가 일어나 초안을 다시 시작했으면 편집 모드를 유지하고 'restarted' 를 돌려준다.
   */
  async commit(): Promise<
    | { kind: 'committed'; result: CommitResult }
    | { kind: 'cancelled'; history: EditHistoryState }
    | { kind: 'restarted' }
    | { kind: 'kept'; error: string }
  > {
    this.finishComposition();
    this.committing = true;
    this.emit();
    try {
      await this.idle();
      if (!this.isDirty()) {
        const history = await this.cancelRpc();
        return { kind: 'cancelled', history };
      }
      // 마지막 갱신이 실패했거나 마지막 입력이 아직 처리된 프레임이 아니면 core 초안은 화면 텍스트와 다르다. 현재
      // 상태를 다시 보내고 성공해야만 커밋한다(실패하면 편집기를 열어 둔 채 오류를 표시한다).
      if (this.error !== null || this.shown.seq !== this.seq) {
        const sent = await this.resend();
        if (sent === 'restarted') return { kind: 'restarted' };
        if (sent !== 'ok') return { kind: 'kept', error: sent.error };
      }
      try {
        const result = await this.deps.rpc.commitParagraphEdit(this.draftId);
        this.close();
        return { kind: 'committed', result };
      } catch (e) {
        if (!isWorkerRecovered(e)) throw e;
        await this.restart();
        return { kind: 'restarted' };
      }
    } finally {
      this.committing = false;
      this.emit();
    }
  }

  /** 커밋 전 현재 상태 다시 보내기. Worker 복구면 초안을 다시 시작한다. */
  private async resend(): Promise<'ok' | 'restarted' | { error: string }> {
    const frame = this.buildFrame();
    this.pendingT0 = null;
    try {
      const update = await this.deps.rpc.updateParagraphDraft(this.draftId, frame.input);
      if (this.closed) return { error: '편집 세션이 닫혔습니다' };
      this.apply(frame, update);
      return 'ok';
    } catch (e) {
      if (isWorkerRecovered(e)) {
        await this.restart();
        return 'restarted';
      }
      const failure = classifyFailure(e);
      this.error = failure.message;
      this.deps.log('edit-update-error', { error: failure.message, atCommit: true });
      return { error: failure.message };
    }
  }

  /** 취소(도구 막대 "편집 취소"). */
  async cancel(): Promise<EditHistoryState> {
    this.pending = null;
    this.committing = true;
    this.emit();
    try {
      await this.settle();
      return await this.cancelRpc();
    } finally {
      this.committing = false;
    }
  }

  private async cancelRpc(): Promise<EditHistoryState> {
    try {
      const history = await this.deps.rpc.cancelParagraphEdit(this.draftId);
      this.close();
      return history;
    } catch (e) {
      if (!isWorkerRecovered(e)) throw e;
      // 복구된 Worker 에는 초안이 없다. 취소와 같은 상태이므로 세션만 닫는다.
      this.close();
      throw e;
    }
  }

  private close(): void {
    this.closed = true;
    this.pending = null;
  }

  /** 세션을 정리한다(호출자가 이미 종료를 처리한 경우). */
  dispose(): void {
    this.close();
  }

  // ── 복구 ─────────────────────────────────────────────────────────────

  /** 복구된 Worker 에서 같은 문단 초안을 편집기 모델로 다시 시작한다(계약 D6). 동시에 여러 번 불려도 한 번만 한다. */
  restart(): Promise<void> {
    return (this.restartPromise ??= this.doRestart().finally(() => {
      this.restartPromise = null;
    }));
  }

  private async doRestart(): Promise<void> {
    this.notice = RECOVERED_NOTICE;
    const plan = await this.deps.rpc.planParagraphEdit(this.pageIndex, this.paragraphId);
    if (!plan.editable) throw new Error('복구 뒤 같은 문단을 다시 편집할 수 없습니다');
    const begun = await this.deps.rpc.beginParagraphEdit(
      this.pageIndex,
      this.paragraphId,
      plan.revision,
    );
    this.plan = { ...this.plan, revision: plan.revision };
    this.draftId = begun.draftId;
    const frame = this.buildFrame();
    const update = await this.deps.rpc.updateParagraphDraft(this.draftId, frame.input);
    this.apply(frame, update);
    this.deps.log('edit-restarted', { pageIndex: this.pageIndex, paragraphId: this.paragraphId });
  }
}
