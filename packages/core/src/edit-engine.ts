/**
 * 문단 편집 엔진(M3, docs/m3-contract.md 4·5.7·D6·D9, docs/m3-core.md). 문서 1개의 저널 작업·편집 로그·초안을 맡고,
 * pdf-ops·reflow 는 `EditAdapter` 로만 부른다. `PdfSession` 이 쪽 캐시와 렌더를 `EditHost` 로 빌려준다.
 *
 * 상태 모델
 * - 저널(MuPDF): 문단 편집 하나 = 작업 하나. 초안 = 열린 작업, 커밋 = `endOperation`, 취소 = `abandonOperation`.
 * - 로그: `base`(replayEdits 로 다시 적용한 것, undo 불가) + `undo` 스택 + `redo` 스택. 저널 단계와 1:1 이다.
 * - 작업이 열린 동안 MuPDF 는 `canUndo()`·`getJournal()` 이 예외라서 이력 질의는 모두 이 상태로 답한다.
 * - MuPDF 는 작업 안에서 객체를 처음 바꾸는 순간 redo 단계를 버리고, 그 작업을 `abandonOperation` 해도 되돌리지 않는다
 *   (docs/m3-core.md 2.4). 그래서 초안을 시작하는 순간과 객체를 바꾼 판정·저장 작업 뒤에 redo 스택을 저널에 맞춘다.
 */
import * as mupdf from 'mupdf';
import type {
  BeginEditResult,
  ChangeKind,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  EditWarning,
  EditedBlock,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
  ParagraphTarget,
  Rect,
  RenderedPage,
  ReflowSummary,
  SaveEditSummary,
  TextRun,
} from '@pdf-editor/shared-types';
import type {
  EditAdapter,
  EditBlockRef,
  ParagraphEditContext,
  PreparedEdit,
} from './edit-adapter.js';
import {
  coreWarnings,
  declaresPdfA,
  ensureInfoDictionary,
  inflateRect,
  mergeWarnings,
  unionRect,
} from './edit-util.js';
import { embedFont, type FallbackFontSource, type FontManager } from '@pdf-editor/pdf-ops';

/** 문서에 임베딩하는 폴백 폰트의 BaseFont 이름(저장 때 서브셋 태그가 붙는다). */
const FALLBACK_FONT_NAME = 'NotoSansKR';

/** 변경 영역 렌더에 더하는 여백(pt). 계약 8.3 의 변경 허용 영역 여백과 같다. */
const REGION_MARGIN_PT = 2;

/** 세션이 편집 엔진에 빌려주는 것. */
export interface EditHost {
  readonly document: mupdf.PDFDocument;
  /** 쪽 캐시 위의 판정 입력(추출 모델·원본 연결·매칭·레이아웃). */
  pageState(pageIndex: number): Pick<ParagraphEditContext, 'model' | 'map' | 'linkage' | 'layout'>;
  /** 그 쪽의 추출·원본 연결·레이아웃 캐시와 ±2쪽 레이아웃 캐시를 비운다(계약 5.7). */
  invalidateAround(pageIndex: number): void;
  renderRegion(pageIndex: number, scale: number, clip: Rect): RenderedPage;
  /** 마지막 쪽 전체 렌더 배율(beginParagraphEdit 첫 미리보기 배율). */
  readonly renderScale: number;
}

export interface EditEngineOptions {
  adapter: EditAdapter;
  loadFallbackFont?: (() => Promise<Uint8Array>) | undefined;
  /** 편집 id·초안 id 생성. 기본 `crypto.randomUUID()`. 테스트에서 고정한다. */
  createId?: (() => string) | undefined;
}

/** 편집 RPC 를 지금 쓸 수 없는 상태(초안 중·열린 문서 없음·재적용 실패 등). */
export class EditStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditStateError';
  }
}

/** `beginParagraphEdit` 의 revision 이 현재와 다르다(오래된 문단 id). */
export class StaleRevisionError extends EditStateError {
  constructor(expected: number, actual: number) {
    super(`문서가 바뀌었습니다(revision ${actual}, 요청 ${expected}). 문단 판정을 다시 하세요.`);
    this.name = 'StaleRevisionError';
  }
}

/** 로그 항목: 커밋된 편집 하나와 그 결과 요약. */
interface LogEntry {
  op: EditOp;
  warnings: EditWarning[];
  summary: ReflowSummary;
}

interface Draft {
  draftId: string;
  pageIndex: number;
  paragraphId: number;
  /** 판정·제거 때의 쪽 상태. 쓰기는 이 시점의 PageModel 인덱스(sourceChar)를 가리킨다. */
  ctx: ParagraphEditContext;
  plan: Omit<ParagraphEditPlan, 'revision'>;
  prepared: PreparedEdit;
  /** 로그에 남길 편집 id. */
  opId: string;
  runs: TextRun[];
  format: ParagraphFormat;
  summary: ReflowSummary;
  warnings: EditWarning[];
  /** 갱신 실패 뒤 직전 상태로 되돌리지 못했다. 취소만 할 수 있다. */
  broken: boolean;
}

interface Composed {
  summary: ReflowSummary;
  warnings: EditWarning[];
}

export class EditEngine {
  readonly #host: EditHost;
  readonly #adapter: EditAdapter;
  readonly #options: EditEngineOptions;
  readonly #doc: mupdf.PDFDocument;

  #fonts: FontManager | null = null;
  #fallbackBytes: Uint8Array | null = null;
  #fallbackLoading: Promise<void> | null = null;
  /** 저널을 켜기 직전(작업 밖)에 한 번 임베딩한 폴백 폰트 객체. 그 전에는 null. */
  #fallbackRef: mupdf.PDFObject | null = null;

  #journalOn = false;
  /** 커밋이나 재적용으로 문서가 한 번이라도 바뀌었다(undo 로 되돌렸어도 true). */
  #edited = false;
  #disposed = false;
  #failure: string | null = null;
  #revision = 0;
  #base: LogEntry[] = [];
  #undo: LogEntry[] = [];
  #redo: LogEntry[] = [];
  #draft: Draft | null = null;
  #blocks = new Map<number, EditBlockRef[]>();
  #lastAffected: number[] = [];
  #pdfa: boolean | null = null;

  constructor(host: EditHost, options: EditEngineOptions) {
    this.#host = host;
    this.#adapter = options.adapter;
    this.#options = options;
    this.#doc = host.document;
  }

  // ---- 상태 질의 ----

  get hasDraft(): boolean {
    return this.#draft !== null;
  }

  /** 편집 RPC 가 저널을 켰다(이후 저장은 D9 감싼 저장). */
  get journalOn(): boolean {
    return this.#journalOn;
  }

  /**
   * 편집이 한 번이라도 문서에 반영됐다(되돌린 뒤에도 true). 증분 구간에는 되돌린 객체의 흔적이 남을 수 있어
   * 이 문서의 저장은 전체 저장이다(D9·A3-9).
   */
  get edited(): boolean {
    return this.#edited;
  }

  /**
   * 저널을 켜면서 문서에 폴백 폰트(저장 때 garbage 가 빼는 미사용 객체)와 Info 가 새로 들어갔다. 증분 저장은 새 객체를
   * 모두 덧붙이므로 이 문서의 저장은 전체 저장이다.
   */
  get hasNewObjects(): boolean {
    return this.#journalOn;
  }

  get revision(): number {
    return this.#revision;
  }

  /** MuPDF 저널 위치·단계(작업이 열려 있으면 null). 테스트·진단용. */
  journalState(): { position: number; steps: string[] } | null {
    if (!this.#journalOn || this.#draft) return null;
    return this.#doc.getJournal();
  }

  dispose(): void {
    this.#disposed = true;
    this.#draft = null;
  }

  // ---- 판정(문서를 바꾸지 않는다) ----

  async getPageEditability(pageIndex: number): Promise<PageEditability> {
    await this.#prepareRead();
    this.#requireNoDraft('getPageEditability');
    const t0 = performance.now();
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const result = this.#probe(() => this.#adapter.planPageEditability(ctx, fonts));
    return { ...result, revision: this.#revision, ms: performance.now() - t0 };
  }

  async planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan> {
    await this.#prepareRead();
    this.#requireNoDraft('planParagraphEdit');
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const plan = this.#probe(() => this.#adapter.planParagraphEdit(ctx, fonts, paragraphId));
    return { ...plan, revision: this.#revision };
  }

  /** 이 쪽의 편집 블록(초안 중이면 초안 블록 포함, 작업 문서 기준). */
  getPageEdits(pageIndex: number): PageEditInfo {
    this.#assertUsable();
    const entries = [...this.#base, ...this.#undo];
    const blocks: EditedBlock[] = [];
    for (const ref of this.#blocksFor(pageIndex)) {
      const draft = this.#draft;
      if (
        draft &&
        draft.pageIndex === pageIndex &&
        draft.prepared.block.objectNumber === ref.objectNumber
      ) {
        blocks.push({
          editId: ref.editId,
          contentBox: draft.summary.contentBox,
          area: draft.summary.area,
        });
        continue;
      }
      // 재편집은 블록 id 를 그대로 둘 수 있다(op.id 는 새로 만든다). 가장 나중 항목을 쓴다.
      const entry = [...entries]
        .reverse()
        .find((e) => e.op.id === ref.editId || e.op.target.editedBlock === ref.editId);
      if (entry) {
        blocks.push({
          editId: ref.editId,
          contentBox: entry.summary.contentBox,
          area: entry.summary.area,
        });
        continue;
      }
      const bounds = this.#adapter.blockBounds(this.#doc, pageIndex, ref.objectNumber);
      if (bounds) blocks.push({ editId: ref.editId, contentBox: bounds, area: bounds });
    }
    return { pageIndex, blocks };
  }

  // ---- 초안 ----

  async beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
  ): Promise<BeginEditResult> {
    await this.#prepareEdit();
    this.#requireNoDraft('beginParagraphEdit');
    if (revision !== this.#revision) throw new StaleRevisionError(revision, this.#revision);
    const doc = this.#doc;
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const plan = this.#probe(() => this.#adapter.planParagraphEdit(ctx, fonts, paragraphId));
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 문단입니다: ${reasons || '사유 없음'}`);
    }
    const editId = this.#newId();
    const t0 = performance.now();
    doc.beginOperation('paragraph-edit');
    try {
      const prepared = this.#adapter.prepareParagraphEdit(ctx, plan, editId);
      const composed = this.#compose(ctx, plan, prepared, paragraphId, plan.runs, plan.format);
      const draft: Draft = {
        draftId: this.#newId(),
        pageIndex,
        paragraphId,
        ctx,
        plan,
        prepared,
        opId: this.#uniqueOpId(prepared.editId, editId),
        runs: plan.runs,
        format: plan.format,
        summary: composed.summary,
        warnings: composed.warnings,
        broken: false,
      };
      this.#blocks.set(pageIndex, this.#adapter.listEditBlocks(doc, pageIndex));
      this.#host.invalidateAround(pageIndex);
      const clip = inflateRect(
        unionRect(plan.target.bbox, composed.summary.contentBox),
        REGION_MARGIN_PT,
      );
      const region = this.#host.renderRegion(pageIndex, this.#host.renderScale, clip);
      this.#draft = draft;
      // 제거·삽입으로 문서를 바꾼 순간 MuPDF 가 redo 단계를 버렸다(취소해도 돌아오지 않는다).
      this.#redo = [];
      return {
        draftId: draft.draftId,
        plan: { ...plan, revision: this.#revision },
        first: {
          draftId: draft.draftId,
          reflow: composed.summary,
          warnings: composed.warnings,
          region,
          updateMs: performance.now() - t0,
        },
      };
    } catch (error) {
      this.#rollback(pageIndex);
      throw error;
    }
  }

  async updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate> {
    this.#assertUsable();
    const draft = this.#requireDraft(draftId);
    if (!(input.renderScale > 0)) throw new RangeError('renderScale 은 0 보다 커야 함');
    if (draft.broken) throw new EditStateError('초안이 손상되어 갱신할 수 없습니다. 취소하세요.');
    const t0 = performance.now();
    const previous = draft.summary.contentBox;
    let composed: Composed;
    try {
      composed = this.#compose(
        draft.ctx,
        draft.plan,
        draft.prepared,
        draft.paragraphId,
        input.runs,
        input.format,
      );
    } catch (error) {
      // 쓰기가 중간에 실패했으면 문서의 블록이 새 내용과 옛 내용 사이에 있을 수 있다. 직전 내용으로 다시 쓰고,
      // 그것도 실패하면 이 초안은 취소만 허용한다(커밋하면 로그와 문서가 달라진다).
      try {
        this.#compose(
          draft.ctx,
          draft.plan,
          draft.prepared,
          draft.paragraphId,
          draft.runs,
          draft.format,
        );
      } catch {
        draft.broken = true;
      }
      this.#host.invalidateAround(draft.pageIndex);
      throw error;
    }
    draft.runs = input.runs;
    draft.format = input.format;
    draft.summary = composed.summary;
    draft.warnings = composed.warnings;
    this.#host.invalidateAround(draft.pageIndex);
    const clip = inflateRect(unionRect(previous, composed.summary.contentBox), REGION_MARGIN_PT);
    const region = this.#host.renderRegion(draft.pageIndex, input.renderScale, clip);
    return {
      draftId,
      reflow: composed.summary,
      warnings: composed.warnings,
      region,
      updateMs: performance.now() - t0,
    };
  }

  async commitParagraphEdit(draftId: string): Promise<CommitResult> {
    this.#assertUsable();
    const draft = this.#requireDraft(draftId);
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
    const op: EditOp = {
      kind: 'replace-paragraph',
      id: draft.opId,
      target: draft.prepared.target,
      runs: draft.runs,
      format: draft.format,
    };
    const entry: LogEntry = { op, warnings: draft.warnings, summary: draft.summary };
    // Info 기록은 이 편집 작업 안에서 한다: 저널에 기록되어 undo·redo 와 함께 움직이고, 저장 작업은 문서를 바꾸지
    // 않아도 된다(바꾸면 redo 단계가 사라진다, docs/m3-core.md 2.4).
    this.#writeMetadata([...this.#active(), entry]);
    this.#doc.endOperation();
    this.#draft = null;
    // 작업이 닫혔는데 저널 단계가 늘지 않았으면(닫기 실패 뒤 다시 닫음 등) 로그와 저널이 어긋난 것이다.
    if (this.#doc.getJournal().position !== this.#undo.length + 1) {
      this.#failure = '커밋한 편집이 저널에 기록되지 않음';
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
    this.#undo.push(entry);
    this.#redo = [];
    this.#edited = true;
    this.#revision++;
    this.#touched([draft.pageIndex]);
    return { op, history: this.#history() };
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requireDraft(draftId);
    this.#draft = null;
    this.#abandonOrFail();
    this.#reconcileRedo();
    this.#touched([draft.pageIndex]);
    return this.#history();
  }

  // ---- undo / redo ----

  async undo(): Promise<EditHistoryState> {
    this.#assertUsable();
    this.#requireNoDraft('undo');
    const entry = this.#undo.pop();
    if (!entry) return this.#unchanged();
    try {
      this.#requireJournal(this.#doc.canUndo(), 'undo');
      this.#doc.undo();
    } catch (error) {
      this.#undo.push(entry);
      throw error;
    }
    this.#redo.push(entry);
    this.#revision++;
    this.#touched([entry.op.target.pageIndex]);
    return this.#history();
  }

  async redo(): Promise<EditHistoryState> {
    this.#assertUsable();
    this.#requireNoDraft('redo');
    const entry = this.#redo.pop();
    if (!entry) return this.#unchanged();
    try {
      this.#requireJournal(this.#doc.canRedo(), 'redo');
      this.#doc.redo();
    } catch (error) {
      this.#redo.push(entry);
      throw error;
    }
    this.#undo.push(entry);
    this.#revision++;
    this.#touched([entry.op.target.pageIndex]);
    return this.#history();
  }

  async getEditHistory(): Promise<EditHistoryState> {
    this.#assertUsable();
    return this.#history();
  }

  // ---- 복구(D6) ----

  /**
   * 새로 연 문서에 로그를 다시 적용한다. 저널을 끈 상태로 적용해 힙을 줄이고, 끝난 뒤 저널을 켠다(적용한 편집은
   * undo 할 수 없다). 편집 RPC 를 한 번도 부르지 않은 세션에서만 쓸 수 있다. 중간에 실패하면 문서가 일부만 바뀐
   * 상태이므로 이 세션의 편집 RPC 는 모두 막고 문서를 다시 열어야 한다.
   */
  async replayEdits(ops: EditOp[]): Promise<EditHistoryState> {
    await this.#loadFallbackBytes();
    this.#assertUsable();
    this.#requireNoDraft('replayEdits');
    if (this.#journalOn || this.#base.length > 0 || this.#undo.length > 0) {
      throw new EditStateError(
        'replayEdits 는 편집 RPC 를 부르기 전, 새로 연 문서에서만 쓸 수 있습니다.',
      );
    }
    const fonts = this.#ensureFonts();
    // 저널이 꺼진 채라 Info 와 폴백 폰트는 기준 문서에 들어간다. 재적용한 글자가 폴백 폰트를 쓰므로 먼저 만든다.
    this.#prepareDocument();
    const pages = new Set<number>();
    for (const [index, op] of ops.entries()) {
      try {
        this.#replayOne(fonts, op);
      } catch (error) {
        this.#failure = `재적용 실패(${index + 1}/${ops.length}번째, 편집 ${op.id})`;
        const reason = error instanceof Error ? error.message : String(error);
        throw new EditStateError(`${this.#failure}: ${reason}`);
      }
      pages.add(op.target.pageIndex);
    }
    if (this.#base.length > 0) {
      try {
        this.#writeMetadata(this.#base);
      } catch (error) {
        this.#failure = '재적용 뒤 메타 기록 실패';
        const reason = error instanceof Error ? error.message : String(error);
        throw new EditStateError(`${this.#failure}: ${reason}`);
      }
    }
    this.#startJournal();
    this.#edited ||= ops.length > 0;
    this.#revision++;
    this.#lastAffected = [...pages].sort((a, b) => a - b);
    return this.#history();
  }

  #replayOne(fonts: FontManager, op: EditOp): void {
    const pageIndex = op.target.pageIndex;
    const ctx = this.#context(pageIndex);
    const paragraphId = findParagraphId(ctx, op.target);
    const plan = this.#adapter.planParagraphEdit(ctx, fonts, paragraphId);
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 문단입니다: ${reasons || '사유 없음'}`);
    }
    const prepared = this.#adapter.prepareParagraphEdit(ctx, plan, op.id);
    const composed = this.#compose(ctx, plan, prepared, paragraphId, op.runs, op.format);
    this.#base.push({ op, warnings: composed.warnings, summary: composed.summary });
    this.#touched([pageIndex], false);
  }

  // ---- 저장(D9) ----

  /** 활성 편집이 있으면 저장 전 요약(5.8), 없으면 null. */
  editSummary(): SaveEditSummary | null {
    const entries = this.#active();
    if (entries.length === 0) return null;
    return {
      pages: [...new Set(entries.map((e) => e.op.target.pageIndex))].sort((a, b) => a - b),
      structureUnlinked: this.#unlinkedBlocks(entries),
      pdfaDeclared: (this.#pdfa ??= declaresPdfA(this.#doc)),
    };
  }

  /** 로그가 더하는 저장 변경 종류(계약 D9). 폴백 폰트를 쓴 활성 편집이 있으면 `font-embed`. */
  changeKinds(): ChangeKind[] {
    const entries = this.#active();
    if (entries.length === 0) return [];
    return entries.some((e) => hasWarning(e, 'font-fallback'))
      ? ['content-stream', 'font-embed']
      : ['content-stream'];
  }

  /**
   * 저장을 저널 작업으로 감싼다: `beginOperation('save')` → 폴백 서브셋 교체 → `fn`(saveToBuffer) →
   * `abandonOperation`. 저장은 저널 단계를 만들지 않고 작업 문서는 저장 전 상태로 남는다. 저널이 꺼진 문서
   * (편집 RPC 를 부른 적 없음)는 감싸지 않는다. 초안이 열려 있으면 예외.
   *
   * 계약 D9 는 Info 기록(`recordEditMetadata`)도 이 작업 안에서 하라고 하지만, 작업 안에서 객체를 바꾸면 MuPDF 가
   * redo 단계를 버리고 abandon 해도 돌아오지 않는다. 그래서 Info 는 커밋 작업 안에서 기록하고
   * (`commitParagraphEdit`), 이 작업은 폴백 폰트를 쓴 활성 편집이 있을 때만(서브셋 교체) 문서를 바꾼다. 그 경우
   * undo 직후의 저장은 redo 를 잃는다(docs/m3-core.md 2.4).
   */
  runSave<T>(fn: () => T): T {
    this.#assertUsable();
    this.#requireNoDraft('save');
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    const usesFallback = this.#active().some((e) => hasWarning(e, 'font-fallback'));
    doc.beginOperation('save');
    let result: T;
    try {
      if (usesFallback) this.#fonts?.finalizeForSave();
      result = fn();
    } catch (error) {
      try {
        this.#abandonOrFail();
      } catch {
        // 원래 예외를 우선한다(세션은 이미 사용 불가로 표시했다).
      }
      this.#reconcileRedo();
      throw error;
    }
    this.#abandonOrFail();
    this.#reconcileRedo();
    return result;
  }

  // ---- 내부 ----

  #active(): LogEntry[] {
    return [...this.#base, ...this.#undo];
  }

  #history(): EditHistoryState {
    return {
      revision: this.#revision,
      activeEditIds: this.#active().map((e) => e.op.id),
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      edits: this.#base.length + this.#undo.length,
      affectedPages: [...this.#lastAffected],
    };
  }

  /** 할 일이 없는 undo/redo: 문서도 revision 도 바꾸지 않는다. */
  #unchanged(): EditHistoryState {
    this.#lastAffected = [];
    return this.#history();
  }

  /** 문서가 바뀐 쪽의 캐시·블록 목록을 갱신한다(계약 5.7). */
  #touched(pages: number[], affected = true): void {
    for (const page of pages) {
      this.#host.invalidateAround(page);
      try {
        this.#blocks.set(page, this.#adapter.listEditBlocks(this.#doc, page));
      } catch {
        // 문서와 로그는 이미 바뀌었다. 목록은 다음에 쓸 때 다시 만든다.
        this.#blocks.delete(page);
      }
    }
    if (affected) this.#lastAffected = [...pages].sort((a, b) => a - b);
  }

  #requireJournal(ok: boolean, what: string): void {
    if (!ok) throw new EditStateError(`로그와 MuPDF 저널이 어긋남: ${what} 불가`);
  }

  #newId(): string {
    return (this.#options.createId ?? (() => crypto.randomUUID()))();
  }

  #uniqueOpId(preferred: string | undefined, fallback: string): string {
    const taken = new Set([...this.#base, ...this.#undo, ...this.#redo].map((e) => e.op.id));
    return preferred && !taken.has(preferred) ? preferred : fallback;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new EditStateError('문서가 닫혔습니다.');
    if (this.#failure) {
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
  }

  #requireNoDraft(what: string): void {
    if (this.#draft) {
      throw new EditStateError(
        `편집 초안이 열려 있어 ${what} 를 할 수 없습니다. 먼저 커밋하거나 취소하세요.`,
      );
    }
  }

  #requireDraft(draftId: string): Draft {
    const draft = this.#draft;
    if (!draft || draft.draftId !== draftId) {
      throw new EditStateError(`열린 초안이 아닙니다: ${draftId}`);
    }
    return draft;
  }

  #requireFonts(): FontManager {
    if (!this.#fonts) throw new EditStateError('편집 준비가 되지 않았습니다.');
    return this.#fonts;
  }

  /**
   * 판정 RPC 의 준비: 폴백 폰트 바이트 로드 → FontManager. 문서를 바꾸지 않고 저널도 켜지 않는다. 이 단계의
   * `FallbackFontSource.ref()` 는 null 이다(계약 5.7).
   */
  async #prepareRead(): Promise<void> {
    await this.#loadFallbackBytes();
    this.#assertUsable();
    this.#ensureFonts();
  }

  /**
   * 첫 `beginParagraphEdit` 의 준비: 판정 준비 → Info 사전·폴백 폰트 임베딩(저널 밖, 한 번) → 저널 켜기. 저널 밖에서
   * 만든 객체는 편집 취소·undo 로 사라지지 않는다(계약 D4·D9 수정 1, docs/m3-core.md 2.2·2.3).
   */
  async #prepareEdit(): Promise<void> {
    await this.#prepareRead();
    if (this.#journalOn) return;
    this.#prepareDocument();
    this.#startJournal();
  }

  /** 저널을 켜기 전(작업 밖)에 한 번: Info 사전 생성, 폴백 폰트 임베딩. */
  #prepareDocument(): void {
    ensureInfoDictionary(this.#doc);
    if (!this.#fallbackRef && this.#fallbackBytes) {
      const { ref } = embedFont(this.#doc, FALLBACK_FONT_NAME, this.#fallbackBytes);
      // 폰트 사전 표지: 문서 안에서 폴백 폰트를 알아본다(저장 파일에서는 서브셋으로 바뀐다).
      ref.put('PdfEditorFallback', this.#doc.newBoolean(true));
      this.#fallbackRef = ref;
    }
  }

  #startJournal(): void {
    this.#doc.enableJournal();
    this.#journalOn = true;
  }

  async #loadFallbackBytes(): Promise<void> {
    const load = this.#options.loadFallbackFont;
    if (this.#fallbackBytes || !load) return;
    const pending = (this.#fallbackLoading ??= load().then((bytes) => {
      this.#fallbackBytes = bytes;
    }));
    try {
      await pending;
    } finally {
      if (this.#fallbackLoading === pending) this.#fallbackLoading = null;
    }
  }

  #ensureFonts(): FontManager {
    const source: FallbackFontSource = {
      bytes: () => {
        if (!this.#fallbackBytes) {
          throw new EditStateError(
            '폴백 폰트가 없습니다(PdfSessionOptions.loadFallbackFont 미설정).',
          );
        }
        return this.#fallbackBytes;
      },
      ref: () => this.#fallbackRef,
    };
    this.#fonts ??= this.#adapter.createFonts(this.#doc, source);
    return this.#fonts;
  }

  #context(pageIndex: number): ParagraphEditContext {
    return {
      doc: this.#doc,
      pageIndex,
      ...this.#host.pageState(pageIndex),
      editBlocks: this.#blocksFor(pageIndex),
    };
  }

  #blocksFor(pageIndex: number): EditBlockRef[] {
    let blocks = this.#blocks.get(pageIndex);
    if (!blocks) {
      blocks = this.#adapter.listEditBlocks(this.#doc, pageIndex);
      this.#blocks.set(pageIndex, blocks);
    }
    return blocks;
  }

  /**
   * 판정 호출을 버리는 작업으로 감싼다. 판정은 문서를 바꾸지 않아야 하지만, 폰트 배정이 폴백 폰트를 넣는 등의
   * 변경을 하더라도 저널이 켜진 문서에서 작업 밖 변경은 예외이고, 변경이 남으면 undo 단계가 어긋난다.
   */
  #probe<T>(fn: () => T): T {
    // 저널이 꺼진 동안(첫 `beginParagraphEdit` 전)에는 문서를 바꿀 수 없으므로 감쌀 필요가 없다.
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    doc.beginOperation('probe');
    let result: T;
    try {
      result = fn();
    } catch (error) {
      try {
        this.#abandonOrFail();
      } catch {
        // 원래 예외를 우선한다(세션은 이미 사용 불가로 표시했다).
      }
      this.#reconcileRedo();
      throw error;
    }
    this.#abandonOrFail();
    this.#reconcileRedo();
    return result;
  }

  /** 열린 작업을 버린다. 버리지 못하면 작업이 열린 채 남아 이후 작업이 겹치므로 세션을 쓸 수 없는 상태로 둔다. */
  #abandonOrFail(): void {
    try {
      this.#doc.abandonOperation();
    } catch (error) {
      this.#failure = '저널 작업을 버리지 못함';
      throw error;
    }
  }

  /** 구조 연결이 끊긴 편집 문단 수: 같은 블록을 다시 편집한 항목은 마지막 하나만 센다(계약 5.8). */
  #unlinkedBlocks(entries: LogEntry[]): number {
    const byId = new Map(entries.map((e) => [e.op.id, e]));
    const rootOf = (e: LogEntry): string => {
      let cur = e;
      const seen = new Set<string>();
      while (cur.op.target.editedBlock && !seen.has(cur.op.id)) {
        seen.add(cur.op.id);
        const parent = byId.get(cur.op.target.editedBlock);
        if (!parent) return cur.op.target.editedBlock;
        cur = parent;
      }
      return cur.op.id;
    };
    const latest = new Map<string, LogEntry>();
    for (const e of entries) latest.set(rootOf(e), e);
    return [...latest.values()].filter((e) => hasWarning(e, 'tagged-structure-unlinked')).length;
  }

  /**
   * MuPDF 가 redo 단계를 버렸으면(작업 안에서 객체를 바꾼 뒤 abandon) core 의 redo 스택도 비운다. 작업이 열려 있지
   * 않을 때만 부른다.
   */
  #reconcileRedo(): void {
    if (this.#redo.length > 0 && !this.#doc.canRedo()) this.#redo = [];
  }

  /** 활성 편집(재적용 포함)으로 Info `/PdfEditorEdits` 를 기록한다(계약 5.6). 열린 작업 안이나 저널이 꺼진 때 부른다. */
  #writeMetadata(entries: LogEntry[]): void {
    this.#adapter.recordEditMetadata(this.#doc, {
      pages: [...new Set(entries.map((e) => e.op.target.pageIndex))].sort((a, b) => a - b),
      structureNotUpdated: entries.some(
        (e) => hasWarning(e, 'tagged-structure-kept') || hasWarning(e, 'tagged-structure-unlinked'),
      ),
    });
  }

  /** 열린 초안 작업을 버리고 캐시를 되돌린다(begin 실패 경로). */
  #rollback(pageIndex: number): void {
    try {
      this.#abandonOrFail();
      this.#reconcileRedo();
    } catch {
      // 원래 예외를 우선한다(세션은 이미 사용 불가로 표시했다).
    }
    this.#draft = null;
    this.#host.invalidateAround(pageIndex);
    this.#blocks.delete(pageIndex);
  }

  /** 폰트 배정 → 리플로우 → 편집 블록 쓰기. 초안·재적용 공통. 열린 저널 작업(또는 저널 꺼짐) 안에서 부른다. */
  #compose(
    ctx: ParagraphEditContext,
    plan: Omit<ParagraphEditPlan, 'revision'>,
    prepared: PreparedEdit,
    paragraphId: number,
    runs: TextRun[],
    format: ParagraphFormat,
  ): Composed {
    const fonts = this.#requireFonts();
    const text = runs.map((r) => r.text).join('');
    const { segments, warnings: fontWarnings } = fonts.assign(ctx, text, runs);
    const result = this.#adapter.layoutParagraph({
      text,
      segments,
      format,
      areaLimit: plan.areaLimit,
    });
    this.#adapter.writeEditBlock(ctx, prepared, runs, format, result, fonts);
    const warnings = mergeWarnings(
      plan.warnings,
      fontWarnings,
      coreWarnings({
        summary: result.summary,
        areaLimit: plan.areaLimit,
        layout: ctx.layout,
        paragraphId,
        originalBox: plan.target.bbox,
      }),
    );
    return { summary: result.summary, warnings };
  }
}

function hasWarning(entry: LogEntry, kind: EditWarning['kind']): boolean {
  return entry.warnings.some((w) => w.kind === kind);
}

/**
 * 로그의 대상 글리프 목록(glyphSeq)과 같은 문단을 현재 쪽 레이아웃에서 찾는다. 재적용은 같은 순서로 하므로
 * 적용 시점의 PageModel 이 같고 글리프 목록이 일치해야 한다(계약 `ParagraphTarget`).
 */
export function findParagraphId(ctx: ParagraphEditContext, target: ParagraphTarget): number {
  const wanted = target.glyphSeqs;
  if (wanted.length > 0) {
    for (const paragraph of ctx.layout.paragraphs) {
      if (paragraph.chars.length !== wanted.length) continue;
      if (paragraph.chars.every((ci, k) => ctx.model.chars[ci]?.glyphSeq === wanted[k])) {
        return paragraph.id;
      }
    }
  }
  throw new EditStateError(
    `재적용 대상 문단을 찾지 못함(${ctx.pageIndex + 1}쪽, 글리프 ${wanted.length}개)`,
  );
}
