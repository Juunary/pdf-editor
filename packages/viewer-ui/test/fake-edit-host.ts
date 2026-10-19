/**
 * 테스트용 가짜 편집 호스트(M3 계약 4절 RPC). 단위 테스트와 Playwright 하니스(apps/extension/e2e)가 함께 쓴다.
 * 하니스는 이 파일을 TypeScript `transpileModule` 로 JS 로 바꿔 페이지에 싣는다 — 타입 import 외에 다른 import 를 두지 않는다.
 *
 * 리플로우는 글자 폭이 일정한 단순 배치다: 줄 나눔은 공백 뒤(없으면 글자 단위), `\n` 은 강제 줄바꿈,
 * 한글 음절은 폴백 폰트, U+2603(☃)은 글리프 없음으로 둔다.
 */
import type {
  BeginEditResult,
  CommitResult,
  DraftInput,
  DraftUpdate,
  EditHistoryState,
  EditOp,
  EditWarning,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
  ParagraphLimit,
  PlacedGlyph,
  PlacedLine,
  Rect,
  ReflowSummary,
  RunStyle,
  TextRun,
} from '@pdf-editor/shared-types';
import type { EditHostApi } from '../src/viewer-host.js';

export interface FakeLayoutOptions {
  charWidth: number;
  ascent: number;
  descent: number;
  /** 줄 끝 `\n` 을 줄의 [start, end) 에 포함할지. */
  newlineInLine: boolean;
}

export const DEFAULT_LAYOUT: FakeLayoutOptions = {
  charWidth: 10,
  ascent: 11,
  descent: 3,
  newlineInLine: true,
};

const isHangul = (ch: string): boolean => /[가-힣]/.test(ch);
const isMissing = (ch: string): boolean => ch === '☃';

/** 글리프 하나(자소)의 텍스트 구간. */
function clusters(text: string): { offset: number; length: number; ch: string }[] {
  const seg = new Intl.Segmenter('und', { granularity: 'grapheme' });
  return [...seg.segment(text)].map((s) => ({
    offset: s.index,
    length: s.segment.length,
    ch: s.segment,
  }));
}

export function fakeReflow(
  runs: TextRun[],
  format: ParagraphFormat,
  layout: FakeLayoutOptions = DEFAULT_LAYOUT,
): ReflowSummary {
  const text = runs.map((r) => r.text).join('');
  const firstStyle = runs[0]?.style;
  const fontId = firstStyle?.fontId ?? 0;
  let scale = 1;
  let area: Rect = [...format.area];
  const build = (s: number) => {
    const lines: PlacedLine[] = [];
    const glyphs: PlacedGlyph[] = [];
    const width = area[2] - area[0];
    const lineHeight = format.lineHeight * s;
    let lineStart = 0;
    let lineGlyphs: PlacedGlyph[] = [];
    let x = area[0];
    let lastBreak = -1; // lineGlyphs 안 공백 뒤 위치(인덱스)
    const flush = (end: number, hardBreak: boolean) => {
      const baseline = area[1] + format.firstBaselineOffset * s + lines.length * lineHeight;
      let x1 = area[0];
      for (const g of lineGlyphs) {
        g.y = baseline;
        if (!/^\s*$/.test(text.slice(g.offset, g.offset + g.length)))
          x1 = Math.max(x1, g.x + g.advance);
      }
      lines.push({
        baseline,
        x0: area[0],
        x1,
        ascent: layout.ascent * s,
        descent: layout.descent * s,
        start: lineStart,
        end,
        hardBreak,
      });
      glyphs.push(...lineGlyphs);
      lineGlyphs = [];
      lineStart = end;
      x = area[0];
      lastBreak = -1;
    };
    for (const c of clusters(text)) {
      if (c.ch === '\n') {
        flush(layout.newlineInLine ? c.offset + 1 : c.offset, true);
        if (!layout.newlineInLine) lineStart = c.offset + 1;
        continue;
      }
      const missing = isMissing(c.ch);
      const advance = missing ? 0 : layout.charWidth * s;
      // 공백은 줄 끝에 걸려도 줄을 나누지 않는다(줄 끝 공백은 폭 계산에서 뺀다, 계약 5.4).
      const hanging = /\s/.test(c.ch);
      if (!missing && !hanging && x + advance > area[0] + width + 1e-6 && lineGlyphs.length > 0) {
        if (lastBreak > 0 && lastBreak < lineGlyphs.length) {
          // 마지막 공백 뒤에서 나눈다: 그 뒤 글리프는 다음 줄로 옮긴다.
          const moved = lineGlyphs.splice(lastBreak);
          const end = moved[0]!.offset;
          flush(end, false);
          let nx = area[0];
          for (const g of moved) {
            g.x = nx;
            nx += g.advance;
          }
          lineGlyphs = moved;
          x = nx;
        } else {
          flush(c.offset, false);
        }
      }
      const font: PlacedGlyph['font'] = missing
        ? { kind: 'missing' }
        : isHangul(c.ch)
          ? { kind: 'fallback' }
          : { kind: 'original', fontId };
      lineGlyphs.push({
        offset: c.offset,
        length: c.length,
        font,
        x,
        y: 0,
        advance,
        size: (firstStyle?.size ?? 12) * s,
      });
      x += advance;
      if (/\s/.test(c.ch)) lastBreak = lineGlyphs.length;
    }
    flush(text.length, false);
    return { lines, glyphs };
  };
  let built = build(scale);
  const bottomOf = (l: PlacedLine[]) => (l.at(-1)?.baseline ?? 0) + (l.at(-1)?.descent ?? 0);
  if (bottomOf(built.lines) > area[3] + 0.5) {
    if (format.overflow === 'expand') {
      area = [area[0], area[1], area[2], bottomOf(built.lines)];
    } else if (format.overflow === 'shrink') {
      for (let s = 99; s >= 80; s--) {
        scale = s / 100;
        built = build(scale);
        if (bottomOf(built.lines) <= area[3] + 0.5) break;
      }
    }
  }
  const { lines, glyphs } = built;
  const xs = glyphs.flatMap((g) => [g.x, g.x + g.advance]);
  const contentBox: Rect = [
    xs.length > 0 ? Math.min(...xs) : area[0],
    lines[0] ? lines[0].baseline - lines[0].ascent : area[1],
    xs.length > 0 ? Math.max(...xs) : area[0],
    lines.at(-1) ? lines.at(-1)!.baseline + lines.at(-1)!.descent : area[1],
  ];
  return {
    lines,
    glyphs,
    contentBox,
    area,
    overflow: bottomOf(lines) > area[3] + 0.5,
    fontScale: scale,
    reflowMs: 1,
  };
}

export interface FakeParagraph {
  id: number;
  bbox: Rect;
  text: string;
  editable?: boolean;
  reasons?: string[];
  limits?: ParagraphLimit[];
  /** 태그 PDF 쪽(plan.insertion.mcidKept 가 null 이 아님). */
  tagged?: boolean;
  charIndexOfOffset?: number[];
  warnings?: EditWarning[];
}

export interface FakeEditOptions {
  pageIndex?: number;
  paragraphs: FakeParagraph[];
  layout?: Partial<FakeLayoutOptions>;
  areaLimit?: Rect;
}

type Method = keyof EditHostApi;

const STYLE: RunStyle = {
  sourceChar: 0,
  fontId: 0,
  size: 12,
  bold: false,
  italic: false,
  color: null,
};

interface Draft {
  paragraph: FakeParagraph;
  input: DraftInput | null;
}

/** 호출 기록·실패 주입·응답 보류를 지원하는 가짜 편집 호스트. */
export class FakeEditHost implements EditHostApi {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly inputs: DraftInput[] = [];
  revision = 1;
  private readonly layout: FakeLayoutOptions;
  private readonly pageIndex: number;
  private drafts = new Map<string, Draft>();
  private draftSeq = 0;
  private editSeq = 0;
  private active: string[] = [];
  private undone: string[] = [];
  private readonly committedOps = new Map<string, EditOp>();
  private failures = new Map<Method, Error[]>();
  private holds = new Map<Method, { release: () => void; promise: Promise<void> }[]>();

  constructor(private readonly options: FakeEditOptions) {
    this.layout = { ...DEFAULT_LAYOUT, ...options.layout };
    this.pageIndex = options.pageIndex ?? 0;
  }

  /** 다음 `method` 호출을 이 오류로 실패시킨다. */
  failNext(method: Method, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  /** 다음 `method` 호출을 release() 때까지 보류한다. */
  hold(method: Method): () => void {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.holds.set(method, [...(this.holds.get(method) ?? []), { release, promise }]);
    return release;
  }

  /** Worker 가 새로 만들어진 것처럼 초안을 잃고 revision 이 바뀐다(복구 시뮬레이션). */
  simulateRecovery(): void {
    this.drafts.clear();
    this.revision++;
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  private async enter(method: Method, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const hold = this.holds.get(method)?.shift();
    if (hold) await hold.promise;
    const failure = this.failures.get(method)?.shift();
    if (failure) throw failure;
  }

  private history(affected: number[] = []): EditHistoryState {
    return {
      revision: this.revision,
      activeEditIds: [...this.active],
      canUndo: this.active.length > 0,
      canRedo: this.undone.length > 0,
      edits: this.active.length,
      affectedPages: affected,
    };
  }

  private paragraph(id: number): FakeParagraph {
    const p = this.options.paragraphs.find((x) => x.id === id);
    if (!p) throw new Error(`문단 ${id} 없음`);
    return p;
  }

  async getPageEditability(pageIndex: number): Promise<PageEditability> {
    await this.enter('getPageEditability', [pageIndex]);
    return {
      pageIndex,
      revision: this.revision,
      paragraphs: this.options.paragraphs.map((p) => ({
        paragraphId: p.id,
        bbox: p.bbox,
        editable: p.editable !== false,
        editedBlock: null,
        reasons: (p.reasons ?? []) as never,
      })),
      ms: 1,
    };
  }

  private planOf(p: FakeParagraph): ParagraphEditPlan {
    const format: ParagraphFormat = {
      area: p.bbox,
      align: 'left',
      firstLineIndent: 0,
      lineHeight: 20,
      firstBaselineOffset: 12,
      overflow: null,
    };
    const editable = p.editable !== false;
    return {
      pageIndex: this.pageIndex,
      paragraphId: p.id,
      revision: this.revision,
      target: { pageIndex: this.pageIndex, glyphSeqs: [], editedBlock: null, bbox: p.bbox },
      editable,
      limits: editable
        ? []
        : (p.limits ?? [
            { reason: 'not-flow-paragraph', detail: '표 셀 안 글자입니다(테스트).', chars: [] },
          ]),
      warnings: p.warnings ?? [],
      runs: [{ text: p.text, style: STYLE }],
      charIndexOfOffset: p.charIndexOfOffset ?? Array.from({ length: p.text.length }, (_, i) => i),
      format,
      areaLimit: this.options.areaLimit ?? [0, 0, 612, 792],
      insertion: editable
        ? { container: 'page', mode: 'before-bt', mcidKept: p.tagged ? true : null }
        : null,
      removal: { ops: 1, partialOps: 0, formInstances: 0 },
      save: { method: 'full', changes: ['content-stream'] },
      planMs: 1,
    };
  }

  async planParagraphEdit(pageIndex: number, paragraphId: number): Promise<ParagraphEditPlan> {
    await this.enter('planParagraphEdit', [pageIndex, paragraphId]);
    return this.planOf(this.paragraph(paragraphId));
  }

  private update(
    draftId: string,
    runs: TextRun[],
    format: ParagraphFormat,
    scale: number,
  ): DraftUpdate {
    const reflow = fakeReflow(runs, format, this.layout);
    const pad = 2;
    const box: Rect = [
      Math.min(reflow.contentBox[0], reflow.area[0]) - pad,
      Math.min(reflow.contentBox[1], reflow.area[1]) - pad,
      Math.max(reflow.contentBox[2], reflow.area[2]) + pad,
      Math.max(reflow.contentBox[3], reflow.area[3]) + pad,
    ];
    const clip: Rect = [
      Math.floor(box[0] * scale) / scale,
      Math.floor(box[1] * scale) / scale,
      Math.ceil(box[2] * scale) / scale,
      Math.ceil(box[3] * scale) / scale,
    ];
    const width = Math.round((clip[2] - clip[0]) * scale);
    const height = Math.round((clip[3] - clip[1]) * scale);
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    // 글리프 상자를 어둡게 칠한다(합성 위치 확인용).
    for (const g of reflow.glyphs) {
      if (g.advance <= 0) continue;
      const line = reflow.lines.find((l) => g.offset >= l.start && g.offset < l.end);
      if (!line) continue;
      const gx0 = Math.round((g.x - clip[0]) * scale);
      const gx1 = Math.round((g.x + g.advance - clip[0]) * scale) - 1;
      const gy0 = Math.round((line.baseline - line.ascent - clip[1]) * scale);
      const gy1 = Math.round((line.baseline - clip[1]) * scale);
      for (let y = Math.max(0, gy0); y < Math.min(height, gy1); y++) {
        for (let x = Math.max(0, gx0 + 1); x < Math.min(width, gx1); x++) {
          const i = (y * width + x) * 4;
          rgba[i] = 0x22;
          rgba[i + 1] = 0x22;
          rgba[i + 2] = 0x22;
        }
      }
    }
    const warnings: EditWarning[] = [];
    if (reflow.overflow && format.overflow === 'keep') {
      warnings.push({
        kind: 'overflow-clipped',
        message: '넘친 줄이 잘릴 수 있습니다(테스트).',
        rects: [],
      });
    }
    if (reflow.glyphs.some((g) => g.font.kind === 'missing')) {
      warnings.push({
        kind: 'glyph-missing',
        message: '글리프가 없는 글자는 쓰지 않았습니다.',
        rects: [],
      });
    }
    return {
      draftId,
      reflow,
      warnings,
      region: {
        pageIndex: this.pageIndex,
        width,
        height,
        rgba: rgba as Uint8ClampedArray<ArrayBuffer>,
        renderMs: 1,
        clip,
      },
      updateMs: 1,
    };
  }

  async beginParagraphEdit(
    pageIndex: number,
    paragraphId: number,
    revision: number,
  ): Promise<BeginEditResult> {
    await this.enter('beginParagraphEdit', [pageIndex, paragraphId, revision]);
    if (revision !== this.revision) throw new Error('revision 이 현재와 다릅니다');
    if (this.drafts.size > 0) throw new Error('초안은 문서당 1개입니다');
    const p = this.paragraph(paragraphId);
    const plan = this.planOf(p);
    if (!plan.editable) throw new Error('편집할 수 없는 문단입니다');
    const draftId = `draft-${++this.draftSeq}`;
    this.drafts.set(draftId, { paragraph: p, input: null });
    return { draftId, plan, first: this.update(draftId, plan.runs, plan.format, 1) };
  }

  async updateParagraphDraft(draftId: string, input: DraftInput): Promise<DraftUpdate> {
    await this.enter('updateParagraphDraft', [draftId, input]);
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`초안 ${draftId} 없음`);
    draft.input = input;
    this.inputs.push(input);
    return this.update(draftId, input.runs, input.format, input.renderScale);
  }

  async commitParagraphEdit(draftId: string): Promise<CommitResult> {
    await this.enter('commitParagraphEdit', [draftId]);
    const draft = this.drafts.get(draftId);
    if (!draft?.input) throw new Error(`초안 ${draftId} 없음`);
    this.drafts.delete(draftId);
    const id = `edit-${++this.editSeq}`;
    const op: EditOp = {
      kind: 'replace-paragraph',
      id,
      target: {
        pageIndex: this.pageIndex,
        glyphSeqs: [],
        editedBlock: null,
        bbox: draft.paragraph.bbox,
      },
      runs: draft.input.runs,
      format: draft.input.format,
    };
    this.committedOps.set(id, op);
    this.active.push(id);
    this.undone = [];
    this.revision++;
    return { op, history: this.history([this.pageIndex]) };
  }

  async cancelParagraphEdit(draftId: string): Promise<EditHistoryState> {
    await this.enter('cancelParagraphEdit', [draftId]);
    this.drafts.delete(draftId);
    return this.history([]);
  }

  async undo(): Promise<EditHistoryState> {
    await this.enter('undo', []);
    const id = this.active.pop();
    if (id) this.undone.push(id);
    this.revision++;
    return this.history(id ? [this.pageIndex] : []);
  }

  async redo(): Promise<EditHistoryState> {
    await this.enter('redo', []);
    const id = this.undone.pop();
    if (id) this.active.push(id);
    this.revision++;
    return this.history(id ? [this.pageIndex] : []);
  }

  async getEditHistory(): Promise<EditHistoryState> {
    await this.enter('getEditHistory', []);
    return this.history();
  }
}
