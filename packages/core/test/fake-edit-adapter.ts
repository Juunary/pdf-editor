/**
 * 테스트용 가짜 편집 어댑터(docs/m3-core.md 3.2). pdf-ops·reflow 의 M3 함수가 병합되기 전에 core 편집 엔진을
 * 실제 MuPDF 문서·저널 위에서 검증하기 위한 최소 구현이다.
 * - 제거: 문단 글자의 text-show 연산을 쪽 콘텐츠 스트림에서 잘라 내고(바이트 교체), 그 자리에 `q /EBn Do Q` 를 넣는다.
 * - 편집 블록: `/PdfEditorEdit` 를 가진 Form XObject. 줄마다 `Tm` + `Tj` 로 쓴다.
 * - 폰트: 라틴은 쪽 리소스의 F1(Helvetica), 한글은 폴백 폰트(계약 D4 의 수명 규칙을 그대로 흉내: 쓸 때마다 객체가
 *   있는지 확인하고 없으면 로더 바이트로 현재 작업 안에서 다시 넣는다).
 * 가정: 쪽 콘텐츠가 스트림 하나, /Rotate 0, MediaBox 원점 0.
 */
import * as mupdf from 'mupdf';
import {
  FontManager,
  ownResources,
  ownSubdict,
  putUniqueResource,
  subsetFontBytes,
  type EditBlockRef,
  type ParagraphEditContext,
  type PreparedEdit,
} from '@pdf-editor/pdf-ops';
import type {
  EditWarning,
  PageEditability,
  ParagraphEditPlan,
  ParagraphFormat,
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
const UNSUPPORTED = /[☃]/; // 눈사람: 원본·폴백 모두 없음(glyph-missing)

export interface FakeAdapterProbe {
  /** 로더가 돌려준 폴백 바이트 길이 목록(임베딩 때마다 하나). */
  embeddedBytes: Uint8Array[];
  /** recordEditMetadata 호출 인자. */
  metadataCalls: { pages: number[]; structureNotUpdated: boolean }[];
  /** 호출 이력(prepare·write·list 등). */
  calls: string[];
  /** 다음 prepare / write 호출을 실패시킨다. */
  failNext: { prepare?: boolean; write?: boolean; finalize?: boolean };
}

export interface FakeAdapter extends EditAdapter {
  probe: FakeAdapterProbe;
}

class FakeFonts extends FontManager {
  readonly #doc: mupdf.PDFDocument;
  readonly #load: () => Uint8Array;
  readonly #probe: FakeAdapterProbe;
  fallbackRef: mupdf.PDFObject | null = null;
  readonly usedGids = new Set<number>();

  constructor(doc: mupdf.PDFDocument, load: () => Uint8Array, probe: FakeAdapterProbe) {
    super(doc, load);
    this.#doc = doc;
    this.#load = load;
    this.#probe = probe;
  }

  /** 계약 D4: 폴백 폰트 객체가 있는지 확인(/PdfEditorFallback)하고 없으면 현재 작업 안에서 다시 넣는다. */
  ensureFallback(): mupdf.PDFObject {
    const ref = this.fallbackRef;
    if (ref && ref.resolve().isDictionary() && !ref.resolve().get('PdfEditorFallback').isNull()) {
      return ref;
    }
    const bytes = this.#load();
    this.#probe.embeddedBytes.push(bytes);
    const embedded = this.#doc.addFont(new mupdf.Font('NotoSansKR', bytes));
    embedded.put('PdfEditorFallback', this.#doc.newBoolean(true));
    this.fallbackRef = embedded;
    return embedded;
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
    runs.forEach((run, runIndex) => {
      for (const ch of run.text) {
        const kind = HANGUL.test(ch) ? 'fallback' : UNSUPPORTED.test(ch) ? 'missing' : 'original';
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
      this.ensureFallback();
      warnings.push({ kind: 'font-fallback', message: '폴백 폰트 사용', rects: [] });
    }
    if (missing) warnings.push({ kind: 'glyph-missing', message: '글리프 없음', rects: [] });
    return { segments, warnings };
  }

  /** 저장 작업 안에서: 쓴 글리프만 남긴 서브셋으로 FontFile2 를 바꾼다(작업을 버리면 되돌아간다). */
  override finalizeForSave(): void {
    if (this.#probe.failNext.finalize) {
      this.#probe.failNext.finalize = false;
      throw new Error('fake finalize 실패');
    }
    const ref = this.fallbackRef;
    if (!ref || !ref.resolve().isDictionary() || this.usedGids.size === 0) return;
    const file = ref.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    const subset = subsetFontBytes('NotoSansKR', this.#load(), this.usedGids);
    file.writeStream(subset);
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
    embeddedBytes: [],
    metadataCalls: [],
    calls: [],
    failNext: {},
  };
  /** 편집 블록 영역(plan 이 재편집 대상을 알아보는 데 쓴다). */
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

    createFonts(doc, load) {
      fonts = new FakeFonts(doc, load, probe);
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
          };
        }),
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
        overflow: null,
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
        warnings: [],
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
      // 제거: 문단 글리프만으로 이루어진 text-show 연산의 바이트를 잘라 낸다.
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
      // 편집 블록 Form 과 호출.
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
      // Do 는 텍스트 객체 밖이어야 하므로 첫 제거 연산이 속한 BT 바로 앞에 넣는다.
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
        // 같은 폰트가 이어지는 글리프끼리 묶어 쓴다.
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
      // 리소스: F1 은 쪽 리소스의 폰트를 가져오고, FB 는 현재 폴백 폰트 객체.
      const resources = doc.newDictionary();
      const fontDict = doc.newDictionary();
      if (fontsUsed.has('F1')) {
        const page = doc.loadPage(ctx.pageIndex);
        fontDict.put('F1', page.getObject().get('Resources').get('Font').get('F1'));
        page.destroy();
      }
      if (fontsUsed.has('FB')) fontDict.put('FB', fonts!.ensureFallback());
      resources.put('Font', fontDict);
      block.put('Resources', resources);
      block.writeStream(ops.join('\n'));
      block.put(
        'PdfEditorFormat',
        doc.newString(JSON.stringify({ runs: runs.map((r) => r.text), format })),
      );
      blockBoxes.set(prepared.editId, result.summary.contentBox);
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
            // 스트림 여부는 간접 참조(객체 번호)로만 알 수 있다. resolve() 한 사전은 isStream() 이 false 다.
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

/** 고정 폭(0.5em) 줄 나눔. 공백 뒤에서 줄을 바꾼다. */
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
  const placeLines = (scale: number): { lines: WritableGlyph[][]; boxes: Rect[] } => {
    const lines: WritableGlyph[][] = [];
    const boxes: Rect[] = [];
    let current: WritableGlyph[] = [];
    let x = area[0];
    let baseline = area[1] + format.firstBaselineOffset * scale;
    const flush = (): void => {
      lines.push(current);
      current = [];
      x = area[0];
      baseline += format.lineHeight * scale;
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
        continue; // glyph-missing: 쓰지 않음
      }
      const w = advance(seg) * scale;
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
        size: seg.size * scale,
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
  let scale = 1;
  let placed = placeLines(scale);
  const bottomOf = (p: { boxes: Rect[] }): number => Math.max(area[1], ...p.boxes.map((b) => b[3]));
  let overflow = bottomOf(placed) > area[3] + 0.5;
  if (overflow && format.overflow === 'expand') {
    area = [area[0], area[1], area[2], Math.min(areaLimit[3], bottomOf(placed))];
    overflow = bottomOf(placed) > area[3] + 0.5;
  } else if (overflow && format.overflow === 'shrink') {
    for (let s = 0.99; s >= 0.8; s -= 0.01) {
      scale = Math.round(s * 100) / 100;
      placed = placeLines(scale);
      if (bottomOf(placed) <= area[3] + 0.5) break;
    }
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
    fontScale: scale,
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
