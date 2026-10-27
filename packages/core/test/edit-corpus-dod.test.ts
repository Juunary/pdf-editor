/**
 * Contract 8.2 corpus edit sample + 8.3 classification (the visual, new-glyph, text, search, order, object and save metrics of M3 DoD 1.1).
 * Runs the PdfSession edit flow (classification → begin → update → commit → save → reopen the saved bytes) with the real adapter.
 *
 * Skipped when the environment variable is not set. The result JSON stays outside git (`out/` is in .gitignore).
 *   EDIT_CORPUS_DIR=<PDF folder> [EDIT_CORPUS_OUT=<json>] [EDIT_CORPUS_FILES=a.pdf,b.pdf]
 *   [EDIT_CORPUS_ENGINES=mupdf,pdfjs,poppler] [EDIT_CORPUS_KINDS=same,latin,korean] [EDIT_CORPUS_KEEP=<folder for saved PDFs>]
 *   Example: EDIT_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus NODE_OPTIONS=--max-old-space-size=12288 \
 *       pnpm --filter @pdf-editor/core exec vitest run test/edit-corpus-dod.test.ts
 *
 * Sample: pages 1 and 4 of each document (the last page if missing, at most 2 pages). For each page, from the front of the PageLayout reading order, up to 3
 * flow paragraphs that are editable per getPageEditability and have at least 20 non-whitespace characters. 3 edit kinds per paragraph, a new session from the original bytes for each edit.
 *   same   : the runs of the plan as they are (text and shape ranges unchanged).
 *   latin  : fixed word list, seed = document id + paragraph id, length = original length × [0.7, 1.3). Shape of the first run.
 *   korean : original text + " " + a fixed Hangul sentence (contract 8.2: add a Hangul sentence not in the original). Shape of the first run.
 *   format is the plan as it is. On overflow the reflow automatically lowers the bottom edge of the area (contract 5.4, user decision 2026-10-20).
 *
 * Classification (contract 8.3, task instruction):
 *   1 Render outside the area: scale 2, annotations excluded, number of pixels with channel difference > 8 (MuPDF, pdf.js, Poppler). Allowed area = original paragraph bbox ∪ final
 *     contentBox ∪ ink box of the erased glyphs, margin 2pt. The ink box is an approximation: the union of the quads of the original paragraph characters (PageModel.chars)
 *     expanded by 25% of the glyph size (the render method that draws only the erased glyphs is not used). Other pages (among the first 5, excluding the edited page) must have a whole MuPDF render diff of 0.
 *   2 New glyph ink: for every PlacedGlyph (original, fallback) that is not whitespace, within its box (x..x+advance, baseline−0.8·size..baseline+0.2·size)
 *     ink (channel difference from white > 64) ≥ 1 px, in the saved render of each engine.
 *   3 Text: the characters inside contentBox (margin 1pt) (MuPDF structured text glyph centers, pdf.js item anchor points) with whitespace and default-ignorable characters removed
 *     = the input text (excluding glyph-missing clusters).
 *   4 Search: one word of 2 or more characters (the longest) placed on one line of the new text; the center of the MuPDF page.search (case-sensitive) result quad is
 *     inside some PlacedGlyph box.
 *   5 Order (A9): in the same-engine page text (NFKC + whitespace removed), find the end and the beginning of the reading-order neighbor paragraphs, and the beginning and end of the new text,
 *     as unique substrings, and check previous end < new first character and new end < next first character. If not unique or not found: undetermined.
 *     The same classification on the original extraction (relative to the original paragraph) is also recorded (baseline).
 *   6 Objects: decoded content bytes and Resources keys (including sub-dictionary keys) of other pages (among the first 30, excluding the edited page) are unchanged.
 *   7 Save time, size, SaveResult.wasmHeapBytes.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  DraftInput,
  DraftUpdate,
  EditOp,
  LayoutParagraph,
  PageLayout,
  ParagraphEditPlan,
  PathEdit,
  PlacedGlyph,
  Rect,
  TextRun,
} from '@pdf-editor/shared-types';
import { PdfSession } from '../src/index.js';
import { FONT_BYTES } from './edit-harness.js';
import {
  diffAll,
  diffOutside,
  ENGINES,
  glyphBox,
  inkInside,
  koreanSentence,
  latinSentence,
  locate,
  mupdfRasters,
  openMupdf,
  orderNorm,
  pageObjects,
  pageOrigin,
  pageText,
  popplerAvailable,
  raster,
  squash,
  textInBox,
  type DiffResult,
  type Engine,
  type PageObjects,
  type Raster,
} from './edit-corpus-helpers.js';

const dir = process.env.EDIT_CORPUS_DIR;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const outPath =
  process.env.EDIT_CORPUS_OUT ??
  join(
    REPO,
    'out/m3-edit-corpus',
    `edit-corpus-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
const only = process.env.EDIT_CORPUS_FILES?.split(',');
/** Folder to keep the saved PDFs in (for investigation). */
const keepDir = process.env.EDIT_CORPUS_KEEP;
const engines =
  (process.env.EDIT_CORPUS_ENGINES?.split(',') as Engine[] | undefined) ??
  ENGINES.filter((e) => e !== 'poppler' || popplerAvailable());
const TEXT_ENGINES = (['mupdf', 'pdfjs'] as const).filter((e) => engines.includes(e));
type EditKind = 'same' | 'latin' | 'korean';
const kinds = (process.env.EDIT_CORPUS_KINDS?.split(',') as EditKind[] | undefined) ?? [
  'same',
  'latin',
  'korean',
];
const OTHER_RENDER_PAGES = 5;
const OBJECT_PAGES = 30;

type OrderVerdict = 'pass' | 'fail' | 'undetermined' | 'n/a';

interface OrderResult {
  verdict: OrderVerdict;
  prevLast?: number | string;
  newFirst?: number | string;
  newLast?: number | string;
  nextFirst?: number | string;
  /** The same classification on the original extraction against the original paragraph. */
  baseline: OrderVerdict;
}

interface EditRow {
  file: string;
  page: number;
  paragraphId: number;
  kind: EditKind;
  textLength: number;
  originalLength: number;
  insertion: string | null;
  warnings: string[];
  overflowInitial: boolean | null;
  overflowFinal: boolean | null;
  expanded: boolean;
  glyphKinds: Record<string, number>;
  missingClusters: string[];
  contentBox: Rect | null;
  bbox: Rect | null;
  inkBox: Rect | null;
  diffOutside: Record<string, DiffResult>;
  otherPagesDiff: Record<number, number>;
  glyphInk: Record<string, { checked: number; empty: number; examples: string[] }>;
  text: Record<string, { equal: boolean; contains?: boolean; got?: string; expected?: string }>;
  /** Characters of the original page outside the original paragraph whose center is inside the final contentBox (+1pt), excluding whitespace. Used to classify text check failures. */
  foreignChars: number;
  search: { word: string | null; hits: number; inGlyph: boolean | null };
  order: Record<string, OrderResult>;
  objects: { pagesCompared: number; changed: string[] };
  timing: { planMs: number; beginMs: number; updateMs: number; commitMs: number; saveMs: number };
  savedBytes: number;
  wasmHeapBytes: number | null;
  error?: string;
}

interface PageTotals {
  file: string;
  page: number;
  paragraphs: number;
  flow: number;
  editableFlow: number;
  reasons: Record<string, number>;
  primary: Record<string, number>;
  editabilityMs: number;
  picks: number[];
  error?: string;
}

const session = (bytes: Uint8Array): PdfSession => {
  const s = new PdfSession({ loadFallbackFont: async () => FONT_BYTES });
  s.open(bytes);
  return s;
};

const union = (a: Rect | null, b: Rect): Rect =>
  a
    ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
    : [...b];

const inRect = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** The input text with glyph-missing clusters removed. */
function expectedText(text: string, glyphs: PlacedGlyph[]): string {
  const drop = new Set<number>();
  for (const g of glyphs) {
    if (g.font.kind === 'missing') for (let k = 0; k < g.length; k++) drop.add(g.offset + k);
  }
  // offset is a UTF-16 position.
  return text
    .split('')
    .filter((_c, i) => !drop.has(i))
    .join('');
}

/** The longest word of 2 or more characters placed on one line. */
function searchWord(text: string, glyphs: PlacedGlyph[]): string | null {
  let best: string | null = null;
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length < 2) continue;
    const start = m.index;
    const end = start + w.length;
    const gs = glyphs.filter((g) => g.offset >= start && g.offset < end);
    if (gs.length === 0 || gs.some((g) => g.font.kind === 'missing')) continue;
    if (new Set(gs.map((g) => g.y.toFixed(2))).size !== 1) continue;
    if (!best || w.length > best.length) best = w;
  }
  return best;
}

function orderVerdict(
  hay: string,
  prev: string | null,
  body: string,
  next: string | null,
): Omit<OrderResult, 'baseline'> {
  if (prev === null && next === null) return { verdict: 'n/a' };
  const out: Omit<OrderResult, 'baseline'> = { verdict: 'pass' };
  const bad: string[] = [];
  const unknown: string[] = [];
  const isNum = (v: number | string): v is number => typeof v === 'number';
  if (prev !== null) {
    out.prevLast = locate(hay, prev, 'tail');
    out.newFirst = locate(hay, body, 'head');
    if (!isNum(out.prevLast) || !isNum(out.newFirst)) unknown.push('prev');
    else if (!(out.prevLast < out.newFirst)) bad.push('prev');
  }
  if (next !== null) {
    out.newLast = locate(hay, body, 'tail');
    out.nextFirst = locate(hay, next, 'head');
    if (!isNum(out.newLast) || !isNum(out.nextFirst)) unknown.push('next');
    else if (!(out.newLast < out.nextFirst)) bad.push('next');
  }
  out.verdict = bad.length ? 'fail' : unknown.length ? 'undetermined' : 'pass';
  return out;
}

/** Reading-order neighbor paragraph (paragraph items only; table and shape items are skipped). */
function neighbours(
  layout: PageLayout,
  id: number,
): [LayoutParagraph | null, LayoutParagraph | null] {
  const order = layout.readingOrder.filter((r) => r.kind === 'paragraph').map((r) => r.id);
  const i = order.indexOf(id);
  const get = (k: number) =>
    k >= 0 && k < order.length ? (layout.paragraphs.find((p) => p.id === order[k]) ?? null) : null;
  return [get(i - 1), get(i + 1)];
}

interface PageChar {
  index: number;
  cx: number;
  cy: number;
}

interface DocCache {
  bytes: Uint8Array;
  pageCount: number;
  mupdfOriginal: Map<number, Raster>;
  objects: Map<number, PageObjects>;
  engineOriginal: Map<string, Raster>;
  textOriginal: Map<string, string>;
}

async function originalRaster(c: DocCache, e: Engine, p: number): Promise<Raster> {
  if (e === 'mupdf') return c.mupdfOriginal.get(p)!;
  const k = `${e}:${p}`;
  if (!c.engineOriginal.has(k)) c.engineOriginal.set(k, await raster(e, c.bytes, p));
  return c.engineOriginal.get(k)!;
}

async function originalText(c: DocCache, e: 'mupdf' | 'pdfjs', p: number): Promise<string> {
  const k = `${e}:${p}`;
  if (!c.textOriginal.has(k)) c.textOriginal.set(k, orderNorm(await pageText(e, c.bytes, p)));
  return c.textOriginal.get(k)!;
}

function runsFor(kind: EditKind, plan: ParagraphEditPlan, docId: string): TextRun[] {
  const text0 = plan.runs.map((r) => r.text).join('');
  const style = plan.runs[0]!.style;
  if (kind === 'same') return plan.runs.map((r) => ({ text: r.text, style: { ...r.style } }));
  if (kind === 'latin')
    return [{ text: latinSentence(docId, plan.paragraphId, text0.length), style }];
  return [{ text: `${text0} ${koreanSentence(docId, plan.paragraphId)}`, style }];
}

async function runEdit(
  c: DocCache,
  file: string,
  docId: string,
  p: number,
  para: LayoutParagraph,
  inkBox: Rect,
  layout: PageLayout,
  pageChars: PageChar[],
  kind: EditKind,
): Promise<EditRow> {
  const row: EditRow = {
    file,
    page: p + 1,
    paragraphId: para.id,
    kind,
    textLength: 0,
    originalLength: 0,
    insertion: null,
    warnings: [],
    overflowInitial: null,
    overflowFinal: null,
    expanded: false,
    glyphKinds: {},
    missingClusters: [],
    contentBox: null,
    bbox: null,
    inkBox,
    diffOutside: {},
    otherPagesDiff: {},
    glyphInk: {},
    text: {},
    search: { word: null, hits: 0, inGlyph: null },
    foreignChars: 0,
    order: {},
    objects: { pagesCompared: 0, changed: [] },
    timing: { planMs: 0, beginMs: 0, updateMs: 0, commitMs: 0, saveMs: 0 },
    savedBytes: 0,
    wasmHeapBytes: null,
  };
  const s = session(c.bytes);
  let saved: Uint8Array;
  let update: DraftUpdate;
  let runs: TextRun[];
  try {
    let t = performance.now();
    const plan = await s.planParagraphEdit(p, para.id);
    row.timing.planMs = performance.now() - t;
    if (!plan.editable)
      throw new Error(`편집 불가: ${JSON.stringify(plan.limits.map((l) => l.reason))}`);
    row.bbox = plan.target.bbox;
    row.insertion = plan.insertion ? `${plan.insertion.container}/${plan.insertion.mode}` : null;
    row.originalLength = plan.runs.map((r) => r.text).join('').length;
    runs = runsFor(kind, plan, docId);
    t = performance.now();
    const begin = await s.beginParagraphEdit(p, para.id, plan.revision, 2);
    row.timing.beginMs = performance.now() - t;
    const input: DraftInput = { runs, format: plan.format, composition: null, renderScale: 2 };
    update = await s.updateParagraphDraft(begin.draftId, input);
    row.timing.updateMs = update.updateMs;
    // Automatic expansion (contract 5.4): if it exceeded the original area, the bottom edge has moved down.
    row.expanded = update.reflow.area[3] > plan.format.area[3] + 0.01;
    row.overflowInitial = row.expanded || update.reflow.overflow;
    row.overflowFinal = update.reflow.overflow;
    row.contentBox = update.reflow.contentBox;
    row.warnings = [...new Set(update.warnings.map((w) => w.kind))];
    t = performance.now();
    await s.commitParagraphEdit(begin.draftId);
    row.timing.commitMs = performance.now() - t;
    const res = s.save({ changes: [] });
    saved = res.bytes;
    row.timing.saveMs = res.saveMs;
    row.savedBytes = res.bytes.byteLength;
    row.wasmHeapBytes = res.wasmHeapBytes;
    if (keepDir) {
      mkdirSync(keepDir, { recursive: true });
      writeFileSync(join(keepDir, `${docId}-p${p + 1}-${para.id}-${kind}.pdf`), saved);
    }
  } catch (err) {
    row.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    s.close();
    return row;
  }
  s.close();

  const text = runs.map((r) => r.text).join('');
  row.textLength = text.length;
  const glyphs = update.reflow.glyphs;
  for (const g of glyphs) row.glyphKinds[g.font.kind] = (row.glyphKinds[g.font.kind] ?? 0) + 1;
  row.missingClusters = glyphs
    .filter((g) => g.font.kind === 'missing')
    .map((g) => text.slice(g.offset, g.offset + g.length));
  const drawn = glyphs.filter(
    (g) => g.font.kind !== 'missing' && squash(text.slice(g.offset, g.offset + g.length)) !== '',
  );
  const origin = pageOrigin(saved, p);
  const allow: Rect[] = [row.bbox!, row.contentBox!, inkBox];

  try {
    // 1 and 2 render (edited page, three engines).
    for (const e of engines) {
      const a = await originalRaster(c, e, p);
      const b = await raster(e, saved, p);
      row.diffOutside[e] = diffOutside(a, b, allow, origin);
      const ink = { checked: drawn.length, empty: 0, examples: [] as string[] };
      for (const g of drawn) {
        if (inkInside(b, glyphBox(g), origin) < 1) {
          ink.empty++;
          if (ink.examples.length < 5) {
            const box = glyphBox(g)
              .map((v) => v.toFixed(1))
              .join(',');
            ink.examples.push(
              `${JSON.stringify(text.slice(g.offset, g.offset + g.length))}@${g.offset} ${g.font.kind} [${box}]`,
            );
          }
        }
      }
      row.glyphInk[e] = ink;
    }
    // 1 Other pages (MuPDF).
    const others = [...c.mupdfOriginal.keys()].filter((k) => k !== p);
    const savedOthers = mupdfRasters(saved, others);
    for (const k of others)
      row.otherPagesDiff[k + 1] = diffAll(c.mupdfOriginal.get(k)!, savedOthers.get(k)!);

    // 3 Text.
    const cb = row.contentBox!;
    const own = new Set(para.chars);
    row.foreignChars = pageChars.filter(
      (q) =>
        !own.has(q.index) &&
        q.cx >= cb[0] - 1 &&
        q.cx <= cb[2] + 1 &&
        q.cy >= cb[1] - 1 &&
        q.cy <= cb[3] + 1,
    ).length;
    const expected = squash(expectedText(text, glyphs));
    for (const e of TEXT_ENGINES) {
      const got = squash(await textInBox(e, saved, p, row.contentBox!, origin));
      row.text[e] =
        got === expected
          ? { equal: true }
          : {
              equal: false,
              contains: got.includes(expected),
              got: got.slice(0, 300),
              expected: expected.slice(0, 300),
            };
    }

    // 4 Search (MuPDF).
    const word = searchWord(text, glyphs);
    row.search.word = word;
    if (word) {
      const doc = openMupdf(saved);
      try {
        const page = doc.loadPage(p);
        const hits = page.search(word, undefined) as number[][][];
        page.destroy();
        row.search.hits = hits.length;
        const boxes = drawn.map(glyphBox);
        row.search.inGlyph = hits.some((quads) =>
          quads.some((q) => {
            const cx = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
            const cy = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
            return boxes.some((r) => inRect(cx, cy, r));
          }),
        );
      } finally {
        doc.destroy();
      }
    }

    // 5 Order.
    const [prev, next] = neighbours(layout, para.id);
    const prevT = prev ? orderNorm(prev.text) : null;
    const nextT = next ? orderNorm(next.text) : null;
    for (const e of TEXT_ENGINES) {
      const after = orderNorm(await pageText(e, saved, p));
      const before = await originalText(c, e, p);
      const base = orderVerdict(before, prevT, orderNorm(para.text), nextT).verdict;
      row.order[e] = {
        ...orderVerdict(after, prevT, orderNorm(expectedText(text, glyphs)), nextT),
        baseline: base,
      };
    }

    // 6 Objects (other pages).
    const doc = openMupdf(saved);
    try {
      for (const [k, o] of c.objects) {
        if (k === p) continue;
        row.objects.pagesCompared++;
        const n = pageObjects(doc, k);
        if (n.content !== o.content) row.objects.changed.push(`p${k + 1} content`);
        if (n.resources !== o.resources) row.objects.changed.push(`p${k + 1} resources`);
      }
    } finally {
      doc.destroy();
    }
  } catch (err) {
    row.error = `측정 실패: ${err instanceof Error ? err.message : String(err)}`;
  }
  return row;
}

function summarize(rows: EditRow[], totals: PageTotals[]) {
  const ok = rows.filter((r) => !r.error);
  const rate = (pass: number, n: number) => ({ pass, n, rate: n ? +(pass / n).toFixed(4) : null });
  const byKind = (k: EditKind) => ok.filter((r) => r.kind === k);
  const failures: string[] = [];
  const id = (r: EditRow) => `${r.file} p${r.page} #${r.paragraphId} ${r.kind}`;
  for (const r of rows) {
    if (r.error) {
      failures.push(`${id(r)}: error ${r.error}`);
      continue;
    }
    for (const [e, d] of Object.entries(r.diffOutside)) {
      if (d.pixels !== 0)
        failures.push(
          `${id(r)}: diffOutside ${e} ${d.pixels}px max${d.maxDelta} bbox ${d.bbox?.map((v) => v.toFixed(1)).join(',')}`,
        );
    }
    for (const [pg, n] of Object.entries(r.otherPagesDiff))
      if (n !== 0) failures.push(`${id(r)}: otherPage p${pg} ${n}px`);
    for (const [e, g] of Object.entries(r.glyphInk))
      if (g.empty)
        failures.push(`${id(r)}: glyphInk ${e} ${g.empty}/${g.checked} ${g.examples.join(' | ')}`);
    for (const [e, t] of Object.entries(r.text))
      if (!t.equal)
        failures.push(
          `${id(r)}: text ${e}${t.contains && r.foreignChars ? ` (box has ${r.foreignChars} foreign chars)` : ''} got=${JSON.stringify(t.got?.slice(0, 80))} exp=${JSON.stringify(t.expected?.slice(0, 80))}`,
        );
    if (r.search.inGlyph !== true) failures.push(`${id(r)}: search ${JSON.stringify(r.search)}`);
    for (const [e, o] of Object.entries(r.order))
      if (o.verdict === 'fail')
        failures.push(
          `${id(r)}: order ${e}${r.warnings.includes('reading-order-approximate') ? ' (reading-order-approximate)' : ''} ${JSON.stringify(o)}`,
        );
    if (r.objects.changed.length) failures.push(`${id(r)}: objects ${r.objects.changed.join(',')}`);
  }
  const metricRates = (set: EditRow[]) => {
    const local = set;
    const pe = <T>(
      list: string[],
      f: (r: EditRow, e: string) => T | undefined,
      isPass: (v: T) => boolean,
    ) =>
      Object.fromEntries(
        list.map((e) => {
          const vals = local.map((r) => f(r, e)).filter((v): v is T => v !== undefined);
          return [e, rate(vals.filter(isPass).length, vals.length)];
        }),
      );
    return {
      n: local.length,
      diffOutside: pe(
        engines,
        (r, e) => r.diffOutside[e]?.pixels,
        (v) => v === 0,
      ),
      otherPages: rate(
        local.filter((r) => Object.values(r.otherPagesDiff).every((v) => v === 0)).length,
        local.length,
      ),
      glyphInk: pe(
        engines,
        (r, e) => r.glyphInk[e]?.empty,
        (v) => v === 0,
      ),
      text: pe(
        [...TEXT_ENGINES],
        (r, e) => r.text[e]?.equal,
        (v) => v,
      ),
      /** Auxiliary: equal, or the input appears contiguously in the characters inside the box and the box contains original characters outside the original paragraph (the area overlaps a neighbor). */
      textEqualOrOverlap: pe(
        [...TEXT_ENGINES],
        (r, e) =>
          r.text[e] ? r.text[e]!.equal || (!!r.text[e]!.contains && r.foreignChars > 0) : undefined,
        (v) => v,
      ),
      search: rate(local.filter((r) => r.search.inGlyph === true).length, local.length),
      orderPass: pe(
        [...TEXT_ENGINES],
        (r, e) => r.order[e]?.verdict,
        (v) => v === 'pass',
      ),
      orderVerdicts: Object.fromEntries(
        TEXT_ENGINES.map((e) => [e, count(local.map((r) => r.order[e]?.verdict ?? 'missing'))]),
      ),
      orderReadingApproximate: local.filter((r) => r.warnings.includes('reading-order-approximate'))
        .length,
      /** Contract 1.1: classification distribution excluding edits that carry the reading-order-approximate warning. */
      orderVerdictsExact: Object.fromEntries(
        TEXT_ENGINES.map((e) => [
          e,
          count(
            local
              .filter((r) => !r.warnings.includes('reading-order-approximate'))
              .map((r) => `${r.order[e]?.verdict ?? 'missing'}/baseline-${r.order[e]?.baseline}`),
          ),
        ]),
      ),
      objects: rate(local.filter((r) => r.objects.changed.length === 0).length, local.length),
    };
  };
  const flow = totals.reduce((a, t) => a + t.flow, 0);
  const editableFlow = totals.reduce((a, t) => a + t.editableFlow, 0);
  const reasons: Record<string, number> = {};
  const primary: Record<string, number> = {};
  for (const t of totals) {
    for (const [k, v] of Object.entries(t.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
    for (const [k, v] of Object.entries(t.primary)) primary[k] = (primary[k] ?? 0) + v;
  }
  const nums = (f: (r: EditRow) => number) => ok.map(f).sort((a, b) => a - b);
  const stats = (v: number[]) =>
    v.length
      ? {
          median: v[Math.floor(v.length / 2)],
          p95: v[Math.min(v.length - 1, Math.floor(v.length * 0.95))],
          max: v[v.length - 1],
        }
      : null;
  return {
    date: new Date().toISOString(),
    engines,
    kinds,
    documents: new Set(totals.map((t) => t.file)).size,
    pages: totals.length,
    pageErrors: totals.filter((t) => t.error).map((t) => `${t.file} p${t.page}: ${t.error}`),
    editability: {
      flow,
      editableFlow,
      ratio: flow ? +(editableFlow / flow).toFixed(4) : null,
      reasons,
      primary,
    },
    paragraphsSampled: new Set(rows.map((r) => `${r.file}#${r.page}#${r.paragraphId}`)).size,
    edits: rows.length,
    editErrors: rows.filter((r) => r.error).length,
    expanded: ok.filter((r) => r.expanded).length,
    overflowFinal: ok.filter((r) => r.overflowFinal).length,
    insertion: count(ok.map((r) => r.insertion ?? 'null')),
    warnings: count(ok.flatMap((r) => r.warnings)),
    fallbackEdits: ok.filter((r) => (r.glyphKinds.fallback ?? 0) > 0).length,
    missingEdits: ok.filter((r) => r.missingClusters.length > 0).length,
    all: metricRates(ok),
    byKind: Object.fromEntries(kinds.map((k) => [k, metricRates(byKind(k))])),
    timing: {
      saveMs: stats(nums((r) => r.timing.saveMs)),
      beginMs: stats(nums((r) => r.timing.beginMs)),
      updateMs: stats(nums((r) => r.timing.updateMs)),
      commitMs: stats(nums((r) => r.timing.commitMs)),
      savedBytes: stats(nums((r) => r.savedBytes)),
      wasmHeapBytesMax: Math.max(0, ...ok.map((r) => r.wasmHeapBytes ?? 0)),
    },
    failures,
  };
}

function count(list: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of list) o[k] = (o[k] ?? 0) + 1;
  return o;
}

describe.skipIf(!dir)('corpus edit sample classification (contract 8.2, 8.3)', () => {
  it(
    'pages 1 and 4 of each document, up to 3 paragraphs per page × 3 edit kinds',
    async () => {
      const files = readdirSync(dir!)
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .filter((f) => !only || only.includes(f))
        .sort();
      const rows: EditRow[] = [];
      const totals: PageTotals[] = [];
      for (const file of files) {
        const docId = basename(file, '.pdf');
        const bytes = new Uint8Array(readFileSync(join(dir!, file)));
        const probe = openMupdf(bytes);
        const pageCount = probe.countPages();
        const objects = new Map<number, PageObjects>();
        for (let k = 0; k < Math.min(pageCount, OBJECT_PAGES); k++)
          objects.set(k, pageObjects(probe, k));
        probe.destroy();
        const pages = [...new Set([0, 3].map((q) => Math.min(q, pageCount - 1)))];
        const renderPages = [
          ...new Set([
            ...Array.from({ length: Math.min(pageCount, OTHER_RENDER_PAGES) }, (_v, k) => k),
            ...pages,
          ]),
        ];
        const c: DocCache = {
          bytes,
          pageCount,
          mupdfOriginal: mupdfRasters(bytes, renderPages),
          objects,
          engineOriginal: new Map(),
          textOriginal: new Map(),
        };
        const t0 = performance.now();
        for (const p of pages) {
          const tot: PageTotals = {
            file,
            page: p + 1,
            paragraphs: 0,
            flow: 0,
            editableFlow: 0,
            reasons: {},
            primary: {},
            editabilityMs: 0,
            picks: [],
          };
          totals.push(tot);
          let layout: PageLayout;
          const picks: { para: LayoutParagraph; inkBox: Rect }[] = [];
          let pageChars: PageChar[];
          const s0 = session(bytes);
          try {
            const te = performance.now();
            const pe = await s0.getPageEditability(p);
            tot.editabilityMs = performance.now() - te;
            layout = s0.getPageLayout(p);
            const model = s0.extractPage({ pageIndex: p });
            tot.paragraphs = layout.paragraphs.length;
            pageChars = model.chars.flatMap((ch, index) => {
              if (squash(ch.text) === '') return [];
              const q = ch.quad;
              return [
                { index, cx: (q[0] + q[2] + q[4] + q[6]) / 4, cy: (q[1] + q[3] + q[5] + q[7]) / 4 },
              ];
            });
            const editable = new Set<number>();
            for (const para of layout.paragraphs) {
              if (para.table !== null || para.figure !== null) continue;
              tot.flow++;
              const ed = pe.paragraphs.find((q) => q.paragraphId === para.id);
              if (ed?.editable) {
                tot.editableFlow++;
                editable.add(para.id);
                continue;
              }
              const rs = [...new Set(ed?.reasons ?? ['missing-from-editability'])];
              for (const r of rs) tot.reasons[r] = (tot.reasons[r] ?? 0) + 1;
              tot.primary[rs[0]!] = (tot.primary[rs[0]!] ?? 0) + 1;
            }
            const order = layout.readingOrder
              .filter((r) => r.kind === 'paragraph')
              .map((r) => r.id);
            for (const id of order) {
              if (picks.length >= 3) break;
              if (!editable.has(id)) continue;
              const para = layout.paragraphs.find((q) => q.id === id)!;
              if (squash(para.text).length < 20) continue;
              let ink: Rect | null = null;
              for (const ci of para.chars) {
                const ch = model.chars[ci]!;
                const q = ch.quad;
                const m = 0.25 * ch.size;
                const xs = [q[0], q[2], q[4], q[6]];
                const ys = [q[1], q[3], q[5], q[7]];
                ink = union(ink, [
                  Math.min(...xs) - m,
                  Math.min(...ys) - m,
                  Math.max(...xs) + m,
                  Math.max(...ys) + m,
                ]);
              }
              picks.push({ para, inkBox: ink ?? para.bbox });
            }
            tot.picks = picks.map((q) => q.para.id);
          } catch (err) {
            tot.error = err instanceof Error ? err.message : String(err);
            s0.close();
            continue;
          }
          s0.close();
          for (const { para, inkBox } of picks) {
            for (const kind of kinds) {
              rows.push(await runEdit(c, file, docId, p, para, inkBox, layout, pageChars, kind));
            }
          }
        }
        const done = rows.filter((r) => r.file === file);
        console.log(
          `${file}: pages ${pages.map((q) => q + 1).join(',')} edits ${done.length} errors ${done.filter((r) => r.error).length} ${((performance.now() - t0) / 1000).toFixed(1)} s`,
        );
      }
      const summary = summarize(rows, totals);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ summary, totals, rows }, null, 1));
      const { failures, ...head } = summary;
      console.log(JSON.stringify(head, null, 1));
      console.log(`failures ${failures.length} → ${outPath}`);
      expect(rows.length).toBeGreaterThan(0);
    },
    6 * 3_600_000,
  );
});

// ---------------------------------------------------------------- M4 table cells and paths (contract 6.1)

/**
 * M4 corpus sample (docs/m4-contract.md 6.1, docs/m4-integration.md). Runs only when `EDIT_CORPUS_M4=cells,paths` (or one of them) is set.
 *   EDIT_CORPUS_DIR=<PDF folder> EDIT_CORPUS_M4=cells,paths [EDIT_CORPUS_M4_OUT=<json>] [EDIT_CORPUS_ENGINES=...]
 * The sample pages are the same as the S1 sample (docs/m4-pdf-ops.md 5.1, 5.2). Runs the real core session flow (classification → begin → update → commit → save).
 *   Cells: up to 3 cells per page (header-row cell, number cell, text cell) × same text, number digits +1 ("1" prepended), Hangul appended (" 수정").
 *   Paths: per page the 5 largest editable paths × fill color (paths with a fill), line width ×2 (paths with a stroke; 0.5pt if 0), 10pt move.
 * Metrics: render difference outside the allowed area (three engines; cell = cell box ∪ original paragraph box ∪ placed box ∪ original glyph ink, path = box before ∪ after the edit,
 *   margin 2pt), other-page render (MuPDF), text (cell: inside the placed box = input; path: page text unchanged), other-page objects unchanged, glyph origin shift of a same-text
 *   cell ≤ 0.5pt (1.1), V4 (table shape kept after a cell commit, one cell paragraph), reapply determinism (saved render after
 *   replayEdits of the log into a new session = original saved render, MuPDF), editable ratio and reason distribution of the page classification.
 */
const m4Kinds = process.env.EDIT_CORPUS_M4?.split(',') ?? [];
const m4Out =
  process.env.EDIT_CORPUS_M4_OUT ??
  join(
    REPO,
    'out/m4-edit-corpus',
    `m4-edit-corpus-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
/** Table pages (1-based, docs/m4-pdf-ops.md 5.2 sample). */
const M4_TABLE_PAGES: Record<string, number[]> = {
  'ustreas-mts-202509.pdf': [35, 17],
  'fed-h41-current.pdf': [9, 8],
  'fed-combined-finstmt-2025.pdf': [7, 8],
  'kogl-nabo-finstmt2025.pdf': [107, 85],
  'kogl-mods-cpi-202609.pdf': [17, 18],
};
/** Diagram pages (1-based, docs/m4-pdf-ops.md 5.1 sample). */
const M4_PATH_PAGES: Record<string, number[]> = {
  'arxiv-2609.09268.pdf': [10, 14],
  'arxiv-2609.10511.pdf': [7, 3],
  'kogl-mods-cpi-202609.pdf': [4, 6],
};

interface M4Row {
  unit: 'cell' | 'path';
  file: string;
  page: number;
  target: string;
  kind: string;
  align?: string;
  warnings: string[];
  overflow?: boolean;
  diffOutside: Record<string, DiffResult>;
  otherPagesDiff: Record<number, number>;
  text: Record<string, boolean>;
  objects: string[];
  shift?: number;
  v4?: { tableKept: boolean; cellParagraphs: number; cellTable: boolean };
  replaySame: boolean | null;
  updateMs: number;
  error?: string;
}

interface M4PageTotals {
  unit: 'cell' | 'path';
  file: string;
  page: number;
  items: number;
  editable: number;
  reasons: Record<string, number>;
  error?: string;
}

const inflate = (r: Rect, m: number): Rect => [r[0] - m, r[1] - m, r[2] + m, r[3] + m];

function inkOf(model: ReturnType<PdfSession['extractPage']>, chars: number[]): Rect | null {
  let ink: Rect | null = null;
  for (const ci of chars) {
    const ch = model.chars[ci]!;
    const q = ch.quad;
    const m = 0.25 * ch.size;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    ink = union(ink, [
      Math.min(...xs) - m,
      Math.min(...ys) - m,
      Math.max(...xs) + m,
      Math.max(...ys) + m,
    ]);
  }
  return ink;
}

/** Classifies the save result (render, other pages, objects, reapply). Text and shift are the caller's job. */
async function judgeSaved(
  c: DocCache,
  p: number,
  saved: Uint8Array,
  allow: Rect[],
  ops: EditOp[],
  row: M4Row,
): Promise<void> {
  const origin = pageOrigin(saved, p);
  for (const e of engines) {
    row.diffOutside[e] = diffOutside(
      await originalRaster(c, e, p),
      await raster(e, saved, p),
      allow,
      origin,
    );
  }
  const others = [...c.mupdfOriginal.keys()].filter((k) => k !== p);
  const savedOthers = mupdfRasters(saved, others);
  for (const k of others)
    row.otherPagesDiff[k + 1] = diffAll(c.mupdfOriginal.get(k)!, savedOthers.get(k)!);
  const doc = openMupdf(saved);
  try {
    for (const [k, o] of c.objects) {
      if (k === p) continue;
      const n = pageObjects(doc, k);
      if (n.content !== o.content) row.objects.push(`p${k + 1} content`);
      if (n.resources !== o.resources) row.objects.push(`p${k + 1} resources`);
    }
  } finally {
    doc.destroy();
  }
  const r = session(c.bytes);
  try {
    await r.replayEdits(structuredClone(ops));
    const again = r.save({ changes: [] }).bytes;
    row.replaySame =
      diffAll(mupdfRasters(saved, [p]).get(p)!, mupdfRasters(again, [p]).get(p)!) === 0;
  } catch (err) {
    row.replaySame = false;
    row.error = `재적용 실패: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    r.close();
  }
}

const tableShape = (layout: PageLayout) =>
  layout.tables.map((t) => `${t.strategy}:${t.rows}x${t.cols}`).join(',');

async function m4Cells(
  c: DocCache,
  file: string,
  p: number,
  totals: M4PageTotals[],
  rows: M4Row[],
) {
  const tot: M4PageTotals = { unit: 'cell', file, page: p + 1, items: 0, editable: 0, reasons: {} };
  totals.push(tot);
  const s0 = session(c.bytes);
  let picks: { id: number; bbox: Rect; cell: { table: number; row: number; col: number } }[];
  let shape0: string;
  let model0: ReturnType<PdfSession['extractPage']>;
  let layout0: PageLayout;
  try {
    const pe = await s0.getPageEditability(p);
    layout0 = s0.getPageLayout(p);
    model0 = s0.extractPage({ pageIndex: p });
    shape0 = tableShape(layout0);
    const cells = pe.paragraphs.filter((q) => q.cell !== null);
    tot.items = cells.length;
    for (const q of cells) {
      if (q.editable) tot.editable++;
      else for (const r of new Set(q.reasons)) tot.reasons[r] = (tot.reasons[r] ?? 0) + 1;
    }
    const textOf = (id: number) => layout0.paragraphs.find((x) => x.id === id)?.text ?? '';
    const ok = cells.filter((q) => q.editable);
    const header = ok.find((q) => q.cell!.row === 0);
    const numeric = ok.find(
      (q) =>
        q.cell!.row > 0 &&
        /^[\s\d,.()$%−-]+$/u.test(textOf(q.paragraphId)) &&
        /\d/.test(textOf(q.paragraphId)),
    );
    const word = ok.find((q) => q.cell!.row > 0 && /\p{L}{3}/u.test(textOf(q.paragraphId)));
    picks = [header, numeric, word]
      .filter((x): x is NonNullable<typeof x> => x !== undefined)
      .map((q) => ({ id: q.paragraphId, bbox: q.bbox, cell: q.cell! }));
  } catch (err) {
    tot.error = err instanceof Error ? err.message : String(err);
    s0.close();
    return;
  }
  s0.close();
  for (const pick of picks) {
    for (const kind of ['same', 'digit', 'hangul'] as const) {
      const row: M4Row = {
        unit: 'cell',
        file,
        page: p + 1,
        target: `cell ${pick.cell.table}:${pick.cell.row}:${pick.cell.col} ${JSON.stringify(layout0!.paragraphs.find((x) => x.id === pick.id)?.text.slice(0, 30))}`,
        kind,
        warnings: [],
        diffOutside: {},
        otherPagesDiff: {},
        text: {},
        objects: [],
        replaySame: null,
        updateMs: 0,
      };
      rows.push(row);
      const s = session(c.bytes);
      try {
        const plan = await s.planParagraphEdit(p, pick.id);
        if (!plan.editable)
          throw new Error(`편집 불가: ${plan.limits.map((l) => l.reason).join(',')}`);
        row.align = plan.format.align;
        const last = plan.runs.length - 1;
        const runs = plan.runs.map((r, i) => ({
          ...r,
          text:
            kind === 'digit' && i === 0
              ? `1${r.text}`
              : kind === 'hangul' && i === last
                ? `${r.text} 수정`
                : r.text,
        }));
        const text = runs.map((r) => r.text).join('');
        const begin = await s.beginParagraphEdit(p, pick.id, plan.revision, 2);
        const update = await s.updateParagraphDraft(begin.draftId, {
          runs,
          format: plan.format,
          composition: null,
          renderScale: 2,
        });
        row.updateMs = update.updateMs;
        row.overflow = update.reflow.overflow;
        row.warnings = [...new Set(update.warnings.map((w) => w.kind))];
        const commit = await s.commitParagraphEdit(begin.draftId);
        const layout = s.getPageLayout(p);
        const cell = layout.tables[pick.cell.table]?.cells.find(
          (x) => x.row === pick.cell.row && x.col === pick.cell.col,
        );
        row.v4 = {
          tableKept: tableShape(layout) === shape0,
          cellParagraphs: cell?.paragraphs.length ?? -1,
          cellTable: cell
            ? cell.paragraphs.every(
                (id) => layout.paragraphs.find((x) => x.id === id)?.table != null,
              )
            : false,
        };
        const saved = s.save({ changes: [] }).bytes;
        const ink = inkOf(model0!, layout0!.paragraphs.find((x) => x.id === pick.id)?.chars ?? []);
        const allow = [
          pick.bbox,
          plan.target.bbox,
          update.reflow.contentBox,
          ...(ink ? [ink] : []),
        ];
        await judgeSaved(c, p, saved, allow, [commit.op], row);
        const expected = squash(expectedText(text, update.reflow.glyphs));
        for (const e of TEXT_ENGINES) {
          const got = squash(
            await textInBox(e, saved, p, update.reflow.contentBox, pageOrigin(saved, p)),
          );
          row.text[e] = got === expected;
        }
        if (kind === 'same') {
          const inBox = (m: ReturnType<PdfSession['extractPage']>) =>
            m.chars.filter(
              (ch) => squash(ch.text) !== '' && inRect(ch.origin[0], ch.origin[1], pick.bbox),
            );
          const a = inBox(model0!);
          const r2 = session(saved);
          const b = inBox(r2.extractPage({ pageIndex: p }));
          r2.close();
          row.shift =
            a.length === b.length
              ? Math.max(
                  0,
                  ...a.map((ch, i) =>
                    Math.hypot(ch.origin[0] - b[i]!.origin[0], ch.origin[1] - b[i]!.origin[1]),
                  ),
                )
              : -1;
        }
      } catch (err) {
        row.error ??= err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      } finally {
        s.close();
      }
    }
  }
}

async function m4Paths(
  c: DocCache,
  file: string,
  p: number,
  totals: M4PageTotals[],
  rows: M4Row[],
) {
  const tot: M4PageTotals = { unit: 'path', file, page: p + 1, items: 0, editable: 0, reasons: {} };
  totals.push(tot);
  const s0 = session(c.bytes);
  let picks: { paintSeq: number; bbox: Rect }[];
  try {
    const pe = await s0.getPageEditability(p);
    tot.items = pe.paths.length;
    for (const q of pe.paths) {
      if (q.editable) tot.editable++;
      else for (const r of new Set(q.reasons)) tot.reasons[r] = (tot.reasons[r] ?? 0) + 1;
    }
    const size = (b: Rect) => [(b[2] - b[0]) * (b[3] - b[1]), b[2] - b[0] + b[3] - b[1]] as const;
    picks = pe.paths
      .filter((q) => q.editable)
      .sort((a, b) => {
        const [aa, al] = size(a.bbox);
        const [ba, bl] = size(b.bbox);
        return ba - aa || bl - al || a.paintSeq - b.paintSeq;
      })
      .slice(0, 5)
      .map((q) => ({ paintSeq: q.paintSeq, bbox: q.bbox }));
  } catch (err) {
    tot.error = err instanceof Error ? err.message : String(err);
    s0.close();
    return;
  }
  s0.close();
  const textBefore = orderNorm(await pageText('mupdf', c.bytes, p));
  for (const pick of picks) {
    for (const kind of ['fill', 'width', 'move'] as const) {
      const row: M4Row = {
        unit: 'path',
        file,
        page: p + 1,
        target: `path ${pick.paintSeq} [${pick.bbox.map((v) => v.toFixed(1)).join(',')}]`,
        kind,
        warnings: [],
        diffOutside: {},
        otherPagesDiff: {},
        text: {},
        objects: [],
        replaySame: null,
        updateMs: 0,
      };
      const s = session(c.bytes);
      try {
        const plan = await s.planPathEdit(p, [pick.paintSeq]);
        if (!plan.editable)
          throw new Error(`편집 불가: ${plan.limits.map((l) => l.reason).join(',')}`);
        const edit: PathEdit = {
          transform: null,
          fill: null,
          stroke: null,
          lineWidth: null,
          points: null,
          delete: false,
        };
        if (kind === 'fill') {
          if (!plan.fill) continue;
          edit.fill = [0.1, 0.6, 0.3];
        } else if (kind === 'width') {
          if (!plan.stroke) continue;
          edit.lineWidth = plan.lineWidth ? plan.lineWidth * 2 : 0.5;
        } else edit.transform = [1, 0, 0, 1, 10, 0];
        rows.push(row);
        const begin = await s.beginPathEdit(p, [pick.paintSeq], plan.revision);
        const update = await s.updatePathDraft(begin.draftId, edit, 2);
        row.updateMs = update.updateMs;
        row.warnings = [...new Set(update.warnings.map((w) => w.kind))];
        const commit = await s.commitPathEdit(begin.draftId);
        const saved = s.save({ changes: [] }).bytes;
        await judgeSaved(
          c,
          p,
          saved,
          [inflate(plan.target.bbox, 0), update.bbox],
          [commit.op],
          row,
        );
        row.text.mupdf = orderNorm(await pageText('mupdf', saved, p)) === textBefore;
      } catch (err) {
        if (!rows.includes(row)) rows.push(row);
        row.error ??= err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      } finally {
        s.close();
      }
    }
  }
}

function m4Summary(rows: M4Row[], totals: M4PageTotals[]) {
  const ok = rows.filter((r) => !r.error);
  const rate = (pass: number, n: number) => ({ pass, n, rate: n ? +(pass / n).toFixed(4) : null });
  const per = (set: M4Row[]) => ({
    n: set.length,
    diffOutside: Object.fromEntries(
      engines.map((e) => {
        const v = set.filter((r) => r.diffOutside[e]);
        return [e, rate(v.filter((r) => r.diffOutside[e]!.pixels === 0).length, v.length)];
      }),
    ),
    otherPages: rate(
      set.filter((r) => Object.values(r.otherPagesDiff).every((v) => v === 0)).length,
      set.length,
    ),
    text: Object.fromEntries(
      ['mupdf', 'pdfjs'].map((e) => {
        const v = set.filter((r) => r.text[e] !== undefined);
        return [e, rate(v.filter((r) => r.text[e]).length, v.length)];
      }),
    ),
    objects: rate(set.filter((r) => r.objects.length === 0).length, set.length),
    replay: rate(set.filter((r) => r.replaySame === true).length, set.length),
    warnings: count(set.flatMap((r) => r.warnings)),
  });
  const cells = ok.filter((r) => r.unit === 'cell');
  const paths = ok.filter((r) => r.unit === 'path');
  const same = cells.filter((r) => r.kind === 'same' && r.shift !== undefined);
  const editability = (unit: 'cell' | 'path') => {
    const t = totals.filter((x) => x.unit === unit);
    const items = t.reduce((a, x) => a + x.items, 0);
    const editable = t.reduce((a, x) => a + x.editable, 0);
    const reasons: Record<string, number> = {};
    for (const x of t)
      for (const [k, v] of Object.entries(x.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
    return {
      pages: t.length,
      items,
      editable,
      ratio: items ? +(editable / items).toFixed(4) : null,
      reasons,
    };
  };
  return {
    date: new Date().toISOString(),
    engines,
    editability: { cells: editability('cell'), paths: editability('path') },
    edits: rows.length,
    editErrors: rows
      .filter((r) => r.error)
      .map((r) => `${r.file} p${r.page} ${r.target} ${r.kind}: ${r.error}`),
    cells: {
      ...per(cells),
      byKind: Object.fromEntries(
        ['same', 'digit', 'hangul'].map((k) => [k, per(cells.filter((r) => r.kind === k))]),
      ),
      overflow: cells.filter((r) => r.overflow).length,
      shift: {
        n: same.length,
        within05: same.filter((r) => r.shift! >= 0 && r.shift! <= 0.5).length,
        values: same.map(
          (r) => `${r.file} p${r.page} ${r.target} ${r.align}: ${r.shift!.toFixed(3)}`,
        ),
      },
      v4: rate(
        cells.filter((r) => r.v4?.tableKept && r.v4.cellParagraphs === 1 && r.v4.cellTable).length,
        cells.length,
      ),
    },
    paths: {
      ...per(paths),
      byKind: Object.fromEntries(
        ['fill', 'width', 'move'].map((k) => [k, per(paths.filter((r) => r.kind === k))]),
      ),
      updateMs: (() => {
        const v = paths.map((r) => r.updateMs).sort((a, b) => a - b);
        return v.length
          ? {
              median: v[Math.floor(v.length / 2)],
              p95: v[Math.floor(v.length * 0.95)],
              max: v.at(-1),
            }
          : null;
      })(),
    },
  };
}

describe.skipIf(!dir || m4Kinds.length === 0)(
  'M4 corpus sample (contract 6.1: table cells and paths)',
  () => {
    it(
      '3 cells × 3 kinds on table pages, 5 paths × 3 kinds on diagram pages',
      async () => {
        const rows: M4Row[] = [];
        const totals: M4PageTotals[] = [];
        const files = [
          ...new Set([
            ...(m4Kinds.includes('cells') ? Object.keys(M4_TABLE_PAGES) : []),
            ...(m4Kinds.includes('paths') ? Object.keys(M4_PATH_PAGES) : []),
          ]),
        ]
          .filter((f) => !only || only.includes(f))
          .sort();
        for (const file of files) {
          const t0 = performance.now();
          const bytes = new Uint8Array(readFileSync(join(dir!, file)));
          const probe = openMupdf(bytes);
          const pageCount = probe.countPages();
          const objects = new Map<number, PageObjects>();
          for (let k = 0; k < Math.min(pageCount, OBJECT_PAGES); k++)
            objects.set(k, pageObjects(probe, k));
          probe.destroy();
          const cellPages = m4Kinds.includes('cells') ? (M4_TABLE_PAGES[file] ?? []) : [];
          const pathPages = m4Kinds.includes('paths') ? (M4_PATH_PAGES[file] ?? []) : [];
          const edited = [...cellPages, ...pathPages].map((q) => q - 1);
          const renderPages = [
            ...new Set([
              ...Array.from({ length: Math.min(pageCount, OTHER_RENDER_PAGES) }, (_v, k) => k),
              ...edited,
            ]),
          ];
          const c: DocCache = {
            bytes,
            pageCount,
            mupdfOriginal: mupdfRasters(bytes, renderPages),
            objects,
            engineOriginal: new Map(),
            textOriginal: new Map(),
          };
          for (const q of cellPages) await m4Cells(c, file, q - 1, totals, rows);
          for (const q of pathPages) await m4Paths(c, file, q - 1, totals, rows);
          console.log(
            `${file}: ${rows.filter((r) => r.file === file).length} edits ${((performance.now() - t0) / 1000).toFixed(1)} s`,
          );
        }
        const summary = m4Summary(rows, totals);
        mkdirSync(dirname(m4Out), { recursive: true });
        writeFileSync(m4Out, JSON.stringify({ summary, totals, rows }, null, 1));
        console.log(JSON.stringify(summary, null, 1));
        expect(rows.length).toBeGreaterThan(0);
      },
      6 * 3_600_000,
    );
  },
);
