/**
 * Fake edit adapter for tests (docs/m3-core.md 3.2). A minimal implementation for verifying the core edit engine on a
 * real MuPDF document and journal before the M3 functions of pdf-ops and reflow are merged.
 * - Removal: cuts the text-show operations of the paragraph glyphs out of the page content stream (byte replacement) and puts `q /EBn Do Q` in their place.
 * - Edit block: a Form XObject with `/PdfEditorEdit`. Each line is written with `Tm` + `Tj`.
 * - Fonts: Latin uses F1 (Helvetica) of the page resources, Hangul uses the fallback font (imitating the lifetime rule of contract D4: each time it is used,
 *   it checks that the object exists and, if not, inserts it again from the loader bytes inside the current operation).
 * Assumptions: the page content is a single stream, /Rotate 0, MediaBox origin 0.
 */
import * as mupdf from 'mupdf';
import {
  FontManager,
  type PreparedPathEdit,
  ownResources,
  ownSubdict,
  putUniqueResource,
  subsetFontBytes,
  type EditBlockRef,
  type FallbackFontSource,
  type ParagraphEditContext,
  type PreparedEdit,
} from '@pdf-editor/pdf-ops';
import type {
  EditWarning,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
  PathEdit,
  PathEditPlan,
  PathFingerprint,
  Rect,
  ReflowSummary,
  TextRun,
} from '@pdf-editor/shared-types';
import type {
  FontFace,
  FontSegment,
  ReflowInput,
  ReflowResult,
  WritableGlyph,
} from '@pdf-editor/reflow';
import type { EditAdapter } from '../src/edit-adapter.js';
import { koreanFont } from './pdf-fixtures.js';

type PlanBase = Omit<ParagraphEditPlan, 'revision'>;

const HANGUL = /[가-힣]/;
const UNSUPPORTED = /[☃]/; // snowman: absent from both the original and the fallback (glyph-missing)

export interface FakeAdapterProbe {
  /** Arguments of the recordEditMetadata call. */
  metadataCalls: { pages: number[]; structureNotUpdated: boolean }[];
  /** Call history (prepare, write, list, etc.). */
  calls: string[];
  /** Makes the next prepare / write call fail. */
  failNext: {
    prepare?: boolean;
    write?: boolean;
    finalize?: boolean;
    /** Number of write calls that throw after writing (non-atomic writes). */
    writeAfter?: number;
  };
  /** Warnings the classification adds as plan warnings (e.g. tagged structure break). */
  planWarnings: EditWarning[];
  /** Arguments of path write calls (edit id fixed at prepare → list of edits written). */
  pathWrites: { editId: string; edit: PathEdit }[];
  /** Makes the next path prepare / write call fail. */
  failNextPath: { prepare?: boolean; write?: boolean; writeAfter?: boolean };
  /** Warnings to put in the writePathEdit result (imitates the optional `warnings` field that pdf-ops will fill). */
  pathWriteWarnings: EditWarning[] | undefined;
  /** Number of releaseEdit calls (R-L3 wiring check). */
  releaseCalls: number;
  /** Number of dispose calls on the FontManagers created. */
  fontDisposeCalls: number;
}

export interface FakeAdapter extends EditAdapter {
  probe: FakeAdapterProbe;
}

class FakeFonts extends FontManager {
  readonly #source: FallbackFontSource;
  readonly #probe: FakeAdapterProbe;
  readonly usedGids = new Set<number>();

  constructor(doc: mupdf.PDFDocument, source: FallbackFontSource, probe: FakeAdapterProbe) {
    super(doc, source);
    this.#source = source;
    this.#probe = probe;
  }

  /** Fallback font object that core embedded just before enabling the journal (outside the operation) (contract D4 amendment 1). Absent during classification. */
  fallbackRef(): mupdf.PDFObject {
    const ref = this.#source.ref();
    if (!ref) throw new Error('fake: 폴백 폰트 객체가 아직 없음(저널을 켜기 전)');
    return ref;
  }

  override assign(
    _ctx: ParagraphEditContext,
    text: string,
    runs: TextRun[],
  ): { segments: FontSegment[]; warnings: EditWarning[] } {
    const segments: FontSegment[] = [];
    const warnings: EditWarning[] = [];
    let offset = 0;
    let usesFallback = false;
    let missing = false;
    // If the fallback font could not be obtained (R-L5), treat it as having no fallback, like the real FontManager.
    let fallbackAvailable = true;
    try {
      this.#source.bytes();
    } catch {
      fallbackAvailable = false;
    }
    runs.forEach((run, runIndex) => {
      for (const ch of run.text) {
        const kind =
          HANGUL.test(ch) && fallbackAvailable
            ? 'fallback'
            : HANGUL.test(ch) || UNSUPPORTED.test(ch)
              ? 'missing'
              : 'original';
        if (kind === 'fallback') usesFallback = true;
        if (kind === 'missing') missing = true;
        segments.push({
          start: offset,
          end: offset + ch.length,
          face: kind === 'missing' ? null : kind === 'fallback' ? FALLBACK_FACE : ORIGINAL_FACE,
          size: run.style.size,
          runIndex,
          syntheticBold: false,
          syntheticItalic: false,
        });
        offset += ch.length;
      }
    });
    if (offset !== text.length) throw new Error('fake assign: runs 와 text 길이 불일치');
    if (usesFallback) {
      warnings.push({ kind: 'font-fallback', message: '폴백 폰트 사용', rects: [] });
    }
    if (missing) warnings.push({ kind: 'glyph-missing', message: '글리프 없음', rects: [] });
    return { segments, warnings };
  }

  /** Inside the save operation: replaces FontFile2 with a subset holding only the glyphs used (reverts if the operation is discarded). */
  override dispose(): void {
    this.#probe.fontDisposeCalls++;
    super.dispose();
  }

  override finalizeForSave(): void {
    if (this.#probe.failNext.finalize) {
      this.#probe.failNext.finalize = false;
      throw new Error('fake finalize 실패');
    }
    const ref = this.#source.ref();
    if (!ref || this.usedGids.size === 0) return;
    const file = ref.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    file.writeStream(subsetFontBytes('NotoSansKR', this.#source.bytes(), this.usedGids));
  }
}

const ORIGINAL_FACE: FontFace = {
  key: 'F1',
  kind: 'original',
  fontId: 0,
  ascent: 900,
  descent: -200,
  source: { kind: 'pdf-widths', encode: () => null },
};
const FALLBACK_FACE: FontFace = {
  key: 'FB',
  kind: 'fallback',
  fontId: null,
  ascent: 1000,
  descent: -300,
  source: { kind: 'opentype', bytes: new Uint8Array(0), pdfWidth: () => 1000 },
};

export function createFakeAdapter(): FakeAdapter {
  const probe: FakeAdapterProbe = {
    metadataCalls: [],
    calls: [],
    failNext: {},
    planWarnings: [],
    pathWrites: [],
    failNextPath: {},
    pathWriteWarnings: undefined,
    releaseCalls: 0,
    fontDisposeCalls: 0,
  };
  /** Original stream captured when the path edit was prepared (writes are always absolute edits relative to the original). */
  const pathSnapshots = new Map<
    string,
    { streamNum: number; original: Uint8Array<ArrayBuffer>; lines: PathLine[] }
  >();
  /** Edit block area (used by plan to recognize a re-edit target). */
  const blockBoxes = new Map<string, Rect>();
  let fonts: FakeFonts | null = null;

  const paragraphOf = (ctx: ParagraphEditContext, id: number) => {
    const p = ctx.layout.paragraphs.find((x) => x.id === id);
    if (!p) throw new Error(`문단 ${id} 없음`);
    return p;
  };

  const limitsOf = (ctx: ParagraphEditContext, id: number) => {
    const p = paragraphOf(ctx, id);
    if (p.table !== null || p.figure !== null) {
      return [{ reason: 'not-flow-paragraph' as const, detail: '표·도형', chars: [] }];
    }
    if (p.text.includes('LOCKED')) {
      return [
        { reason: 'remove-skipped' as const, code: 'op-limit' as const, detail: '잠금', chars: [] },
      ];
    }
    return [];
  };

  const adapter: FakeAdapter = {
    probe,

    createFonts(doc, source) {
      fonts = new FakeFonts(doc, source, probe);
      return fonts;
    },

    planPageEditability(ctx): Omit<PageEditability, 'revision' | 'ms'> {
      return {
        pageIndex: ctx.pageIndex,
        paragraphs: ctx.layout.paragraphs.map((p) => {
          const limits = limitsOf(ctx, p.id);
          return {
            paragraphId: p.id,
            bbox: p.bbox,
            editable: limits.length === 0,
            editedBlock: null,
            reasons: limits.map((l) => l.reason),
            cell: null,
          };
        }),
        paths: [],
      };
    },

    planParagraphEdit(ctx, _fonts, paragraphId): PlanBase {
      probe.calls.push('plan');
      const p = paragraphOf(ctx, paragraphId);
      const limits = limitsOf(ctx, paragraphId);
      const first = ctx.model.chars[p.chars[0]!]!;
      const [bx0, by0, bx1, by1] = p.bbox;
      const cx = (bx0 + bx1) / 2;
      const cy = (by0 + by1) / 2;
      const block = ctx.editBlocks.find((b) => {
        const box = blockBoxes.get(b.editId);
        return box && cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
      });
      const format: ParagraphFormat = {
        area: p.bbox,
        align: 'left',
        firstLineIndent: 0,
        lineHeight: p.lineHeight ?? first.size * 1.2,
        firstBaselineOffset: first.origin[1] - by0,
      };
      return {
        pageIndex: ctx.pageIndex,
        paragraphId,
        target: {
          pageIndex: ctx.pageIndex,
          glyphSeqs: p.chars.map((ci) => ctx.model.chars[ci]!.glyphSeq),
          editedBlock: block?.editId ?? null,
          bbox: p.bbox,
        },
        editable: limits.length === 0,
        limits,
        warnings: [...probe.planWarnings],
        runs: [
          {
            text: p.text,
            style: {
              sourceChar: p.chars[0]!,
              fontId: first.fontId,
              size: first.size,
              bold: false,
              italic: false,
              color: null,
            },
          },
        ],
        charIndexOfOffset: [...p.text].map((_, k) => p.chars[Math.min(k, p.chars.length - 1)]!),
        format,
        areaLimit: ctx.layout.bounds,
        insertion:
          limits.length === 0 ? { container: 'page', mode: 'before-bt', mcidKept: null } : null,
        removal: { ops: 1, partialOps: 0, formInstances: 0 },
        save: { method: 'full', changes: ['content-stream'] },
        planMs: 0,
      };
    },

    prepareParagraphEdit(ctx, plan, editId): PreparedEdit {
      probe.calls.push('prepare');
      if (probe.failNext.prepare) {
        probe.failNext.prepare = false;
        throw new Error('fake prepare 실패');
      }
      const doc = ctx.doc;
      if (plan.target.editedBlock) {
        const block = ctx.editBlocks.find((b) => b.editId === plan.target.editedBlock)!;
        return {
          editId: block.editId,
          target: plan.target,
          block,
          changedObjects: [block.objectNumber],
        };
      }
      // Removal: cuts out the bytes of text-show operations made up only of the paragraph glyphs.
      const seqs = new Set(plan.target.glyphSeqs);
      const ops = ctx.map.ops.filter(
        (op) =>
          op.kind === 'text-show' &&
          op.text &&
          op.text.glyphs.length > 0 &&
          op.text.glyphs.every((g) => g.seq !== null && seqs.has(g.seq)),
      );
      if (ops.length === 0) throw new Error('fake prepare: 제거할 연산 없음');
      const streamNum = ops[0]!.stream.objectNumber;
      const stream = doc.newIndirect(streamNum);
      const buf = stream.readStream();
      const original = buf.asUint8Array().slice();
      buf.destroy();
      // Edit block Form and its invocation.
      const page = doc.loadPage(ctx.pageIndex);
      const pageObj = page.getObject();
      const block = doc.addStream('', {
        Type: doc.newName('XObject'),
        Subtype: doc.newName('Form'),
        BBox: [0, 0, ctx.layout.bounds[2], ctx.layout.bounds[3]],
      });
      block.put('PdfEditorEdit', doc.newString(editId));
      block.put('PdfEditorFormat', doc.newString(''));
      const resources = ownResources(doc, pageObj, null);
      const name = putUniqueResource(ownSubdict(doc, resources, 'XObject'), block, 'EB');
      const pageNum = pageObj.asIndirect();
      page.destroy();
      const enc = new TextEncoder();
      let bytes: Uint8Array<ArrayBuffer> = original;
      const sorted = [...ops].sort((a, b) => b.range[0] - a.range[0]);
      for (const op of sorted) {
        bytes = concat([bytes.subarray(0, op.range[0]), bytes.subarray(op.range[1])]);
      }
      // Do must be outside a text object, so it is inserted right before the BT containing the first removed operation.
      const firstStart = Math.min(...ops.map((o) => o.range[0]));
      const insertAt = new TextDecoder('latin1').decode(original).lastIndexOf('BT', firstStart);
      bytes = concat([
        bytes.subarray(0, insertAt),
        enc.encode(` q /${name} Do Q `),
        bytes.subarray(insertAt),
      ]);
      stream.writeStream(bytes);
      return {
        editId,
        target: plan.target,
        block: { editId, objectNumber: block.asIndirect() },
        changedObjects: [streamNum, block.asIndirect(), pageNum],
      };
    },

    // ---- M4 paths: a minimal implementation handling only page content where one line = one path (of the form `x y w h re f`) ----

    planPathEditability(ctx) {
      return ctx.model.paths
        .map((path, pathIndex) => ({ path, pathIndex }))
        .filter(({ path }) => path.op === 'fill' || path.op === 'stroke')
        .map(({ path, pathIndex }) => ({
          pathIndex,
          paintSeq: path.paintSeq,
          bbox: path.bbox,
          editable: true,
          reasons: [],
        }));
    },

    planPathEdit(ctx, paintSeqs): Omit<PathEditPlan, 'revision'> {
      probe.calls.push('planPath');
      const lines = paintSeqs.map((seq) => pathLineOf(ctx, seq));
      const bbox = lines
        .map((l) => l.bbox)
        .reduce((a, b) => [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[2], b[2]),
          Math.max(a[3], b[3]),
        ]);
      const first = ctx.model.paths.find((p) => p.paintSeq === paintSeqs[0])!;
      return {
        pageIndex: ctx.pageIndex,
        target: {
          pageIndex: ctx.pageIndex,
          paintSeqs,
          fingerprints: lines.map((l) => l.fingerprint),
          bbox,
        },
        editable: true,
        limits: [],
        warnings: [],
        fill: first.op === 'fill' ? first.color : null,
        stroke: first.op === 'stroke' ? first.color : null,
        lineWidth: first.lineWidth,
        planMs: 0,
      };
    },

    preparePathEdit(ctx, plan, editId): PreparedPathEdit {
      probe.calls.push('preparePath');
      if (probe.failNextPath.prepare) {
        probe.failNextPath.prepare = false;
        throw new Error('fake preparePath 실패');
      }
      const lines = plan.target.paintSeqs.map((seq) => pathLineOf(ctx, seq));
      const streamNum = lines[0]!.streamNum;
      const stream = ctx.doc.newIndirect(streamNum);
      const buf = stream.readStream();
      const original = buf.asUint8Array().slice();
      buf.destroy();
      pathSnapshots.set(editId, { streamNum, original, lines });
      return { editId, target: plan.target, changedObjects: [streamNum] };
    },

    writePathEdit(ctx, prepared, edit) {
      probe.calls.push('writePath');
      if (probe.failNextPath.write) {
        probe.failNextPath.write = false;
        throw new Error('fake writePath 실패');
      }
      const snap = pathSnapshots.get(prepared.editId)!;
      const height = ctx.layout.bounds[3];
      const decoder = new TextDecoder('latin1');
      let bytes: Uint8Array<ArrayBuffer> = snap.original;
      let bbox: Rect | null = null;
      for (const line of [...snap.lines].sort((a, b) => b.range[0] - a.range[0])) {
        const [text, box] = rewritePathLine(line, edit, height);
        bytes = concat([
          bytes.subarray(0, line.range[0]),
          new TextEncoder().encode(text),
          bytes.subarray(line.range[1]),
        ]);
        bbox = bbox ? unionBox(bbox, box) : box;
      }
      void decoder;
      ctx.doc.newIndirect(snap.streamNum).writeStream(bytes);
      probe.pathWrites.push({ editId: prepared.editId, edit });
      if (probe.failNextPath.writeAfter) {
        probe.failNextPath.writeAfter = false;
        throw new Error('fake writePath(쓴 뒤) 실패');
      }
      return {
        bbox: bbox!,
        writeMs: 0,
        ...(probe.pathWriteWarnings ? { warnings: [...probe.pathWriteWarnings] } : {}),
      };
    },

    layoutParagraph(input: ReflowInput): ReflowResult {
      probe.calls.push('layout');
      return fakeLayout(input);
    },

    writeEditBlock(ctx, prepared, runs, format, result) {
      probe.calls.push('write');
      if (probe.failNext.write) {
        probe.failNext.write = false;
        throw new Error('fake write 실패');
      }
      const doc = ctx.doc;
      const block = doc.newIndirect(prepared.block.objectNumber);
      const pageHeight = ctx.layout.bounds[3];
      const fontsUsed = new Set<string>();
      const ops: string[] = [];
      for (const line of result.lines) {
        // Glyphs that continue with the same font are written together.
        let start = 0;
        while (start < line.length) {
          let end = start + 1;
          while (end < line.length && line[end]!.faceKey === line[start]!.faceKey) end++;
          const group = line.slice(start, end);
          const f = group[0]!;
          const hex = group.map((g) =>
            [...g.code].map((b) => b.toString(16).padStart(2, '0')).join(''),
          );
          ops.push(
            `BT /${f.faceKey} ${f.size} Tf 1 0 0 1 ${fmt(f.x)} ${fmt(pageHeight - f.y)} Tm <${hex.join('')}> Tj ET`,
          );
          fontsUsed.add(f.faceKey);
          if (f.faceKey === 'FB') group.forEach((g) => fonts?.usedGids.add(g.gid));
          start = end;
        }
      }
      // Resources: F1 takes the font from the page resources, and FB is the current fallback font object.
      const resources = doc.newDictionary();
      const fontDict = doc.newDictionary();
      if (fontsUsed.has('F1')) {
        const page = doc.loadPage(ctx.pageIndex);
        fontDict.put('F1', page.getObject().get('Resources').get('Font').get('F1'));
        page.destroy();
      }
      if (fontsUsed.has('FB')) fontDict.put('FB', fonts!.fallbackRef());
      resources.put('Font', fontDict);
      block.put('Resources', resources);
      block.writeStream(ops.join('\n'));
      block.put(
        'PdfEditorFormat',
        doc.newString(JSON.stringify({ runs: runs.map((r) => r.text), format })),
      );
      blockBoxes.set(prepared.editId, result.summary.contentBox);
      if (probe.failNext.writeAfter) {
        probe.failNext.writeAfter--;
        throw new Error('fake write(쓴 뒤) 실패');
      }
      return { streamBytes: ops.join('\n').length, resources: [...fontsUsed], writeMs: 0 };
    },

    listEditBlocks(doc, pageIndex): EditBlockRef[] {
      probe.calls.push('list');
      const page = doc.loadPage(pageIndex);
      try {
        const xobjects = page.getObject().getInheritable('Resources').get('XObject');
        const blocks: EditBlockRef[] = [];
        if (xobjects.isDictionary()) {
          xobjects.forEach((value) => {
            // Whether it is a stream is only known from the indirect reference (object number). A dictionary after resolve() has isStream() false.
            const id = value.get('PdfEditorEdit');
            if (value.isIndirect() && value.isStream() && !id.isNull()) {
              blocks.push({ editId: id.asString(), objectNumber: value.asIndirect() });
            }
          });
        }
        return blocks;
      } finally {
        page.destroy();
      }
    },

    releaseEdit() {
      probe.releaseCalls++;
    },

    recordEditMetadata(doc, info) {
      probe.metadataCalls.push(info);
      const infoDict = doc.getTrailer().get('Info');
      infoDict.put(
        'PdfEditorEdits',
        doc.newString(
          `pages=${info.pages.map((p) => p + 1).join(',')}; structure=${info.structureNotUpdated ? 'not-updated' : 'n/a'}`,
        ),
      );
    },

    blockBounds(doc, pageIndex, objectNumber) {
      const bbox = doc.newIndirect(objectNumber).resolve().get('BBox');
      if (!bbox.isArray()) return null;
      const page = doc.loadPage(pageIndex);
      try {
        const [x0, y0, x1, y1] = mupdf.Rect.transform(
          [0, 1, 2, 3].map((i) => bbox.get(i).asNumber()) as Rect,
          page.getTransform(),
        );
        return [x0, y0, x1, y1];
      } finally {
        page.destroy();
      }
    },
  };
  return adapter;
}

/** Fixed-width (0.5em) line breaking. Lines break after spaces. */
function fakeLayout(input: ReflowInput): ReflowResult {
  const { text, segments, format, areaLimit } = input;
  const advance = (seg: FontSegment): number =>
    seg.size * (seg.face?.kind === 'fallback' ? 1 : 0.5);
  const segAt = (index: number): FontSegment => {
    const seg = segments.find((s) => s.start <= index && index < s.end);
    if (!seg) throw new Error('fake layout: segments 가 text 를 덮지 않음');
    return seg;
  };
  let area: Rect = [...format.area];
  const placeLines = (): { lines: WritableGlyph[][]; boxes: Rect[] } => {
    const lines: WritableGlyph[][] = [];
    const boxes: Rect[] = [];
    let current: WritableGlyph[] = [];
    let x = area[0];
    let baseline = area[1] + format.firstBaselineOffset;
    const flush = (): void => {
      lines.push(current);
      current = [];
      x = area[0];
      baseline += format.lineHeight;
    };
    let i = 0;
    while (i < text.length) {
      const ch = String.fromCodePoint(text.codePointAt(i)!);
      const seg = segAt(i);
      if (ch === '\n') {
        flush();
        i += ch.length;
        continue;
      }
      if (seg.face === null) {
        i += ch.length;
        continue; // glyph-missing: not written
      }
      const w = advance(seg);
      if (x + w > area[2] + 1e-6 && current.length > 0) flush();
      const code =
        seg.face.kind === 'fallback'
          ? new Uint8Array([
              (koreanFont.encodeCharacter(ch) >> 8) & 255,
              koreanFont.encodeCharacter(ch) & 255,
            ])
          : new Uint8Array([ch.charCodeAt(0) & 255]);
      current.push({
        offset: i,
        length: ch.length,
        faceKey: seg.face.key,
        code,
        gid: seg.face.kind === 'fallback' ? koreanFont.encodeCharacter(ch) : ch.charCodeAt(0),
        x,
        y: baseline,
        size: seg.size,
        pdfWidth: 1000,
        syntheticBold: false,
        syntheticItalic: false,
        runIndex: seg.runIndex,
      });
      x += w;
      i += ch.length;
    }
    flush();
    for (const line of lines) {
      if (line.length === 0) continue;
      const first = line[0]!;
      const last = line[line.length - 1]!;
      boxes.push([
        first.x,
        first.y - first.size,
        last.x + last.size * 0.5,
        first.y + first.size * 0.3,
      ]);
    }
    return { lines, boxes };
  };
  const placed = placeLines();
  const bottomOf = (p: { boxes: Rect[] }): number => Math.max(area[1], ...p.boxes.map((b) => b[3]));
  // Contract 5.4 (2026-10-20): on overflow, the bottom edge is lowered automatically to the required height (up to the limit).
  let overflow = bottomOf(placed) > area[3] + 0.5;
  if (overflow) {
    area = [area[0], area[1], area[2], Math.min(areaLimit[3], bottomOf(placed))];
    overflow = bottomOf(placed) > area[3] + 0.5;
  }
  const allBoxes =
    placed.boxes.length > 0 ? placed.boxes : [[area[0], area[1], area[0], area[1]] as Rect];
  const contentBox = allBoxes.reduce<Rect>(
    (acc, b) => [
      Math.min(acc[0], b[0]),
      Math.min(acc[1], b[1]),
      Math.max(acc[2], b[2]),
      Math.max(acc[3], b[3]),
    ],
    allBoxes[0]!,
  );
  const summary: ReflowSummary = {
    lines: placed.lines.map((line, k) => ({
      baseline: line[0]?.y ?? area[1] + format.firstBaselineOffset,
      x0: line[0]?.x ?? area[0],
      x1: line.length > 0 ? line[line.length - 1]!.x + line[line.length - 1]!.size * 0.5 : area[0],
      ascent: 0.9 * (line[0]?.size ?? 10),
      descent: 0.2 * (line[0]?.size ?? 10),
      start: line[0]?.offset ?? 0,
      end: line.length > 0 ? line[line.length - 1]!.offset + line[line.length - 1]!.length : 0,
      hardBreak:
        k < placed.lines.length - 1 && text[(line[line.length - 1]?.offset ?? 0) + 1] === '\n',
    })),
    glyphs: placed.lines.flat().map((g) => ({
      offset: g.offset,
      length: g.length,
      font:
        g.faceKey === 'FB'
          ? { kind: 'fallback' as const }
          : { kind: 'original' as const, fontId: 0 },
      x: g.x,
      y: g.y,
      advance: g.size * 0.5,
      size: g.size,
    })),
    contentBox,
    area,
    overflow,
    reflowMs: 0,
  };
  return { summary, lines: placed.lines };
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

interface PathLine {
  streamNum: number;
  /** Stream byte range of the whole line (excluding the newline). */
  range: [number, number];
  /** The 4 construction numbers and the paint operator. */
  nums: [number, number, number, number];
  paintOp: string;
  bbox: Rect;
  fingerprint: PathFingerprint;
}

/** Finds the line (`x y w h re f`) with the paint operation that has paintSeq. */
function pathLineOf(ctx: ParagraphEditContext, paintSeq: number): PathLine {
  const op = ctx.map.ops.find((o) => o.paintSeq?.includes(paintSeq) && o.kind === 'path-paint');
  const path = ctx.model.paths.find((p) => p.paintSeq === paintSeq);
  if (!op || !path) throw new Error(`fake: paintSeq ${paintSeq} 의 패스 연산 없음`);
  const stream = ctx.doc.newIndirect(op.stream.objectNumber);
  const buf = stream.readStream();
  const text = new TextDecoder('latin1').decode(buf.asUint8Array());
  buf.destroy();
  const start = text.lastIndexOf('\n', op.range[0]) + 1;
  const endNl = text.indexOf('\n', op.range[1]);
  const end = endNl < 0 ? text.length : endNl;
  const match = /^\s*(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re ([fSB])\s*$/.exec(
    text.slice(start, end),
  );
  if (!match) throw new Error(`fake: 지원하지 않는 패스 줄: ${text.slice(start, end)}`);
  const nums = [1, 2, 3, 4].map((i) => Number(match[i])) as [number, number, number, number];
  return {
    streamNum: op.stream.objectNumber,
    range: [start, end],
    nums,
    paintOp: match[5]!,
    bbox: path.bbox,
    fingerprint: {
      paintOp: match[5]!,
      constructOpCount: 1,
      bbox: path.bbox,
      constructHash: `re:${nums.join(',')}`,
    },
  };
}

function unionBox(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Rewrites the line with the edit contents (size/move affine, fill color, deletion). Returns: [new line text, new page box]. */
function rewritePathLine(line: PathLine, edit: PathEdit, pageHeight: number): [string, Rect] {
  if (edit.delete) return ['n', line.bbox];
  const [x, y, w, h] = line.nums;
  let [px0, py0, px1, py1] = [x, pageHeight - y - h, x + w, pageHeight - y];
  if (edit.transform) {
    const [a, , , d, e, f] = edit.transform;
    [px0, px1] = [a * px0 + e, a * px1 + e];
    [py0, py1] = [d * py0 + f, d * py1 + f];
  }
  const box: Rect = [
    Math.min(px0, px1),
    Math.min(py0, py1),
    Math.max(px0, px1),
    Math.max(py0, py1),
  ];
  const body = `${fmt(box[0])} ${fmt(pageHeight - box[3])} ${fmt(box[2] - box[0])} ${fmt(box[3] - box[1])} re ${line.paintOp}`;
  if (!edit.fill) return [body, box];
  const [r, g, b] = edit.fill;
  return [`q ${fmt(r)} ${fmt(g)} ${fmt(b)} rg ${body} Q`, box];
}
