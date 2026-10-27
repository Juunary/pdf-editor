/**
 * Match-rate measurement tool (corpus regression, glyphSeq policy comparison, docs/m1-pdf-ops.md section 5.5).
 * Not exported from the package index; provided only through the subpath `@pdf-editor/pdf-ops/measure`.
 *
 * - The SourceMap is built with a specified counting policy (same as `buildSourceMap`, only the policy differs).
 * - The caller builds the PageModel with the same policy (core `extractPage` or the pdf-ops test helper). `linkPage` itself is
 *   independent of the policy.
 * - Failed page = total-count difference (glyphs, shapes) is not 0, or some character/shape with a SourceMap-owned number was not
 *   matched. Unowned numbers (pattern cell glyphs, etc.) are not counted as failures and are tallied separately.
 */
import type * as mupdf from 'mupdf';
import type { PageModel, SourceMap } from '@pdf-editor/shared-types';
import { buildSourceMapImpl, GLYPH_SEQ_POLICY, type GlyphSeqPolicy } from './content-interp.js';
import { link } from './link.js';

export { GLYPH_SEQ_POLICY, type GlyphSeqPolicy };

export const GLYPH_SEQ_POLICIES: readonly GlyphSeqPolicy[] = ['first-arrival', 'no-clip'];

/** Builds a SourceMap with a specified counting policy. */
export function buildSourceMapForPolicy(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  policy: GlyphSeqPolicy,
  maxFormDepth = 8,
): SourceMap {
  return buildSourceMapImpl(doc, pageIndex, maxFormDepth, policy);
}

export interface PageMeasure {
  pageIndex: number;
  policy: GlyphSeqPolicy;
  failed: boolean;
  glyphCountDelta: number;
  paintCountDelta: number;
  chars: number;
  ownedChars: number;
  matchedChars: number;
  paints: number;
  ownedPaints: number;
  matchedPaints: number;
  maxOriginError: number;
  /** SourceMap error count (tokenizer errors, emulation of MuPDF parse aborts). */
  mapErrors: number;
  buildMs: number;
  linkMs: number;
}

/** Measures one page. model is a PageModel built with the same policy. If map is not given, it is built here. */
export function measurePage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  model: PageModel,
  policy: GlyphSeqPolicy,
  map: SourceMap = buildSourceMapForPolicy(doc, pageIndex, policy),
): PageMeasure {
  const linkage = link(model, map, { originTolerance: 1, window: 64 });
  const glyphs = new Set<number>();
  const paints = new Set<number>();
  for (const op of map.ops) {
    op.text?.glyphs.forEach((g) => g.seq !== null && glyphs.add(g.seq));
    op.paintSeq?.forEach((s) => paints.add(s));
  }
  const ownedChars = model.chars.filter((c) => glyphs.has(c.glyphSeq)).length;
  const ownedPaints = [...model.paths, ...model.images, ...model.shades].filter((p) =>
    paints.has(p.paintSeq),
  ).length;
  const s = linkage.stats;
  return {
    pageIndex,
    policy,
    failed:
      s.glyphCountDelta !== 0 ||
      s.paintCountDelta !== 0 ||
      s.matchedChars !== ownedChars ||
      s.matchedPaints !== ownedPaints,
    glyphCountDelta: s.glyphCountDelta,
    paintCountDelta: s.paintCountDelta,
    chars: s.chars,
    ownedChars,
    matchedChars: s.matchedChars,
    paints: s.paints,
    ownedPaints,
    matchedPaints: s.matchedPaints,
    maxOriginError: s.maxOriginError,
    mapErrors: map.errors.length,
    buildMs: map.buildMs,
    linkMs: linkage.linkMs,
  };
}

export interface PolicySummary {
  /** Pages measured (excluding pages where PageModel creation threw). */
  pages: number;
  failedPages: number[];
  /** Characters/shapes with an owned number that were not matched. */
  unmatchedChars: number;
  unmatchedPaints: number;
  /** Characters/shapes with unowned numbers (pattern cell glyphs, etc.; not counted as failures). */
  unownedChars: number;
  unownedPaints: number;
  /** Sum of |total-count difference|. */
  glyphCountDeltaAbs: number;
  paintCountDeltaAbs: number;
  chars: number;
  paints: number;
  buildMs: number;
  linkMs: number;
}

export interface DocumentMeasure {
  file: string;
  pageCount: number;
  byPolicy: Partial<Record<GlyphSeqPolicy, PolicySummary>>;
  /** PageModel/SourceMap creation exceptions (e.g. MuPDF parse abort R10). */
  pageErrors: { pageIndex: number; policy: GlyphSeqPolicy; message: string }[];
}

/** Function that builds a PageModel with the same policy (wraps core extractPage or a test helper). */
export type ModelProvider = (
  doc: mupdf.PDFDocument,
  pageIndex: number,
  policy: GlyphSeqPolicy,
) => PageModel;

function emptySummary(): PolicySummary {
  return {
    pages: 0,
    failedPages: [],
    unmatchedChars: 0,
    unmatchedPaints: 0,
    unownedChars: 0,
    unownedPaints: 0,
    glyphCountDeltaAbs: 0,
    paintCountDeltaAbs: 0,
    chars: 0,
    paints: 0,
    buildMs: 0,
    linkMs: 0,
  };
}

/** Measures all pages of a document per policy. Page-level exceptions are left in pageErrors and processing continues. */
export function measureDocument(
  file: string,
  doc: mupdf.PDFDocument,
  provider: ModelProvider,
  policies: readonly GlyphSeqPolicy[] = GLYPH_SEQ_POLICIES,
): DocumentMeasure {
  const result: DocumentMeasure = {
    file,
    pageCount: doc.countPages(),
    byPolicy: {},
    pageErrors: [],
  };
  for (const policy of policies) {
    const sum = emptySummary();
    for (let p = 0; p < result.pageCount; p++) {
      let m: PageMeasure;
      try {
        m = measurePage(doc, p, provider(doc, p, policy), policy);
      } catch (e) {
        result.pageErrors.push({
          pageIndex: p,
          policy,
          message: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      sum.pages++;
      if (m.failed) sum.failedPages.push(p);
      sum.unmatchedChars += m.ownedChars - m.matchedChars;
      sum.unmatchedPaints += m.ownedPaints - m.matchedPaints;
      sum.unownedChars += m.chars - m.ownedChars;
      sum.unownedPaints += m.paints - m.ownedPaints;
      sum.glyphCountDeltaAbs += Math.abs(m.glyphCountDelta);
      sum.paintCountDeltaAbs += Math.abs(m.paintCountDelta);
      sum.chars += m.chars;
      sum.paints += m.paints;
      sum.buildMs += m.buildMs;
      sum.linkMs += m.linkMs;
    }
    result.byPolicy[policy] = sum;
  }
  return result;
}

/** Per-document, per-policy Markdown table with per-policy total rows. */
export function formatMeasureTable(docs: readonly DocumentMeasure[]): string {
  const head =
    '| 문서 | 정책 | 쪽 | 실패 쪽 | 글자 | 미매칭 글자 | 소유 없는 글자 | 도형 | 미매칭 도형 | 소유 없는 도형 | 글리프 총수 차이 | 도형 총수 차이 | 예외 쪽 |';
  const rows = [head, '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const totals = new Map<GlyphSeqPolicy, PolicySummary & { errors: number }>();
  for (const d of docs) {
    for (const [policy, s] of Object.entries(d.byPolicy) as [GlyphSeqPolicy, PolicySummary][]) {
      const errors = d.pageErrors.filter((e) => e.policy === policy).length;
      rows.push(
        `| ${d.file} | ${policy} | ${s.pages} | ${s.failedPages.length} | ${s.chars} | ${s.unmatchedChars} | ${s.unownedChars} | ${s.paints} | ${s.unmatchedPaints} | ${s.unownedPaints} | ${s.glyphCountDeltaAbs} | ${s.paintCountDeltaAbs} | ${errors} |`,
      );
      const t = totals.get(policy) ?? { ...emptySummary(), errors: 0 };
      t.pages += s.pages;
      t.failedPages.push(...s.failedPages);
      t.unmatchedChars += s.unmatchedChars;
      t.unmatchedPaints += s.unmatchedPaints;
      t.unownedChars += s.unownedChars;
      t.unownedPaints += s.unownedPaints;
      t.glyphCountDeltaAbs += s.glyphCountDeltaAbs;
      t.paintCountDeltaAbs += s.paintCountDeltaAbs;
      t.chars += s.chars;
      t.paints += s.paints;
      t.errors += errors;
      totals.set(policy, t);
    }
  }
  for (const [policy, t] of totals) {
    rows.push(
      `| **합계** | ${policy} | ${t.pages} | ${t.failedPages.length} | ${t.chars} | ${t.unmatchedChars} | ${t.unownedChars} | ${t.paints} | ${t.unmatchedPaints} | ${t.unownedPaints} | ${t.glyphCountDeltaAbs} | ${t.paintCountDeltaAbs} | ${t.errors} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}
