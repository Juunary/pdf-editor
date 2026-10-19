import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mupdf from 'mupdf';
import type { ParagraphLimitReason, EditLimitReason } from '@pdf-editor/shared-types';
import {
  FontManager,
  planPageEditability,
  planParagraphEdit,
  type ParagraphEditContext,
} from '../src/index.js';
import { loadModules, pageContext } from './helpers/edit-context.js';
import { editParagraph, fallbackFor } from './helpers/edit-driver.js';
import {
  diffOutside,
  pageText,
  raster,
  squash,
  textInBox,
  type Engine,
} from './helpers/engines.js';

/**
 * 계약 8.2 코퍼스 편집 표본(S1 몫: 편집 가능 비율·사유 분포·판정 시간, 표본 편집 (i) 같은 텍스트로 교체).
 * 환경 변수가 없으면 건너뛴다. 결과 JSON 은 git 밖에 둔다.
 *   EDIT_CORPUS_DIR=<PDF 폴더> [EDIT_CORPUS_OUT=<json>] [EDIT_CORPUS_ENGINES=mupdf,pdfjs,poppler] [EDIT_CORPUS_FILES=a.pdf,b.pdf]
 * 쪽: 문서마다 1·4쪽(없으면 있는 쪽). 표본: 쪽마다 읽기 순서 앞에서부터 편집 가능하고 20자 이상인 흐름 문단 최대 3개.
 * 편집 (ii)·(iii) 와 리플로우 결과 측정은 reflow 구현 뒤 통합 단계에서 한다(이 측정의 배치는 테스트용 단순 배치).
 */
const dir = process.env.EDIT_CORPUS_DIR;
const out = process.env.EDIT_CORPUS_OUT;
const engineList = (process.env.EDIT_CORPUS_ENGINES ?? 'mupdf').split(',') as Engine[];
const only = process.env.EDIT_CORPUS_FILES?.split(',');

type Reason = ParagraphLimitReason | EditLimitReason;

interface SampleResult {
  paragraphId: number;
  chars: number;
  mode: string | null;
  container: string | null;
  diffOutside: Record<string, number>;
  textEqual: Record<string, boolean>;
  textDiff?: Record<string, string>;
  pageContains: Record<string, boolean>;
  /** 테스트용 단순 배치가 영역을 넘쳤다(넘친 줄은 블록 BBox 에서 잘린다). */
  overflow?: boolean;
  warnings: string[];
  fallbackChars?: string[];
  error?: string;
  editMs: number;
}

interface PageResult {
  file: string;
  page: number;
  paragraphs: number;
  flow: number;
  editable: number;
  editableFlow: number;
  reasons: Partial<Record<Reason, number>>;
  /** 첫 사유(문단마다 하나) 분포. */
  primary: Partial<Record<Reason, number>>;
  removeSkipCodes: Record<string, number>;
  pageMs: number;
  planMsMax: number;
  planMsAvg: number;
  planMs: number[];
  ctxMs: number;
  samples: SampleResult[];
  error?: string;
}

const open = (b: Uint8Array) =>
  mupdf.Document.openDocument(b, 'application/pdf') as mupdf.PDFDocument;

async function samplePage(file: string, bytes: Uint8Array, pageIndex: number): Promise<PageResult> {
  const doc = open(bytes);
  const t0 = performance.now();
  const ctx: ParagraphEditContext = pageContext(doc, pageIndex);
  const ctxMs = performance.now() - t0;
  const fm = new FontManager(doc, fallbackFor(doc));
  planPageEditability(ctx, fm);
  const t1 = performance.now();
  const pe = planPageEditability(ctx, fm);
  const pageMs = performance.now() - t1;
  const reasons: PageResult['reasons'] = {};
  const primary: PageResult['primary'] = {};
  const codes: Record<string, number> = {};
  const times: number[] = [];
  const editableIds: number[] = [];
  let flow = 0;
  let editableFlow = 0;
  for (const p of ctx.layout.paragraphs) {
    const plan = planParagraphEdit(ctx, fm, p.id);
    times.push(plan.planMs);
    const isFlow = p.table === null && p.figure === null;
    if (isFlow) flow++;
    if (plan.editable) {
      if (isFlow) {
        editableFlow++;
        editableIds.push(p.id);
      }
      continue;
    }
    const rs = [...new Set(plan.limits.map((l) => l.reason))];
    for (const r of rs) reasons[r] = (reasons[r] ?? 0) + 1;
    if (rs[0]) primary[rs[0]] = (primary[rs[0]] ?? 0) + 1;
    for (const l of plan.limits) if (l.code) codes[l.code] = (codes[l.code] ?? 0) + 1;
  }
  // 표본: 읽기 순서 앞에서부터.
  const order = ctx.layout.readingOrder.filter((r) => r.kind === 'paragraph').map((r) => r.id);
  const picks = order
    .filter((id) => editableIds.includes(id))
    .filter((id) => squash(ctx.layout.paragraphs.find((p) => p.id === id)!.text).length >= 20)
    .slice(0, 3);
  const samples: SampleResult[] = [];
  for (const id of picks) {
    const d = open(bytes);
    const res: SampleResult = {
      paragraphId: id,
      chars: 0,
      mode: null,
      container: null,
      diffOutside: {},
      textEqual: {},
      pageContains: {},
      warnings: [],
      editMs: 0,
    };
    try {
      const c = pageContext(d, pageIndex);
      const p = c.layout.paragraphs.find((q) => q.id === id)!;
      res.chars = p.chars.length;
      const te = performance.now();
      const r = editParagraph(c, new FontManager(d, fallbackFor(d)), id);
      res.editMs = performance.now() - te;
      res.mode = r.plan.insertion?.mode ?? null;
      res.overflow = r.result.summary.overflow;
      res.container = r.plan.insertion?.container ?? null;
      res.warnings = [...new Set([...r.plan.warnings, ...r.warnings].map((w) => w.kind))];
      res.fallbackChars = r.warnings
        .filter((w) => w.kind === 'font-fallback' || w.kind === 'glyph-missing')
        .map((w) => w.message);
      const after = d.saveToBuffer('garbage=yes,compress').asUint8Array().slice();
      for (const e of engineList) {
        const a = await raster(e, bytes, pageIndex);
        const b = await raster(e, after, pageIndex);
        const page = d.loadPage(pageIndex);
        const bounds = page.getBounds();
        page.destroy();
        res.diffOutside[e] = diffOutside(
          a,
          b,
          [p.bbox, r.result.summary.contentBox],
          [bounds[0], bounds[1]],
        );
        // 계약 8.3: 편집 블록 상자 안 글자만 모아 공백류를 지우고 비교. glyph-missing 글자는 입력에서 뺀다.
        const missing = new Set(
          r.result.summary.glyphs.filter((g) => g.font.kind === 'missing').map((g) => g.offset),
        );
        const expected = squash([...r.text].filter((_c, i) => !missing.has(i)).join(''));
        const got = squash(
          await textInBox(e, after, pageIndex, r.result.summary.contentBox, [bounds[0], bounds[1]]),
        );
        res.textEqual[e] = got === expected;
        if (got !== expected) res.textDiff = { ...(res.textDiff ?? {}), [e]: got.slice(0, 200) };
        // 보조 지표: 쪽 전체 텍스트에 연속으로 있는가.
        res.pageContains[e] = squash(await pageText(e, after, pageIndex)).includes(expected);
      }
    } catch (err) {
      res.error = err instanceof Error ? err.message : String(err);
    } finally {
      d.destroy();
    }
    samples.push(res);
  }
  doc.destroy();
  return {
    file,
    page: pageIndex + 1,
    paragraphs: ctx.layout.paragraphs.length,
    flow,
    editable: pe.paragraphs.filter((p) => p.editable).length,
    editableFlow,
    reasons,
    primary,
    removeSkipCodes: codes,
    pageMs,
    planMsMax: times.length ? Math.max(...times) : 0,
    planMsAvg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
    planMs: times,
    ctxMs,
    samples,
  };
}

describe.skipIf(!dir)('코퍼스 편집 가능 비율(계약 8.2)', () => {
  it('문서마다 1·4쪽, 흐름 문단 편집 가능 비율·사유·판정 시간·표본 편집 (i)', async () => {
    await loadModules();
    const files = readdirSync(dir!)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .filter((f) => !only || only.includes(f))
      .sort();
    const results: PageResult[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(join(dir!, file)));
      const doc = open(bytes);
      const n = doc.countPages();
      doc.destroy();
      const pages = [...new Set([0, 3].map((p) => Math.min(p, n - 1)))];
      for (const p of pages) {
        try {
          results.push(await samplePage(file, bytes, p));
        } catch (err) {
          results.push({
            file,
            page: p + 1,
            paragraphs: 0,
            flow: 0,
            editable: 0,
            editableFlow: 0,
            reasons: {},
            primary: {},
            removeSkipCodes: {},
            pageMs: 0,
            planMsMax: 0,
            planMsAvg: 0,
            planMs: [],
            ctxMs: 0,
            samples: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const sum = (f: (r: PageResult) => number) => results.reduce((a, r) => a + f(r), 0);
    const flow = sum((r) => r.flow);
    const ok = sum((r) => r.editableFlow);
    const reasons: Record<string, number> = {};
    const primary: Record<string, number> = {};
    const codes: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + v!;
      for (const [k, v] of Object.entries(r.primary)) primary[k] = (primary[k] ?? 0) + v!;
      for (const [k, v] of Object.entries(r.removeSkipCodes)) codes[k] = (codes[k] ?? 0) + v;
    }
    const samples = results.flatMap((r) =>
      r.samples.map((s) => ({ ...s, file: r.file, page: r.page })),
    );
    const summary = {
      date: new Date().toISOString(),
      engines: engineList,
      documents: new Set(results.map((r) => r.file)).size,
      pages: results.length,
      pageErrors: results.filter((r) => r.error).map((r) => `${r.file} p${r.page}: ${r.error}`),
      paragraphs: sum((r) => r.paragraphs),
      flow,
      editableFlow: ok,
      editableRatio: flow ? ok / flow : 0,
      reasons,
      primary,
      removeSkipCodes: codes,
      pageMsMax: Math.max(0, ...results.map((r) => r.pageMs)),
      pageMsMedian: median(results.map((r) => r.pageMs)),
      planMsMax: Math.max(0, ...results.map((r) => r.planMsMax)),
      planMsP95: percentile(
        results.flatMap((r) => r.planMs),
        0.95,
      ),
      planMsOver10: results.flatMap((r) => r.planMs).filter((v) => v > 10).length,
      pageMsP95: percentile(
        results.map((r) => r.pageMs),
        0.95,
      ),
      planMsAvg:
        sum((r) => r.planMsAvg * r.paragraphs) /
        Math.max(
          1,
          sum((r) => r.paragraphs),
        ),
      samples: samples.length,
      sampleErrors: samples
        .filter((s) => s.error)
        .map((s) => `${s.file} p${s.page} #${s.paragraphId}: ${s.error}`),
      sampleDiffNonZero: samples
        .filter((s) => Object.values(s.diffOutside).some((v) => v !== 0))
        .map((s) => `${s.file} p${s.page} #${s.paragraphId}: ${JSON.stringify(s.diffOutside)}`),
      sampleTextMismatch: samples
        .filter((s) => Object.values(s.textEqual).some((v) => !v))
        .map(
          (s) =>
            `${s.file} p${s.page} #${s.paragraphId}${s.overflow ? ' (단순 배치 초과)' : ''}: ${JSON.stringify(s.textEqual)}`,
        ),
      sampleOverflow: samples.filter((s) => s.overflow).length,
      samplePageTextNotContiguous: samples
        .filter((s) => Object.values(s.pageContains).some((v) => !v))
        .map((s) => `${s.file} p${s.page} #${s.paragraphId}: ${JSON.stringify(s.pageContains)}`),
      modes: count(samples.map((s) => `${s.container}/${s.mode}`)),
      warnings: count(samples.flatMap((s) => s.warnings)),
      fallbackMessages: samples.flatMap((s) =>
        (s.fallbackChars ?? []).map((m) => `${s.file} p${s.page} #${s.paragraphId}: ${m}`),
      ),
      slowPlans: results
        .filter((r) => r.planMsMax > 10)
        .map((r) => `${r.file} p${r.page}: ${r.planMsMax.toFixed(1)} ms`),
    };
    console.log(JSON.stringify(summary, null, 1));
    if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 1));
    expect(results.length).toBeGreaterThan(0);
  }, 1_800_000);
});

function percentile(v: number[], q: number): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
}

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function count(list: string[]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const k of list) o[k] = (o[k] ?? 0) + 1;
  return o;
}
