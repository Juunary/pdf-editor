/**
 * Fake edit host for tests (RPCs of M3 contract section 4). Shared by unit tests and the Playwright harness (apps/extension/e2e).
 * The harness converts this file to JS with TypeScript `transpileModule` and loads it into the page — keep no imports other than type imports.
 *
 * Reflow is a simple layout with constant character width: line breaks come after whitespace (per character if none), `\n` is a forced line break,
 * Hangul syllables use the fallback font, and U+2603 (☃) is treated as having no glyph.
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
  PathDraftUpdate,
  PathEdit,
  PathEditPlan,
  PathEditability,
  PathInfo,
  BeginPathEditResult,
  Matrix,
  ParagraphFormat,
  ParagraphLimit,
  PlacedGlyph,
  PlacedLine,
  Rect,
  ReflowSummary,
  RunStyle,
  TextRun,
} from '@pdf-editor/shared-types';
import type { EditHostApi, PathHostApi } from '../src/viewer-host.js';

export interface FakeLayoutOptions {
  charWidth: number;
  ascent: number;
  descent: number;
  /** Whether the trailing `\n` of a line is included in the line's [start, end). */
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

/** Text range of one glyph (grapheme). */
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
  areaLimit: Rect = [0, 0, 612, 792],
): ReflowSummary {
  const text = runs.map((r) => r.text).join('');
  const firstStyle = runs[0]?.style;
  const fontId = firstStyle?.fontId ?? 0;
  let area: Rect = [...format.area];
  const build = () => {
    const s = 1;
    const lines: PlacedLine[] = [];
    const glyphs: PlacedGlyph[] = [];
    const width = area[2] - area[0];
    const lineHeight = format.lineHeight * s;
    let lineStart = 0;
    let lineGlyphs: PlacedGlyph[] = [];
    let x = area[0];
    let lastBreak = -1; // position (index) after whitespace within lineGlyphs
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
      // Whitespace does not break the line even if it hangs at the line end (trailing whitespace is excluded from the width calculation, contract 5.4).
      const hanging = /\s/.test(c.ch);
      if (!missing && !hanging && x + advance > area[0] + width + 1e-6 && lineGlyphs.length > 0) {
        if (lastBreak > 0 && lastBreak < lineGlyphs.length) {
          // Break after the last whitespace: glyphs after it move to the next line.
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
  const built = build();
  const bottomOf = (l: PlacedLine[]) => (l.at(-1)?.baseline ?? 0) + (l.at(-1)?.descent ?? 0);
  // Contract 5.4 (2026-10-20): on overflow, the bottom edge is lowered automatically to the text height (up to the limit).
  if (bottomOf(built.lines) > area[3] + 0.5) {
    area = [area[0], area[1], area[2], Math.min(areaLimit[3], bottomOf(built.lines))];
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
  /** Tagged PDF page (plan.insertion.mcidKept is not null). */
  tagged?: boolean;
  charIndexOfOffset?: number[];
  warnings?: EditWarning[];
  /** Cell position if it is a table cell (M4, bbox is the cell box). */
  cell?: { table: number; row: number; col: number };
}

/** Vector path the fake host returns with edit results applied (one PathInfo of PageModel.paths + classification). */
export interface FakePath {
  info: PathInfo;
  editable?: boolean;
  reasons?: string[];
}

export interface FakeEditOptions {
  pageIndex?: number;
  paragraphs: FakeParagraph[];
  layout?: Partial<FakeLayoutOptions>;
  areaLimit?: Rect;
  paths?: FakePath[];
}

type Method = keyof EditHostApi | keyof PathHostApi;

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

/** Fake edit host that supports call recording, failure injection and response holding. */
export class FakeEditHost implements EditHostApi, PathHostApi {
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
  /** Path state (edits applied). Changes during a draft are applied at commit. */
  private paths: (FakePath & { deleted?: boolean })[];
  private pathDrafts = new Map<string, { seqs: number[]; edit: PathEdit | null }>();
  readonly pathEdits: PathEdit[] = [];
  private holds = new Map<Method, { release: () => void; promise: Promise<void> }[]>();

  constructor(private readonly options: FakeEditOptions) {
    this.layout = { ...DEFAULT_LAYOUT, ...options.layout };
    this.pageIndex = options.pageIndex ?? 0;
    this.paths = (options.paths ?? []).map((p) => ({ ...p, info: structuredClone(p.info) }));
  }

  /** List of PathInfo with edits applied (for PageModel.paths, excluding deleted paths). */
  pathInfos(): PathInfo[] {
    return this.paths.filter((p) => !p.deleted).map((p) => p.info);
  }

  /** Changes the box of the path with the same paintSeq as if the document were changed from outside (the fingerprint changes). Also bumps revision. */
  shiftPath(paintSeq: number, dx: number): void {
    const p = this.paths.find((x) => x.info.paintSeq === paintSeq)!;
    const b = p.info.bbox;
    p.info = { ...p.info, bbox: [b[0] + dx, b[1], b[2] + dx, b[3]] };
    this.revision++;
  }

  /** Fails the next `method` call with this error. */
  failNext(method: Method, error: Error): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), error]);
  }

  /** Holds the next `method` call until release(). */
  hold(method: Method): () => void {
    let release!: () => void;
    const promise = new Promise<void>((r) => (release = r));
    this.holds.set(method, [...(this.holds.get(method) ?? []), { release, promise }]);
    return release;
  }

  /** Loses the draft and changes revision as if the Worker were newly created (recovery simulation). */
  simulateRecovery(): void {
    this.drafts.clear();
    this.pathDrafts.clear();
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
        cell: p.cell ?? null,
      })),
      paths: this.paths
        .filter((p) => !p.deleted)
        .map((p, i): PathEditability => ({
          pathIndex: i,
          paintSeq: p.info.paintSeq,
          bbox: p.info.bbox,
          editable: p.editable !== false,
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
    const reflow = fakeReflow(runs, format, this.layout, this.options.areaLimit);
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
    // Paint the glyph boxes dark (for checking synthetic positions).
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
    if (reflow.overflow) {
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
    renderScale = 1,
  ): Promise<BeginEditResult> {
    await this.enter('beginParagraphEdit', [pageIndex, paragraphId, revision, renderScale]);
    if (revision !== this.revision) throw new Error('revision 이 현재와 다릅니다');
    if (this.drafts.size > 0) throw new Error('초안은 문서당 1개입니다');
    const p = this.paragraph(paragraphId);
    const plan = this.planOf(p);
    if (!plan.editable) throw new Error('편집할 수 없는 문단입니다');
    const draftId = `draft-${++this.draftSeq}`;
    this.drafts.set(draftId, { paragraph: p, input: null });
    return { draftId, plan, first: this.update(draftId, plan.runs, plan.format, renderScale) };
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

  // ── M4 vector paths ─────────────────────────────────────────────────────

  private pathBySeq(seq: number) {
    const p = this.paths.find((x) => x.info.paintSeq === seq && !x.deleted);
    if (!p) throw new Error(`패스 ${seq} 없음`);
    return p;
  }

  private pathTarget(seqs: number[]) {
    const ps = seqs.map((s) => this.pathBySeq(s));
    const boxes = ps.map((p) => p.info.bbox);
    return {
      pageIndex: this.pageIndex,
      paintSeqs: seqs,
      fingerprints: ps.map((p) => ({
        paintOp: p.info.op === 'stroke' ? 'S' : 'f',
        constructOpCount: p.info.segments?.length ?? 0,
        bbox: p.info.bbox,
        constructHash: String(p.info.paintSeq),
      })),
      bbox: [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ] as Rect,
    };
  }

  private pathPlan(seqs: number[]): PathEditPlan {
    const ps = seqs.map((s) => this.pathBySeq(s));
    const blocked = ps.filter((p) => p.editable === false);
    const first = ps[0]!;
    return {
      pageIndex: this.pageIndex,
      revision: this.revision,
      target: this.pathTarget(seqs),
      editable: blocked.length === 0,
      limits: blocked.flatMap((p) =>
        (p.reasons ?? ['clip-path']).map((r) => ({
          reason: r as never,
          detail: `제한(${r}, 테스트)`,
        })),
      ),
      warnings: [],
      fill: first.info.op === 'fill' ? first.info.color : null,
      stroke: first.info.op === 'stroke' ? first.info.color : null,
      lineWidth: first.info.lineWidth,
      planMs: 1,
    };
  }

  async planPathEdit(pageIndex: number, paintSeqs: number[]): Promise<PathEditPlan> {
    await this.enter('planPathEdit', [pageIndex, paintSeqs]);
    return this.pathPlan(paintSeqs);
  }

  async beginPathEdit(
    pageIndex: number,
    paintSeqs: number[],
    revision: number,
  ): Promise<BeginPathEditResult> {
    await this.enter('beginPathEdit', [pageIndex, paintSeqs, revision]);
    if (revision !== this.revision) throw new Error('revision 이 현재와 다릅니다');
    if (this.drafts.size > 0 || this.pathDrafts.size > 0)
      throw new Error('초안은 문서당 1개입니다');
    const plan = this.pathPlan(paintSeqs);
    if (!plan.editable) throw new Error('편집할 수 없는 패스입니다');
    const draftId = `pdraft-${++this.draftSeq}`;
    this.pathDrafts.set(draftId, { seqs: paintSeqs, edit: null });
    return { draftId, plan };
  }

  private applyPathEdit(info: PathInfo, edit: PathEdit): PathInfo {
    const next = structuredClone(info);
    const map = (p: [number, number]): [number, number] => {
      const m: Matrix | null = edit.transform;
      return m ? [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]] : p;
    };
    // The fake host handles only paths whose ctm is the identity (coordinates = page space).
    next.segments =
      next.segments?.map((s) => {
        if (s.type === 'M' || s.type === 'L') return { ...s, p: map(s.p) };
        if (s.type === 'C') return { type: 'C', p1: map(s.p1), p2: map(s.p2), p3: map(s.p3) };
        return s;
      }) ?? null;
    if (edit.points && next.segments) {
      for (const pt of edit.points) {
        let n = 0;
        for (const s of next.segments) {
          if (s.type === 'M' || s.type === 'L') {
            if (n++ === pt.index) s.p = pt.to;
          } else if (s.type === 'C') {
            if (n++ === pt.index) s.p1 = pt.to;
            if (n++ === pt.index) s.p2 = pt.to;
            if (n++ === pt.index) s.p3 = pt.to;
          }
        }
      }
    }
    const xs = (next.segments ?? []).flatMap((s) =>
      s.type === 'M' || s.type === 'L'
        ? [s.p[0]]
        : s.type === 'C'
          ? [s.p1[0], s.p2[0], s.p3[0]]
          : [],
    );
    const ys = (next.segments ?? []).flatMap((s) =>
      s.type === 'M' || s.type === 'L'
        ? [s.p[1]]
        : s.type === 'C'
          ? [s.p1[1], s.p2[1], s.p3[1]]
          : [],
    );
    if (xs.length > 0)
      next.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const color = next.op === 'stroke' ? edit.stroke : edit.fill;
    if (color && next.color)
      next.color = { ...next.color, space: 'DeviceRGB', values: color, rgb: color };
    if (edit.lineWidth !== null && next.op === 'stroke') next.lineWidth = edit.lineWidth;
    return next;
  }

  async updatePathDraft(
    draftId: string,
    edit: PathEdit,
    renderScale: number,
  ): Promise<PathDraftUpdate> {
    await this.enter('updatePathDraft', [draftId, edit, renderScale]);
    const draft = this.pathDrafts.get(draftId);
    if (!draft) throw new Error(`초안 ${draftId} 없음`);
    draft.edit = edit;
    this.pathEdits.push(edit);
    const target = this.pathTarget(draft.seqs);
    const after = edit.delete
      ? target.bbox
      : this.applyPathEdit(
          { ...this.pathBySeq(draft.seqs[0]!).info, segments: rectAsSegments(target.bbox) },
          edit,
        ).bbox;
    const pad = 2;
    const box: Rect = [
      Math.min(target.bbox[0], after[0]) - pad,
      Math.min(target.bbox[1], after[1]) - pad,
      Math.max(target.bbox[2], after[2]) + pad,
      Math.max(target.bbox[3], after[3]) + pad,
    ];
    const clip: Rect = [
      Math.floor(box[0] * renderScale) / renderScale,
      Math.floor(box[1] * renderScale) / renderScale,
      Math.ceil(box[2] * renderScale) / renderScale,
      Math.ceil(box[3] * renderScale) / renderScale,
    ];
    const width = Math.round((clip[2] - clip[0]) * renderScale);
    const height = Math.round((clip[3] - clip[1]) * renderScale);
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    // Paint the box blue after the edit (for checking synthetic positions).
    if (!edit.delete) {
      for (
        let y = Math.round((after[1] - clip[1]) * renderScale);
        y < Math.round((after[3] - clip[1]) * renderScale);
        y++
      ) {
        for (
          let x = Math.round((after[0] - clip[0]) * renderScale);
          x < Math.round((after[2] - clip[0]) * renderScale);
          x++
        ) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const i = (y * width + x) * 4;
          rgba[i] = 0x10;
          rgba[i + 1] = 0x40;
          rgba[i + 2] = 0xe0;
        }
      }
    }
    return {
      draftId,
      target,
      bbox: after,
      warnings: [],
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

  async commitPathEdit(draftId: string): Promise<CommitResult> {
    await this.enter('commitPathEdit', [draftId]);
    const draft = this.pathDrafts.get(draftId);
    if (!draft?.edit) throw new Error(`초안 ${draftId} 없음`);
    this.pathDrafts.delete(draftId);
    const edit = draft.edit;
    const target = this.pathTarget(draft.seqs);
    for (const seq of draft.seqs) {
      const p = this.pathBySeq(seq);
      if (edit.delete) p.deleted = true;
      else p.info = this.applyPathEdit(p.info, edit);
    }
    const id = `edit-${++this.editSeq}`;
    const op: EditOp = { kind: 'edit-path', id, target, edit };
    this.committedOps.set(id, op);
    this.active.push(id);
    this.undone = [];
    this.revision++;
    return { op, history: this.history([this.pageIndex]) };
  }

  async cancelPathEdit(draftId: string): Promise<EditHistoryState> {
    await this.enter('cancelPathEdit', [draftId]);
    this.pathDrafts.delete(draftId);
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

function rectAsSegments(r: Rect): PathInfo['segments'] {
  return [
    { type: 'M', p: [r[0], r[1]] },
    { type: 'L', p: [r[2], r[1]] },
    { type: 'L', p: [r[2], r[3]] },
    { type: 'L', p: [r[0], r[3]] },
    { type: 'Z' },
  ];
}
