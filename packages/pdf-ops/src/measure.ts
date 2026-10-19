/**
 * 매칭률 측정 도구(코퍼스 회귀·glyphSeq 정책 비교, docs/m1-pdf-ops.md 5.5절).
 * 패키지 index 에서 내보내지 않고 하위 경로 `@pdf-editor/pdf-ops/measure` 로만 제공한다.
 *
 * - SourceMap 은 계수 정책을 지정해 만든다(`buildSourceMap` 과 같고 정책만 다르다).
 * - PageModel 은 호출자가 같은 정책으로 만든다(core `extractPage` 또는 pdf-ops 테스트 헬퍼). `linkPage` 자체는
 *   정책과 무관하다.
 * - 실패 쪽 = 총수 차이(글리프·도형)가 0 이 아니거나, SourceMap 이 소유한 번호의 글자·도형 중 매칭되지 않은
 *   것이 있는 쪽. 소유 없는 번호(패턴 셀 글리프 등)는 실패로 세지 않고 따로 집계한다.
 */
import type * as mupdf from 'mupdf';
import type { PageModel, SourceMap } from '@pdf-editor/shared-types';
import { buildSourceMapImpl, GLYPH_SEQ_POLICY, type GlyphSeqPolicy } from './content-interp.js';
import { link } from './link.js';

export { GLYPH_SEQ_POLICY, type GlyphSeqPolicy };

export const GLYPH_SEQ_POLICIES: readonly GlyphSeqPolicy[] = ['first-arrival', 'no-clip'];

/** 계수 정책을 지정해 SourceMap 을 만든다. */
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
  /** SourceMap 오류 수(토크나이저 오류, MuPDF 해석 중단 에뮬레이션). */
  mapErrors: number;
  buildMs: number;
  linkMs: number;
}

/** 한 쪽 측정. model 은 같은 정책으로 만든 PageModel 이다. map 을 주지 않으면 여기서 만든다. */
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
  /** 측정한 쪽(PageModel 생성 예외 쪽 제외). */
  pages: number;
  failedPages: number[];
  /** 소유 번호인데 매칭되지 않은 글자·도형. */
  unmatchedChars: number;
  unmatchedPaints: number;
  /** 소유 없는 번호의 글자·도형(패턴 셀 글리프 등, 실패로 세지 않음). */
  unownedChars: number;
  unownedPaints: number;
  /** |총수 차이| 합. */
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
  /** PageModel·SourceMap 생성 예외(예: MuPDF 해석 중단 R10). */
  pageErrors: { pageIndex: number; policy: GlyphSeqPolicy; message: string }[];
}

/** 같은 정책으로 PageModel 을 만드는 함수(core extractPage 또는 테스트 헬퍼를 감싼다). */
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

/** 문서 전체 쪽을 정책별로 측정한다. 쪽 단위 예외는 pageErrors 에 남기고 계속한다. */
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

/** 문서별·정책별 Markdown 표와 정책별 합계 행. */
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
