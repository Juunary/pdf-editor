/**
 * 문단 편집 엔진(M3, docs/m3-contract.md 4·5.7·D6·D9, docs/m3-core.md). 문서 1개의 저널 작업·편집 로그·초안을 맡고,
 * pdf-ops·reflow 는 `EditAdapter` 로만 부른다. `PdfSession` 이 쪽 캐시와 렌더를 `EditHost` 로 빌려준다.
 *
 * 상태 모델
 * - 저널(MuPDF): 문단 편집 하나 = 작업 하나. 초안 = 열린 작업, 커밋 = `endOperation`, 취소 = `abandonOperation`.
 * - 로그: `base`(replayEdits 로 다시 적용한 것, undo 불가) + `undo` 스택 + `redo` 스택. 저널 단계와 1:1 이다.
 * - 작업이 열린 동안 MuPDF 는 `canUndo()`·`getJournal()` 이 예외라서 이력 질의는 모두 이 상태로 답한다.
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
  saltedFontBytes,
  unionRect,
} from './edit-util.js';
import type { FontManager } from '@pdf-editor/pdf-ops';

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
  /** 폴백 폰트 바이트에 덧붙일 salt 의 다음 값(saltedFontBytes). */
  #salt = 0;

  #journalOn = false;
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
    await this.#ready();
    this.#requireNoDraft('getPageEditability');
    const t0 = performance.now();
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const result = this.#probe(() => this.#adapter.planPageEditability(ctx, fonts));
    return { ...result, revision: this.#revision, ms: performance.now() - t0 };
  }

  async planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan> {
    await this.#ready();
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
      const entry = [...entries].reverse().find((e) => e.op.id === ref.editId);
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
    await this.#ready();
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
      };
      this.#blocks.set(pageIndex, this.#adapter.listEditBlocks(doc, pageIndex));
      this.#host.invalidateAround(pageIndex);
      const clip = inflateRect(
        unionRect(plan.target.bbox, composed.summary.contentBox),
        REGION_MARGIN_PT,
      );
      const region = this.#host.renderRegion(pageIndex, this.#host.renderScale, clip);
      this.#draft = draft;
      return {
        draftId: draft.draftId,
        plan: { ...plan, revision: this.#revision },
        first: {
          draftId: draft.draftId,
          reflow: composed.summary,
          warnings: composed.warnings,
          region,
          updateMs: composed.summary.reflowMs,
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
    const t0 = performance.now();
    const previous = draft.summary.contentBox;
    const composed = this.#compose(
      draft.ctx,
      draft.plan,
      draft.prepared,
      draft.paragraphId,
      input.runs,
      input.format,
    );
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
    this.#doc.endOperation();
    this.#draft = null;
    const op: EditOp = {
      kind: 'replace-paragraph',
      id: draft.opId,
      target: draft.prepared.target,
      runs: draft.runs,
      format: draft.format,
    };
    this.#undo.push({ op, warnings: draft.warnings, summary: draft.summary });
    this.#redo = [];
    this.#revision++;
    this.#touched([draft.pageIndex]);
    return { op, history: this.#history() };
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requireDraft(draftId);
    this.#draft = null;
    this.#doc.abandonOperation();
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
    ensureInfoDictionary(this.#doc);
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
    this.#doc.enableJournal();
    this.#journalOn = true;
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
      structureUnlinked: entries.filter((e) => hasWarning(e, 'tagged-structure-unlinked')).length,
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
   * 저장을 저널 작업으로 감싼다: `beginOperation('save')` → Info 기록·폴백 서브셋 교체 → `fn`(saveToBuffer) →
   * `abandonOperation`. 저장은 저널 단계를 만들지 않고 작업 문서는 저장 전 상태로 남는다. 저널이 꺼진 문서
   * (편집 RPC 를 부른 적 없음)는 감싸지 않는다. 초안이 열려 있으면 예외.
   */
  runSave<T>(fn: () => T): T {
    this.#assertUsable();
    this.#requireNoDraft('save');
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    const entries = this.#active();
    doc.beginOperation('save');
    let result: T;
    try {
      if (entries.length > 0) {
        this.#adapter.recordEditMetadata(doc, {
          pages: [...new Set(entries.map((e) => e.op.target.pageIndex))].sort((a, b) => a - b),
          structureNotUpdated: entries.some(
            (e) =>
              hasWarning(e, 'tagged-structure-kept') || hasWarning(e, 'tagged-structure-unlinked'),
          ),
        });
        this.#fonts?.finalizeForSave();
      }
      result = fn();
    } catch (error) {
      try {
        doc.abandonOperation();
      } catch {
        // 원래 예외를 우선한다.
      }
      throw error;
    }
    doc.abandonOperation();
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
      this.#blocks.set(page, this.#adapter.listEditBlocks(this.#doc, page));
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

  /** 폴백 폰트 바이트 로드 → FontManager → 저널(Info 는 켜기 전에 만든다, D9). 편집 계열 첫 호출에서 한다. */
  async #ready(): Promise<void> {
    await this.#loadFallbackBytes();
    this.#assertUsable();
    this.#ensureFonts();
    if (!this.#journalOn) {
      ensureInfoDictionary(this.#doc);
      this.#doc.enableJournal();
      this.#journalOn = true;
    }
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
    this.#fonts ??= this.#adapter.createFonts(this.#doc, () => {
      if (!this.#fallbackBytes) {
        throw new EditStateError(
          '폴백 폰트가 없습니다(PdfSessionOptions.loadFallbackFont 미설정).',
        );
      }
      return saltedFontBytes(this.#fallbackBytes, this.#salt++);
    });
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
    const doc = this.#doc;
    doc.beginOperation('probe');
    let result: T;
    try {
      result = fn();
    } catch (error) {
      try {
        doc.abandonOperation();
      } catch {
        // 원래 예외를 우선한다.
      }
      throw error;
    }
    doc.abandonOperation();
    return result;
  }

  /** 열린 초안 작업을 버리고 캐시를 되돌린다(begin 실패 경로). */
  #rollback(pageIndex: number): void {
    try {
      this.#doc.abandonOperation();
    } catch {
      // 작업이 열리지 않은 상태에서의 실패.
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
