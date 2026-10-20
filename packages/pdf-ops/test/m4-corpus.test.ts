/**
 * M4 코퍼스 측정(docs/m4-contract.md 4.2 판정 시간·5.1 V1–V4·6.1 표본). 결과는 docs/m4-pdf-ops.md.
 * 환경 변수가 없으면 건너뛴다. 결과 JSON 은 git 밖에 둔다.
 *
 *   M4_CORPUS_DIR=<PDF 폴더> [M4_CORPUS_OUT=<json 접두>] [M4_CORPUS_MODE=scan|render|all]
 *   [M4_CORPUS_FILES=a.pdf,b.pdf] [M4_CORPUS_ENGINES=mupdf,pdfjs,poppler]
 *
 * scan: 모든 쪽의 패스 판정(개수·편집 가능·사유·판정 시간), 끼인 연산(V1), 표 셀 판정(셀 편집 가능 비율·사유).
 * render: 6.1 표본 쪽에서 V2(q/Q 감싸기)·V3(피연산자 9자리 다시 쓰기) 쪽 전체 렌더 비교, 패스 편집 3종
 *   (채움 색·선 두께 ×2·10pt 이동)과 셀 편집 3종(같은 텍스트·숫자 자릿수 +1·한글 덧붙이기)의 변경 허용 영역 밖 렌더
 *   차이, 셀 커밋 뒤 표 감지 유지(V4).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { PathEdit, SourceOp } from '@pdf-editor/shared-types';
import { layoutParagraph } from '@pdf-editor/reflow';
import {
  FontManager,
  planPageEditability,
  planParagraphEdit,
  planPathEdit,
  planPathEditability,
  prepareParagraphEdit,
  preparePathEdit,
  writeEditBlock,
  writePathEdit,
  type ParagraphEditContext,
} from '../src/index.js';
import { fmt9 } from '../src/edit-common.js';
import { parseContentOpsLenient } from '../src/content-stream.js';
import { readStreamBytes } from '../src/mupdf-util.js';
import { applyReplacements, type Replacement } from '../src/text-remove.js';
import { fallbackFor, newEditId } from './helpers/edit-driver.js';
import { loadModules, pageContext } from './helpers/edit-context.js';
import {
  diffOutside,
  pageText,
  raster,
  squash,
  type Engine,
  type Raster,
} from './helpers/engines.js';

const dir = process.env.M4_CORPUS_DIR;
const out = process.env.M4_CORPUS_OUT;
const mode = process.env.M4_CORPUS_MODE ?? 'all';
const only = process.env.M4_CORPUS_FILES?.split(',');
const engineList = (process.env.M4_CORPUS_ENGINES ?? 'mupdf,pdfjs,poppler').split(',') as Engine[];

const PAINTS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const STROKES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const FILLS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

const open = (b: Uint8Array) =>
  mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;
const save = (d: mupdf.PDFDocument) =>
  d.saveToBuffer('garbage=yes,compress').asUint8Array().slice();
const tally = (m: Record<string, number>, k: string, n = 1) => (m[k] = (m[k] ?? 0) + n);
const files = () => readdirPdf(dir!).filter((f) => !only || only.includes(f));
function readdirPdf(d: string): string[] {
  const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')) as {
    documents: { id?: string; file?: string }[];
  };
  const names = m.documents.map((x) => x.file ?? `${x.id}.pdf`);
  return names.filter((n) => n.endsWith('.pdf'));
}
const ctxOf = (doc: mupdf.PDFDocument, p: number) =>
  pageContext(doc, p, { segments: true, fixedGroups: true });
const pageOrigin = (doc: mupdf.PDFDocument, p: number): [number, number] => {
  const page = doc.loadPage(p);
  try {
    const b = page.getBounds();
    return [b[0], b[1]];
  } finally {
    page.destroy();
  }
};

// ---------------------------------------------------------------- scan

interface PageScan {
  file: string;
  page: number;
  paths: number;
  editablePaths: number;
  pathReasons: Record<string, number>;
  pathMs: number;
  /** V1: 대상 칠하기 중 구성 ~ 칠하기 사이에 다른 연산이 낀 칠하기 수와 끼인 연산 이름별 수. */
  interleavedPaints: number;
  interleavedOps: Record<string, number>;
  spansStreams: number;
  tables: number;
  cells: number;
  editableCells: number;
  cellReasons: Record<string, number>;
  cellMs: number;
  ctxMs: number;
  error?: string;
}

function v1Counts(ctx: ParagraphEditContext) {
  const ops = ctx.map.ops;
  const names: Record<string, number> = {};
  let paints = 0;
  let spans = 0;
  for (const op of ops) {
    if (op.kind !== 'path-paint' || !PAINTS.has(op.op) || !op.paintSeq?.length) continue;
    const ids = op.pathOps ?? [];
    if (ids.length === 0) continue;
    if (ids.some((id) => ops[id]!.stream.objectNumber !== op.stream.objectNumber)) spans++;
    let hit = false;
    for (let id = ids[0]! + 1; id < op.id; id++) {
      const o = ops[id]!;
      if (o.kind === 'path-construct' || o.op === 'W' || o.op === 'W*') continue;
      tally(names, o.op);
      hit = true;
    }
    if (hit) paints++;
  }
  return { paints, names, spans };
}

function scanPage(file: string, doc: mupdf.PDFDocument, p: number): PageScan {
  const t0 = performance.now();
  const ctx = ctxOf(doc, p);
  const ctxMs = performance.now() - t0;
  const t1 = performance.now();
  const list = planPathEditability(ctx);
  const pathMs = performance.now() - t1;
  const pathReasons: Record<string, number> = {};
  for (const it of list) for (const r of it.reasons) tally(pathReasons, r);
  const v1 = v1Counts(ctx);
  const res: PageScan = {
    file,
    page: p + 1,
    paths: list.length,
    editablePaths: list.filter((x) => x.editable).length,
    pathReasons,
    pathMs,
    interleavedPaints: v1.paints,
    interleavedOps: v1.names,
    spansStreams: v1.spans,
    tables: ctx.layout.tables.length,
    cells: 0,
    editableCells: 0,
    cellReasons: {},
    cellMs: 0,
    ctxMs,
  };
  if (ctx.layout.tables.length > 0) {
    const fm = new FontManager(doc, fallbackFor(doc, false));
    const t2 = performance.now();
    const pe = planPageEditability(ctx, fm);
    res.cellMs = performance.now() - t2;
    const cells = pe.paragraphs.filter((e) => e.cell !== null);
    res.cells = cells.length;
    res.editableCells = cells.filter((e) => e.editable).length;
    for (const c of cells) for (const r of c.reasons) tally(res.cellReasons, r);
  }
  return res;
}

// ---------------------------------------------------------------- render

const NONE: PathEdit = {
  transform: null,
  fill: null,
  stroke: null,
  lineWidth: null,
  points: null,
  delete: false,
};

/** 편집 가능 패스마다 replace(구성 연산, 칠하기) 로 스트림을 고친다(Form 은 그 객체를 직접). */
function rewriteAll(
  doc: mupdf.PDFDocument,
  ctx: ParagraphEditContext,
  f: (constructs: SourceOp[], paint: SourceOp, bytes: Uint8Array) => Replacement[],
): number {
  const editable = new Set(
    planPathEditability(ctx)
      .filter((x) => x.editable)
      .map((x) => x.paintSeq),
  );
  const lists = new Map<number, Replacement[]>();
  const seen = new Set<string>();
  const bytesOf = new Map<number, Uint8Array>();
  const get = (n: number) => {
    let b = bytesOf.get(n);
    if (!b) {
      b = readStreamBytes(doc.newIndirect(n));
      bytesOf.set(n, b);
    }
    return b;
  };
  let n = 0;
  for (const op of ctx.map.ops) {
    if (!op.paintSeq?.length || !editable.has(Math.min(...op.paintSeq))) continue;
    const key = `${op.stream.objectNumber}:${op.range[0]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const constructs = (op.pathOps ?? []).map((id) => ctx.map.ops[id]!);
    const num = op.stream.objectNumber;
    const l = lists.get(num) ?? [];
    l.push(...f(constructs, op, get(num)));
    lists.set(num, l);
    n++;
  }
  for (const [num, l] of lists) doc.newIndirect(num).writeStream(applyReplacements(get(num), l));
  return n;
}

async function fullDiff(
  before: Uint8Array,
  after: Uint8Array,
  p: number,
  cache: Map<string, Raster>,
) {
  const out: Record<string, number> = {};
  for (const e of engineList) {
    let a = cache.get(e);
    if (!a) {
      a = await raster(e, before, p);
      cache.set(e, a);
    }
    out[e] = diffOutside(a, await raster(e, after, p), []);
  }
  return out;
}

interface EditSample {
  kind: string;
  target: string;
  diffOutside: Record<string, number>;
  textSame?: boolean;
  shift?: number;
  warnings?: string[];
  v4?: { tableKept: boolean; cellParagraphs: number; cellTable: boolean };
  /** 셀: 시작 정렬·상한에 막힌 초과·시작 텍스트. */
  align?: string;
  overflow?: boolean;
  start?: string;
  error?: string;
}

async function pathSamples(
  bytes: Uint8Array,
  p: number,
  cache: Map<string, Raster>,
): Promise<EditSample[]> {
  const doc0 = open(bytes);
  const ctx0 = ctxOf(doc0, p);
  const list = planPathEditability(ctx0)
    .filter((x) => x.editable)
    .sort(
      (a, b) =>
        (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) -
        (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]),
    )
    .slice(0, 5);
  const text0 = squash(await pageText('mupdf', bytes, p));
  const origin = pageOrigin(doc0, p);
  doc0.destroy();
  const out: EditSample[] = [];
  for (const item of list) {
    for (const kind of ['fill', 'width', 'move'] as const) {
      const doc = open(bytes);
      const s: EditSample = { kind, target: `paint ${item.paintSeq}`, diffOutside: {} };
      try {
        const ctx = ctxOf(doc, p);
        const plan = planPathEdit(ctx, [item.paintSeq]);
        const op = ctx.map.ops[ctx.linkage.pathOp[item.pathIndex]!]!;
        let e: PathEdit;
        if (kind === 'fill') {
          e = FILLS.has(op.op)
            ? { ...NONE, fill: [0.9, 0.1, 0.1] }
            : { ...NONE, stroke: [0.9, 0.1, 0.1] };
        } else if (kind === 'width') {
          if (!STROKES.has(op.op)) {
            s.error = 'skip: 선 없음';
            out.push(s);
            continue;
          }
          const w = plan.lineWidth ?? 0;
          e = { ...NONE, lineWidth: w > 0 ? w * 2 : 0.5 };
        } else e = { ...NONE, transform: [1, 0, 0, 1, 10, 0] };
        const prep = preparePathEdit(ctx, plan, newEditId());
        const r = writePathEdit(ctx, prep, e);
        const after = save(doc);
        for (const eng of engineList) {
          let a = cache.get(eng);
          if (!a) {
            a = await raster(eng, bytes, p);
            cache.set(eng, a);
          }
          s.diffOutside[eng] = diffOutside(
            a,
            await raster(eng, after, p),
            [plan.target.bbox, r.bbox],
            origin,
          );
        }
        s.textSame = squash(await pageText('mupdf', after, p)) === text0;
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      } finally {
        doc.destroy();
      }
      out.push(s);
    }
  }
  return out;
}

async function cellSamples(
  bytes: Uint8Array,
  p: number,
  cache: Map<string, Raster>,
): Promise<EditSample[]> {
  const doc0 = open(bytes);
  const ctx0 = ctxOf(doc0, p);
  const fm0 = new FontManager(doc0, fallbackFor(doc0, false));
  const entries = planPageEditability(ctx0, fm0).paragraphs.filter((e) => e.cell && e.editable);
  const textOf = (id: number) => ctx0.layout.paragraphs.find((q) => q.id === id)!.text;
  const header = entries.find((e) => e.cell!.row === 0 && /\p{L}/u.test(textOf(e.paragraphId)));
  const numeric = entries.find(
    (e) =>
      e.cell!.row > 0 &&
      /^[\s\d,.()$%−-]+$/u.test(textOf(e.paragraphId)) &&
      /\d/.test(textOf(e.paragraphId)),
  );
  const word = entries.find((e) => e.cell!.row > 0 && /\p{L}{3}/u.test(textOf(e.paragraphId)));
  const picks = [header, numeric, word].filter((x): x is NonNullable<typeof x> => x !== undefined);
  const shape0 = ctx0.layout.tables.map((t) => `${t.strategy}:${t.rows}x${t.cols}`).join(',');
  const origin = pageOrigin(doc0, p);
  doc0.destroy();
  const out: EditSample[] = [];
  for (const pick of picks) {
    for (const kind of ['same', 'digit', 'hangul'] as const) {
      const doc = open(bytes);
      const s: EditSample = {
        kind,
        target: `cell ${pick.cell!.table}:${pick.cell!.row}:${pick.cell!.col} ${JSON.stringify(textOf(pick.paragraphId)).slice(0, 40)}`,
        diffOutside: {},
      };
      try {
        const ctx = ctxOf(doc, p);
        const fm = new FontManager(doc, fallbackFor(doc));
        const plan = planParagraphEdit(ctx, fm, pick.paragraphId);
        const prepared = prepareParagraphEdit(ctx, plan, newEditId());
        const last = plan.runs.length - 1;
        const runsFinal = plan.runs.map((r, i) => ({
          ...r,
          text:
            kind === 'digit' && i === 0
              ? `1${r.text}`
              : kind === 'hangul' && i === last
                ? `${r.text} 수정`
                : r.text,
        }));
        const all = runsFinal.map((r) => r.text).join('');
        const { segments } = fm.assign(ctx, all, runsFinal);
        const result = layoutParagraph({
          text: all,
          segments,
          format: plan.format,
          areaLimit: plan.areaLimit,
        });
        writeEditBlock(ctx, prepared, runsFinal, plan.format, result, fm);
        const after = save(doc);
        for (const eng of engineList) {
          let a = cache.get(eng);
          if (!a) {
            a = await raster(eng, bytes, p);
            cache.set(eng, a);
          }
          s.diffOutside[eng] = diffOutside(
            a,
            await raster(eng, after, p),
            [pick.bbox, plan.target.bbox, result.summary.contentBox],
            origin,
          );
        }
        s.textSame = squash(await pageText('mupdf', after, p)).includes(squash(all));
        if (kind === 'same') {
          const chars = (c: ParagraphEditContext) =>
            c.model.chars
              .filter((ch) => ch.text.trim() !== '')
              .filter(
                (ch) =>
                  ch.origin[0] >= pick.bbox[0] &&
                  ch.origin[0] <= pick.bbox[2] &&
                  ch.origin[1] >= pick.bbox[1] &&
                  ch.origin[1] <= pick.bbox[3],
              );
          const a = chars(ctx);
          const b = chars(ctxOf(doc, p));
          s.shift =
            a.length === b.length
              ? Math.max(
                  0,
                  ...a.map((ch, i) =>
                    Math.hypot(ch.origin[0] - b[i]!.origin[0], ch.origin[1] - b[i]!.origin[1]),
                  ),
                )
              : -1;
        }
        const again = ctxOf(doc, p);
        const shape = again.layout.tables.map((t) => `${t.strategy}:${t.rows}x${t.cols}`).join(',');
        const cell = again.layout.tables[pick.cell!.table]?.cells.find(
          (c) => c.row === pick.cell!.row && c.col === pick.cell!.col,
        );
        s.v4 = {
          tableKept: shape === shape0,
          cellParagraphs: cell?.paragraphs.length ?? -1,
          cellTable: cell
            ? cell.paragraphs.every((id) => again.layout.paragraphs[id]!.table !== null)
            : false,
        };
        s.warnings = [...new Set(plan.warnings.map((w) => w.kind))];
        s.align = plan.format.align;
        s.overflow = result.summary.overflow;
        s.start = plan.runs
          .map((r) => r.text)
          .join('')
          .slice(0, 80);
      } catch (err) {
        s.error = err instanceof Error ? err.message : String(err);
      } finally {
        doc.destroy();
      }
      out.push(s);
    }
  }
  return out;
}

const VECTOR_DOCS = ['arxiv-2609.09268.pdf', 'arxiv-2609.10511.pdf', 'kogl-mods-cpi-202609.pdf'];
const TABLE_DOCS = [
  'ustreas-mts-202509.pdf',
  'fed-h41-current.pdf',
  'fed-combined-finstmt-2025.pdf',
  'kogl-nabo-finstmt2025.pdf',
  'kogl-mods-cpi-202609.pdf',
];

/** 문서의 상위 2쪽(점수 큰 순). */
function topPages(doc: mupdf.PDFDocument, score: (c: ParagraphEditContext) => number): number[] {
  const n = doc.countPages();
  const scored: [number, number][] = [];
  for (let p = 0; p < n; p++) {
    try {
      scored.push([p, score(ctxOf(doc, p))]);
    } catch {
      // 쪽 오류는 건너뛴다.
    }
  }
  return scored
    .filter((x) => x[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 2)
    .map((x) => x[0]);
}

describe.skipIf(!dir)('M4 코퍼스 측정', () => {
  it.runIf(mode === 'scan' || mode === 'all')(
    'scan: 패스·셀 판정, V1',
    async () => {
      await loadModules();
      const pages: PageScan[] = [];
      for (const f of files()) {
        const bytes = new Uint8Array(readFileSync(join(dir!, f)));
        const doc = open(bytes);
        const n = doc.countPages();
        for (let p = 0; p < n; p++) {
          try {
            pages.push(scanPage(f, doc, p));
          } catch (err) {
            pages.push({ file: f, page: p + 1, error: String(err) } as PageScan);
          }
        }
        doc.destroy();
      }
      if (out)
        writeFileSync(
          `${out}-scan.json`,
          JSON.stringify({ measuredAt: new Date().toISOString(), pages }, null, 1),
        );
      expect(pages.length).toBeGreaterThan(0);
    },
    3_600_000,
  );

  it.runIf(mode === 'render' || mode === 'all')(
    'render: V2·V3·패스 편집·셀 편집·V4',
    async () => {
      await loadModules();
      const result: Record<string, unknown>[] = [];
      for (const f of [...new Set([...VECTOR_DOCS, ...TABLE_DOCS])]) {
        if (only && !only.includes(f)) continue;
        const bytes = new Uint8Array(readFileSync(join(dir!, f)));
        const scan = open(bytes);
        const vec = VECTOR_DOCS.includes(f)
          ? topPages(scan, (c) => planPathEditability(c).filter((x) => x.editable).length)
          : [];
        const tab = TABLE_DOCS.includes(f)
          ? topPages(scan, (c) => c.layout.tables.reduce((s, t) => s + t.cells.length, 0))
          : [];
        scan.destroy();
        for (const p of vec) {
          const cache = new Map<string, Raster>();
          const r: Record<string, unknown> = { file: f, page: p + 1, kind: 'vector' };
          const d2 = open(bytes);
          const ctx2 = ctxOf(d2, p);
          r.v2Paths = rewriteAll(d2, ctx2, (cs, paint) =>
            cs.length === 0
              ? []
              : [
                  { start: cs[0]!.range[0], end: cs[0]!.range[0], text: 'q ' },
                  { start: paint.range[1], end: paint.range[1], text: ' Q' },
                ],
          );
          r.v2 = await fullDiff(bytes, save(d2), p, cache);
          d2.destroy();
          const d3 = open(bytes);
          const ctx3 = ctxOf(d3, p);
          r.v3Paths = rewriteAll(d3, ctx3, (cs, _paint, b) =>
            cs.map((c) => {
              const parsed = parseContentOpsLenient(b.subarray(c.range[0], c.range[1])).ops[0]!;
              const nums = parsed.operands.map((t) => fmt9(t.value as number));
              return {
                start: c.range[0],
                end: c.range[1],
                text: `${nums.join(' ')} ${c.op}`.trim(),
              };
            }),
          );
          r.v3 = await fullDiff(bytes, save(d3), p, cache);
          d3.destroy();
          r.edits = await pathSamples(bytes, p, cache);
          result.push(r);
        }
        for (const p of tab) {
          const cache = new Map<string, Raster>();
          result.push({
            file: f,
            page: p + 1,
            kind: 'table',
            edits: await cellSamples(bytes, p, cache),
          });
        }
        if (out)
          writeFileSync(
            `${out}-render.json`,
            JSON.stringify(
              { measuredAt: new Date().toISOString(), engines: engineList, result },
              null,
              1,
            ),
          );
      }
      expect(result.length).toBeGreaterThan(0);
    },
    7_200_000,
  );
});
