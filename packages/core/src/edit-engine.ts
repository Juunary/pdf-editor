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
  BeginPathEditResult,
  ChangeKind,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  EditPathOp,
  ReplaceParagraphOp,
  EditWarning,
  EditedBlock,
  PageEditInfo,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
  ParagraphTarget,
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
  PathEditability,
  PathTarget,
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
  PathWriteResult,
  PreparedPathEdit,
} from './edit-adapter.js';
import {
  coreWarnings,
  declaresPdfA,
  ensureInfoDictionary,
  inflateRect,
  mergeWarnings,
  pathCoreWarnings,
  tagFallbackSubset,
  unionRect,
} from './edit-util.js';
import { embedFont, type FallbackFontSource, type FontManager } from '@pdf-editor/pdf-ops';

/** 문서에 임베딩하는 폴백 폰트의 BaseFont 이름(저장 때 서브셋 태그가 붙는다). */
const FALLBACK_FONT_NAME = 'NotoSansKR';

/** 변경 없음 편집: 갱신 쓰기가 실패했고 직전 편집이 없을 때 원 바이트로 되돌리는 데 쓴다. */
const IDENTITY_PATH_EDIT: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};

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

/** 편집 블록을 다시 편집한 문단 편집의 원 블록 id. 패스 편집은 null. */
function editedBlockOf(op: EditOp): string | null {
  return op.kind === 'replace-paragraph' ? op.target.editedBlock : null;
}

/** 로그 항목: 커밋된 편집 하나와 그 결과. `op.kind` 로 갈린다(docs/m4-contract.md 4.4). */
interface ParagraphLogEntry {
  op: ReplaceParagraphOp;
  warnings: EditWarning[];
  summary: ReflowSummary;
  /** 편집 블록에 폴백 폰트 글리프를 실제로 썼다(공백만 폴백이어도, 경고 유무와 별개). 저장 서브셋·font-embed 기준. */
  usesFallback: boolean;
}

/** 패스 편집 항목: 편집 블록·리플로우가 없어 `summary` 도 폴백 폰트 사용도 없다. */
interface PathLogEntry {
  op: EditPathOp;
  warnings: EditWarning[];
}

type LogEntry = ParagraphLogEntry | PathLogEntry;

function isParagraphEntry(entry: LogEntry): entry is ParagraphLogEntry {
  return entry.op.kind === 'replace-paragraph';
}

const usesFallbackOf = (entry: LogEntry): boolean => isParagraphEntry(entry) && entry.usesFallback;

/** 편집이 바꾸는 쪽. 지금은 둘 다 한 쪽이다. undo·redo 의 캐시 무효화·메타 기록이 쓴다. */
const pagesOf = (op: EditOp): number[] => [op.target.pageIndex];

interface ParagraphDraft {
  kind: 'paragraph';
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
  usesFallback: boolean;
  /** 갱신 실패 뒤 직전 상태로 되돌리지 못했다. 취소만 할 수 있다. */
  broken: boolean;
}

/**
 * 패스 초안. 쓰기는 항상 원본 바이트 기준 절대 편집이라 갱신은 직전 상태와 무관하게 다시 쓴다.
 * 시작할 때 `#redo` 를 비우고(MuPDF 가 첫 변경에서 redo 를 버린다) 백업을 둬, 변경 없이 취소하면 되살린다.
 */
interface PathDraft {
  kind: 'path';
  draftId: string;
  pageIndex: number;
  ctx: ParagraphEditContext;
  plan: Omit<PathEditPlan, 'revision'>;
  prepared: PreparedPathEdit;
  opId: string;
  /** 마지막으로 쓴 편집. 아직 쓰지 않았으면 null(커밋 불가). */
  edit: PathEdit | null;
  /** 마지막으로 쓴 뒤의 패스 상자(처음에는 대상 상자). 다음 갱신의 "편집 전" 상자. */
  bbox: Rect;
  warnings: EditWarning[];
  broken: boolean;
  redoBackup: LogEntry[];
}

type Draft = ParagraphDraft | PathDraft;

interface Composed {
  summary: ReflowSummary;
  warnings: EditWarning[];
  usesFallback: boolean;
}

export class EditEngine {
  readonly #host: EditHost;
  readonly #adapter: EditAdapter;
  readonly #options: EditEngineOptions;
  readonly #doc: mupdf.PDFDocument;

  #fonts: FontManager | null = null;
  #fallbackBytes: Uint8Array | null = null;
  #fallbackLoading: Promise<void> | null = null;
  /** 폴백 폰트 로드가 실패한 적이 있고 아직 못 얻었다(R-L5). 폴백 없이 진행한다. */
  #fallbackLoadError: string | null = null;
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

  /**
   * 폴백 폰트 로드 실패 사유(R-L5). 성공했거나 시도하지 않았으면 null. 실패하면 편집은 폴백 없이 진행하고 원본 폰트에 없는
   * 글자만 `glyph-missing` 이 된다. 저널이 켜진 뒤에는 폴백 폰트를 문서에 넣을 수 없어 다시 시도하지 않는다.
   */
  get fallbackLoadError(): string | null {
    return this.#fallbackLoadError;
  }

  /** MuPDF 저널 위치·단계(작업이 열려 있으면 null). 테스트·진단용. */
  journalState(): { position: number; steps: string[] } | null {
    if (!this.#journalOn || this.#draft) return null;
    return this.#doc.getJournal();
  }

  /**
   * 문서를 닫을 때(세션 close). pdf-ops 초안 상태와 FontManager(원본 폰트 탐침·폴백 `mupdf.Font`)를 해제한다(R-L3).
   * 여러 번 불러도 된다.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#draft = null;
    this.#releaseDraftState();
    this.#disposeFonts();
  }

  /**
   * pdf-ops 초안 상태(WriteContext·패스 준비 상태)를 버린다. 문서당 초안은 하나라 초안이 끝날 때(커밋·취소·실패 정리)와
   * 재적용 뒤에 이 문서의 상태 전부를 버린다. 정리 실패는 편집 결과에 영향이 없어 삼킨다.
   */
  #releaseDraftState(): void {
    try {
      this.#adapter.releaseEdit(this.#doc);
    } catch {
      // 참조만 끊는 정리라 실패해도 다음 동작에 영향이 없다.
    }
  }

  #disposeFonts(): void {
    const fonts = this.#fonts;
    this.#fonts = null;
    try {
      fonts?.dispose();
    } catch {
      // 해제 실패는 무시한다(이미 해제됨 등).
    }
  }

  // ---- 판정(문서를 바꾸지 않는다) ----

  async getPageEditability(pageIndex: number): Promise<PageEditability> {
    await this.#prepareRead();
    this.#requireNoDraft('getPageEditability');
    const t0 = performance.now();
    const ctx = this.#context(pageIndex);
    const fonts = this.#requireFonts();
    const result = this.#probe(() => {
      const page = this.#adapter.planPageEditability(ctx, fonts);
      const paths = this.#planPaths(ctx);
      return { ...page, ...paths };
    });
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

  /**
   * 쪽의 패스 판정 목록(어댑터 결과). 패스 판정 오류는 이 쪽의 패스 편집만 막는다: 빈 목록과 진단 문자열
   * (`pathError`)을 돌려주고 문단 판정은 그대로 둔다(리뷰 M4).
   */
  #planPaths(ctx: ParagraphEditContext): { paths: PathEditability[]; pathError?: string } {
    try {
      return { paths: this.#adapter.planPathEditability(ctx) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { paths: [], pathError: message };
    }
  }


  /**
   * 이 쪽의 편집 블록 목록(작업 문서 기준, 쪽마다 캐시). 레이아웃 복원 힌트(docs/m3-integration.md 9.6)용.
   * 목록을 만들지 못하면 빈 목록(힌트 없이 보통 레이아웃).
   */
  editBlocks(pageIndex: number): EditBlockRef[] {
    try {
      return this.#blocksFor(pageIndex);
    } catch {
      return [];
    }
  }

  /** 이 쪽의 편집 블록(초안 중이면 초안 블록 포함, 작업 문서 기준). */
  getPageEdits(pageIndex: number): PageEditInfo {
    this.#assertUsable();
    const entries = [...this.#base, ...this.#undo];
    const blocks: EditedBlock[] = [];
    for (const ref of this.#blocksFor(pageIndex)) {
      const draft = this.#draft;
      if (
        draft?.kind === 'paragraph' &&
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
        .filter(isParagraphEntry)
        .find((e) => e.op.id === ref.editId || editedBlockOf(e.op) === ref.editId);
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
    renderScale?: number,
  ): Promise<BeginEditResult> {
    if (renderScale !== undefined && !(renderScale > 0)) {
      throw new RangeError('renderScale 은 0 보다 커야 함');
    }
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
      const draft: ParagraphDraft = {
        kind: 'paragraph',
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
        usesFallback: composed.usesFallback,
        broken: false,
      };
      this.#blocks.set(pageIndex, this.#adapter.listEditBlocks(doc, pageIndex));
      this.#host.invalidateAround(pageIndex);
      const clip = inflateRect(
        unionRect(plan.target.bbox, composed.summary.contentBox),
        REGION_MARGIN_PT,
      );
      const region = this.#host.renderRegion(
        pageIndex,
        renderScale ?? this.#host.renderScale,
        clip,
      );
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
    const draft = this.#requireParagraphDraft(draftId);
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
    draft.usesFallback = composed.usesFallback;
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
    const draft = this.#requireParagraphDraft(draftId);
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
    const op: ReplaceParagraphOp = {
      kind: 'replace-paragraph',
      id: draft.opId,
      target: draft.prepared.target,
      runs: draft.runs,
      format: draft.format,
    };
    const entry: ParagraphLogEntry = {
      op,
      warnings: draft.warnings,
      summary: draft.summary,
      usesFallback: draft.usesFallback,
    };
    // Info 기록은 이 편집 작업 안에서 한다: 저널에 기록되어 undo·redo 와 함께 움직이고, 저장 작업은 문서를 바꾸지
    // 않아도 된다(바꾸면 redo 단계가 사라진다, docs/m3-core.md 2.4).
    this.#writeMetadata([...this.#active(), entry]);
    this.#doc.endOperation();
    this.#draft = null;
    this.#releaseDraftState();
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

  // ---- M4 패스 편집(docs/m4-contract.md 4.4) ----

  /** 선택한 패스의 편집 계획. 문서를 바꾸지 않는다(저널이 켜졌으면 버리는 작업으로 감싼다). */
  async planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan> {
    this.#assertUsable();
    this.#requireNoDraft('planPathEdit');
    const ctx = this.#context(pageIndex);
    const plan = this.#probe(() => this.#adapter.planPathEdit(ctx, paintSeqs));
    return { ...plan, revision: this.#revision };
  }

  async beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult> {
    // 첫 편집 계열 호출이 패스여도 폴백 폰트를 저널을 켜기 전에 임베딩해야 이후 문단 편집이 쓸 수 있다.
    await this.#prepareEdit();
    this.#requireNoDraft('beginPathEdit');
    if (revision !== this.#revision) throw new StaleRevisionError(revision, this.#revision);
    const doc = this.#doc;
    const ctx = this.#context(pageIndex);
    const plan = this.#probe(() => this.#adapter.planPathEdit(ctx, paintSeqs));
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 패스입니다: ${reasons || '사유 없음'}`);
    }
    const editId = this.#newId();
    const redoBackup = this.#redo;
    doc.beginOperation('path-edit');
    try {
      const prepared = this.#adapter.preparePathEdit(ctx, plan, editId);
      const draft: PathDraft = {
        kind: 'path',
        draftId: this.#newId(),
        pageIndex,
        ctx,
        plan,
        prepared,
        opId: this.#uniqueOpId(prepared.editId, editId),
        edit: null,
        bbox: plan.target.bbox,
        warnings: [...plan.warnings],
        broken: false,
        redoBackup,
      };
      this.#host.invalidateAround(pageIndex);
      this.#draft = draft;
      // 준비·첫 쓰기가 문서를 바꾸면 MuPDF 가 redo 단계를 버린다. 변경 없이 취소하면 되살린다(`#cancelPath`).
      this.#redo = [];
      return { draftId: draft.draftId, plan: { ...plan, revision: this.#revision } };
    } catch (error) {
      this.#rollback(pageIndex);
      throw error;
    }
  }

  /**
   * 편집 내용을 스트림에 다시 쓰고(작업 안, 원본 기준 절대 편집이라 반복 호출 가능) 변경 영역(직전 쓴 상자 ∪ 새 상자)을
   * 렌더한다. 첫 갱신의 직전 상자는 대상 상자다.
   */
  async updatePathDraft(
    draftId: string,
    edit: PathEdit,
    renderScale: number,
  ): Promise<PathDraftUpdate> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    if (!(renderScale > 0)) throw new RangeError('renderScale 은 0 보다 커야 함');
    if (draft.broken) throw new EditStateError('초안이 손상되어 갱신할 수 없습니다. 취소하세요.');
    const t0 = performance.now();
    const previous = draft.bbox;
    let written: ReturnType<EditAdapter['writePathEdit']>;
    try {
      written = this.#adapter.writePathEdit(draft.ctx, draft.prepared, edit);
    } catch (error) {
      // 쓰기가 중간에 실패했으면 스트림이 새 내용과 옛 내용 사이에 있을 수 있다. 직전 편집(없으면 변경 없음 상태)을
      // 다시 써 되돌리고, 그것도 실패하면 이 초안은 취소만 허용한다(커밋하면 로그와 문서가 달라진다).
      try {
        if (draft.edit) this.#adapter.writePathEdit(draft.ctx, draft.prepared, draft.edit);
        else this.#adapter.writePathEdit(draft.ctx, draft.prepared, IDENTITY_PATH_EDIT);
      } catch {
        draft.broken = true;
      }
      this.#host.invalidateAround(draft.pageIndex);
      throw error;
    }
    draft.edit = edit;
    draft.bbox = written.bbox;
    draft.warnings = pathWarnings(draft.plan, edit, draft.ctx, written);
    this.#host.invalidateAround(draft.pageIndex);
    const clip = inflateRect(unionRect(previous, written.bbox), REGION_MARGIN_PT);
    const region = this.#host.renderRegion(draft.pageIndex, renderScale, clip);
    return {
      draftId,
      target: draft.prepared.target,
      bbox: written.bbox,
      warnings: draft.warnings,
      region,
      updateMs: performance.now() - t0,
    };
  }

  async commitPathEdit(draftId: string): Promise<CommitResult> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    if (draft.broken) throw new EditStateError('초안이 손상되어 커밋할 수 없습니다. 취소하세요.');
    if (!draft.edit) {
      throw new EditStateError('적용된 변경이 없어 커밋할 수 없습니다. 취소하세요.');
    }
    const op: EditPathOp = {
      kind: 'edit-path',
      id: draft.opId,
      target: draft.prepared.target,
      edit: draft.edit,
    };
    const entry: PathLogEntry = { op, warnings: draft.warnings };
    this.#writeMetadata([...this.#active(), entry]);
    this.#doc.endOperation();
    this.#draft = null;
    this.#releaseDraftState();
    if (this.#doc.getJournal().position !== this.#undo.length + 1) {
      this.#failure = '커밋한 편집이 저널에 기록되지 않음';
      throw new EditStateError(`${this.#failure}. 문서를 다시 열어야 합니다.`);
    }
    this.#undo.push(entry);
    this.#redo = [];
    this.#edited = true;
    this.#revision++;
    this.#touched(pagesOf(op));
    return { op, history: this.#history() };
  }

  async cancelPathEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requirePathDraft(draftId);
    this.#draft = null;
    this.#releaseDraftState();
    this.#abandonOrFail();
    // 작업을 버린 뒤에도 MuPDF 에 redo 가 남아 있으면(문서를 바꾸지 않았으면) core 의 redo 도 되살린다.
    this.#redo = this.#doc.canRedo() ? draft.redoBackup : [];
    this.#touched([draft.pageIndex]);
    return this.#history();
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    this.#assertUsable();
    const draft = this.#requireParagraphDraft(draftId);
    this.#draft = null;
    this.#releaseDraftState();
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
    this.#touched(pagesOf(entry.op));
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
    this.#touched(pagesOf(entry.op));
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
      for (const page of pagesOf(op)) pages.add(page);
      this.#releaseDraftState();
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
    if (op.kind === 'edit-path') {
      this.#replayPath(op);
      return;
    }
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
    this.#base.push({
      op,
      warnings: composed.warnings,
      summary: composed.summary,
      usesFallback: composed.usesFallback,
    });
    this.#touched([pageIndex], false);
  }

  /**
   * 패스 편집 재적용(계약 4.4): 대상은 `paintSeq` 로 찾고 지문(칠하기 연산 이름·구성 연산 수·상자·구성 연산 해시)이 맞아야
   * 한다. 안 맞으면 다른 패스를 고치지 않고 실패한다. paintSeq 는 적용 시점 모델 기준이라 로그 순서대로 적용할 때만 유효하다.
   */
  #replayPath(op: EditPathOp): void {
    const pageIndex = op.target.pageIndex;
    const ctx = this.#context(pageIndex);
    const plan = this.#adapter.planPathEdit(ctx, op.target.paintSeqs);
    const mismatch = fingerprintMismatch(op.target, plan.target);
    if (mismatch) {
      throw new EditStateError(`재적용 대상 패스가 다름(${pageIndex + 1}쪽): ${mismatch}`);
    }
    if (!plan.editable) {
      const reasons = plan.limits.map((l) => l.reason).join(', ');
      throw new EditStateError(`편집할 수 없는 패스입니다: ${reasons || '사유 없음'}`);
    }
    const prepared = this.#adapter.preparePathEdit(ctx, plan, op.id);
    const written = this.#adapter.writePathEdit(ctx, prepared, op.edit);
    this.#base.push({
      op,
      warnings: pathWarnings(plan, op.edit, ctx, written),
    });
    this.#touched([pageIndex], false);
  }

  // ---- 저장(D9) ----

  /** 활성 편집이 있으면 저장 전 요약(5.8), 없으면 null. */
  editSummary(): SaveEditSummary | null {
    const entries = this.#active();
    if (entries.length === 0) return null;
    return {
      pages: [...new Set(entries.flatMap((e) => pagesOf(e.op)))].sort((a, b) => a - b),
      structureUnlinked: this.#unlinkedBlocks(entries),
      pdfaDeclared: (this.#pdfa ??= declaresPdfA(this.#doc)),
    };
  }

  /**
   * 로그가 더하는 저장 변경 종류(계약 D9). 폴백 폰트 글리프를 실제로 쓴 활성 편집이 있으면 `font-embed`.
   * runSave 의 서브셋 교체와 같은 기준이다(`font-fallback` 경고는 공백 폴백을 세지 않아 기준으로 쓰지 않는다).
   */
  changeKinds(): ChangeKind[] {
    const entries = this.#active();
    if (entries.length === 0) return [];
    return entries.some(usesFallbackOf) ? ['content-stream', 'font-embed'] : ['content-stream'];
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
    if (this.#disposed) throw new EditStateError('문서가 닫혔습니다.');
    // R-M4: 엔진이 실패 상태여도 저장은 막지 않는다. 저널 상태를 믿을 수 없으므로 감싸지 않고 현재 문서를 그대로 내보낸다
    // (undo 는 이미 막혀 있어 저널에 저장 단계가 생겨도 해가 없다). 경고는 `saveWarnings()` 로 알린다.
    if (this.#failure) {
      this.#finalizeFallbackBestEffort();
      return fn();
    }
    this.#requireNoDraft('save');
    if (!this.#journalOn) return fn();
    const doc = this.#doc;
    const usesFallback = this.#active().some(usesFallbackOf);
    doc.beginOperation('save');
    let result: T;
    try {
      if (usesFallback) {
        this.#fonts?.finalizeForSave();
        // R-L2: pdf-ops 서브셋 교체는 /BaseFont 를 그대로 둔다. 저장 파일의 폰트 이름에 서브셋 태그를 붙인다.
        if (this.#fallbackRef) tagFallbackSubset(this.#doc, this.#fallbackRef);
      }
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

  /**
   * 저장 때 사용자에게 알릴 경고(R-M4). 엔진이 실패 상태면 저널로 감싸지 않고 저장하므로 마지막 편집이 문서에 반영됐는지
   * 확인해야 한다. 정상이면 빈 배열.
   */
  saveWarnings(): string[] {
    if (!this.#failure) return [];
    return [
      `편집 엔진 오류(${this.#failure}) 상태에서 저장합니다. 저널 보호 없이 현재 문서를 그대로 내보냅니다.`,
      '마지막 편집이 빠졌거나 일부만 반영됐을 수 있고, 취소한 초안의 변경이 저장 파일에 들어갈 수 있습니다. 저장 뒤 파일을 확인하고 문서를 다시 여세요.',
    ];
  }

  /**
   * 실패 상태 저장(R-M4)에서도 폴백 서브셋 교체(D9)와 서브셋 이름 태그(R-L2)를 시도한다. 저널로 감싸지 않으므로 작업 문서에
   * 그대로 남지만 이 세션은 편집 RPC 가 막혀 다시 쓰지 않는다(두 처리 모두 같은 입력에 같은 결과). 실패는 무시한다
   * (전체 폰트·태그 없는 이름으로 저장될 뿐 내용은 같다).
   */
  #finalizeFallbackBestEffort(): void {
    try {
      if (!this.#active().some(usesFallbackOf)) return;
      this.#fonts?.finalizeForSave();
      if (this.#fallbackRef) tagFallbackSubset(this.#doc, this.#fallbackRef);
    } catch {
      // 최선 노력: 저장은 계속한다.
    }
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

  #requireParagraphDraft(draftId: string): ParagraphDraft {
    const draft = this.#requireDraft(draftId);
    if (draft.kind !== 'paragraph') {
      throw new EditStateError(`패스 초안입니다(문단 RPC 로 다룰 수 없음): ${draftId}`);
    }
    return draft;
  }

  #requirePathDraft(draftId: string): PathDraft {
    const draft = this.#requireDraft(draftId);
    if (draft.kind !== 'path') {
      throw new EditStateError(`문단 초안입니다(패스 RPC 로 다룰 수 없음): ${draftId}`);
    }
    return draft;
  }

  #requireFonts(): FontManager {
    if (!this.#fonts) throw new EditStateError('편집 준비가 되지 않았습니다.');
    return this.#fonts;
  }

  /**
   * 판정 RPC 의 준비: 폴백 폰트 바이트 로드(실패하면 폴백 없이 진행, R-L5) → FontManager. 문서를 바꾸지 않고 저널도 켜지 않는다. 이 단계의
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
      const { font, ref } = embedFont(this.#doc, FALLBACK_FONT_NAME, this.#fallbackBytes);
      // 문서가 폰트 파일 스트림을 가진다. 파싱한 `mupdf.Font` 는 더 쓰지 않으므로 바로 해제한다(R-L3, 순환마다 약 4 MB).
      font.destroy();
      // 폰트 사전 표지: 문서 안에서 폴백 폰트를 알아본다(저장 파일에서는 서브셋으로 바뀐다).
      ref.put('PdfEditorFallback', this.#doc.newBoolean(true));
      this.#fallbackRef = ref;
    }
  }

  #startJournal(): void {
    this.#doc.enableJournal();
    this.#journalOn = true;
  }

  /**
   * 폴백 폰트 바이트를 불러온다. 실패해도 예외로 올리지 않고(R-L5) 폴백 없이 진행한다: `FallbackFontSource.bytes()` 가
   * 예외를 내면 FontManager 가 폴백 없음으로 다루어 원본 폰트에 없는 글자만 `glyph-missing` 이 된다. 실패는 캐시하지
   * 않아 저널을 켜기 전의 다음 호출이 다시 시도한다.
   */
  async #loadFallbackBytes(): Promise<void> {
    const load = this.#options.loadFallbackFont;
    if (this.#fallbackBytes || !load) return;
    // 저널을 켠 뒤에는 폴백 폰트를 임베딩할 수 없어 다시 시도해도 쓸 수 없다.
    if (this.#fallbackLoadError !== null && this.#journalOn) return;
    const pending = (this.#fallbackLoading ??= load().then((bytes) => {
      this.#fallbackBytes = bytes;
    }));
    try {
      await pending;
      if (this.#fallbackLoadError !== null) {
        // FontManager 는 폴백 없음 판정을 캐시한다. 늦게 얻었으면 새로 만든다(편집 전이라 상태가 없다).
        this.#fallbackLoadError = null;
        this.#disposeFonts();
      }
    } catch (error) {
      this.#fallbackLoadError = error instanceof Error ? error.message : String(error);
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
    // 문단 편집은 블록 연쇄의 마지막 항목만, 패스 편집(Form 복제로 /StructParents 를 지움)은 항목마다 센다.
    const paragraphs = entries.filter(isParagraphEntry);
    const byId = new Map(paragraphs.map((e) => [e.op.id, e]));
    const rootOf = (e: ParagraphLogEntry): string => {
      let cur = e;
      const seen = new Set<string>();
      for (
        let block = editedBlockOf(cur.op);
        block && !seen.has(cur.op.id);
        block = editedBlockOf(cur.op)
      ) {
        seen.add(cur.op.id);
        const parent = byId.get(block);
        if (!parent) return block;
        cur = parent;
      }
      return cur.op.id;
    };
    const latest = new Map<string, LogEntry>();
    for (const e of paragraphs) latest.set(rootOf(e), e);
    return (
      [...latest.values()].filter((e) => hasWarning(e, 'tagged-structure-unlinked')).length +
      entries.filter((e) => !isParagraphEntry(e) && hasWarning(e, 'tagged-structure-unlinked'))
        .length
    );
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
      pages: [...new Set(entries.flatMap((e) => pagesOf(e.op)))].sort((a, b) => a - b),
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
    this.#releaseDraftState();
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
    // 폴백 사용은 쓴 글리프로 정한다: 폴백 face 로 배정된 구간의 글리프가 배치 결과에 하나라도 있으면 사용.
    const fallbackKeys = new Set(
      segments.flatMap((seg) => (seg.face?.kind === 'fallback' ? [seg.face.key] : [])),
    );
    const usesFallback =
      fallbackKeys.size > 0 &&
      result.lines.some((line) => line.some((g) => fallbackKeys.has(g.faceKey)));
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
    return { summary: result.summary, warnings, usesFallback };
  }
}

/**
 * 패스 편집 경고 = 계획 경고 + 쓰기 경고(같은 종류는 하나로). 어댑터가 쓰기 경고를 주면(pdf-ops `pathEditWarnings`, 빈 배열
 * 포함) 그것만 쓰고, 주지 않으면 core 근사(`pathCoreWarnings`)로 대신한다. 둘을 함께 쓰면 근사의 거짓 양성
 * (`table-rule-removed`)이 정확한 판정을 덮는다.
 */
function pathWarnings(
  plan: Omit<PathEditPlan, 'revision'>,
  edit: PathEdit,
  ctx: ParagraphEditContext,
  written: PathWriteResult,
): EditWarning[] {
  return mergeWarnings(
    plan.warnings,
    written.warnings ?? pathCoreWarnings(plan, edit, ctx.layout),
    [],
  );
}

function hasWarning(entry: LogEntry, kind: EditWarning['kind']): boolean {
  return entry.warnings.some((w) => w.kind === kind);
}

/** 지문 상자 비교 허용 오차(S1 이 1e-3 pt 로 반올림해 채운다). */
const FINGERPRINT_BOX_TOLERANCE = 2e-3;

/** 로그의 패스 대상과 지금 계획의 대상이 다른 점(없으면 null). paintSeq 는 계획이 로그 값으로 찾은 것이라 지문만 비교한다. */
export function fingerprintMismatch(logged: PathTarget, current: PathTarget): string | null {
  if (logged.fingerprints.length !== current.fingerprints.length) {
    return `칠하기 연산 수 ${logged.fingerprints.length} → ${current.fingerprints.length}`;
  }
  for (const [k, want] of logged.fingerprints.entries()) {
    const got = current.fingerprints[k]!;
    if (want.paintOp !== got.paintOp)
      return `${k + 1}번째 칠하기 연산 ${want.paintOp} → ${got.paintOp}`;
    if (want.constructOpCount !== got.constructOpCount) {
      return `${k + 1}번째 구성 연산 수 ${want.constructOpCount} → ${got.constructOpCount}`;
    }
    if (want.constructHash !== got.constructHash) return `${k + 1}번째 구성 연산 해시 불일치`;
    if (want.bbox.some((v, i) => Math.abs(v - got.bbox[i]!) > FINGERPRINT_BOX_TOLERANCE)) {
      return `${k + 1}번째 패스 상자 불일치`;
    }
  }
  return null;
}

const sortedEqual = (a: number[], b: number[]): boolean =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/**
 * 로그의 대상 글리프 목록(glyphSeq)과 같은 문단을 현재 쪽 레이아웃에서 찾는다. 재적용은 같은 순서로 하므로
 * 적용 시점의 PageModel 이 같고 글리프 목록이 일치해야 한다(계약 `ParagraphTarget`).
 */
export function findParagraphId(ctx: ParagraphEditContext, target: ParagraphTarget): number {
  const wanted = target.glyphSeqs;
  if (target.cell && wanted.length > 0) return findCellParagraphId(ctx, target, target.cell);
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

/**
 * 셀 대상(D1): `glyphSeqs[0]` 을 가진 문단이 속한 표 셀로 넓힌 뒤, 셀 문단 글리프 전체가 로그의 `glyphSeqs` 와 같고 셀
 * 위치(표·행·열)가 같을 때만 그 문단 id 를 돌려준다. 순서는 따지지 않는다(셀 안 문단 순서는 pdf-ops 시작 상태 규칙이
 * 정하고, 재적용은 로그의 runs 를 쓰므로 집합 일치가 결정성에 충분하다).
 */
function findCellParagraphId(
  ctx: ParagraphEditContext,
  target: ParagraphTarget,
  cell: NonNullable<ParagraphTarget['cell']>,
): number {
  const wanted = target.glyphSeqs;
  const seqOf = (ci: number): number => ctx.model.chars[ci]?.glyphSeq ?? -1;
  const owner = ctx.layout.paragraphs.find((p) => p.chars.some((ci) => seqOf(ci) === wanted[0]));
  const table =
    owner && owner.table !== null ? ctx.layout.tables.find((t) => t.id === owner.table) : null;
  const found = table?.cells.find((c) => owner && c.paragraphs.includes(owner.id));
  if (
    owner &&
    table &&
    found &&
    table.id === cell.table &&
    found.row === cell.row &&
    found.col === cell.col
  ) {
    const seqs = found.paragraphs.flatMap((id) => {
      const paragraph = ctx.layout.paragraphs.find((p) => p.id === id);
      return paragraph ? paragraph.chars.map(seqOf) : [];
    });
    if (sortedEqual(seqs, wanted)) return owner.id;
  }
  throw new EditStateError(
    `재적용 대상 셀을 찾지 못함(${ctx.pageIndex + 1}쪽, 표 ${cell.table} ${cell.row}행 ${cell.col}열, 글리프 ${wanted.length}개)`,
  );
}
