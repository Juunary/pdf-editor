// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf, wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  assessRedactionImpact,
  decideSaveMethod,
  embedFont,
  formatNumber,
  missingCodepoints,
  redactRegions,
  serializeTextBlock,
  type EmbeddedFont,
  type HeapEstimate,
} from '@pdf-editor/pdf-ops';
import type { ChangeKind, Rect, SaveMethod } from '@pdf-editor/shared-types';
import { lineText, readTextBlocks, unionRect, type ParagraphCandidate } from './corpus-select.js';
import { layoutParagraph, type ParagraphLayout } from './layout.js';
import { diffRasters, inkPixels, renderPage, type Raster } from './raster.js';
import { captureMupdfLog, inspectFont, type FontObjectInfo } from './spike.js';

/**
 * Paragraph replacement on corpus documents (generalizes the Day 1 spike procedure, docs/m0-corpus-recheck.md section 2).
 * For each selected paragraph: redaction (remove text, keep line art and images) → embed Korean fallback font → new content stream;
 * one full save per document → reopen and verify. Coordinates are MuPDF page coordinates (origin at top left).
 */

const REPLACEMENT_POOL = [
  '원본 문단을 지우고 한글 폴백 폰트로 다시 썼습니다.',
  '주변의 선과 배경, 인접 문단은 그대로 남아야 합니다.',
  '저장 후 다시 열어 검색과 복사가 되는지 확인합니다.',
  '다람쥐 헌 쳇바퀴에 타고파.',
];

export const replacementPrefix = (k: number) => `교체 문단 ${k}:`;
/** Search terms after reopening. Only terms that actually appear in the placed text are checked. */
export const searchTermsFor = (k: number) => [`교체 문단 ${k}`, '폴백 폰트로'];

/** Picks the longest replacement sentence (at a word boundary) that fits within the original paragraph's line count. */
export function fitReplacement(
  font: mupdf.Font,
  k: number,
  fontSize: number,
  lineHeight: number,
  box: Rect,
  maxLines: number,
): { text: string; layout: ParagraphLayout } {
  const words: string[] = [...replacementPrefix(k).split(' ')];
  while (words.join(' ').length < 4000) {
    for (const s of REPLACEMENT_POOL) words.push(...s.split(' '));
  }
  const at = (n: number) => {
    const text = words.slice(0, n).join(' ');
    return {
      text,
      layout: layoutParagraph({ font, text, fontSize, lineHeight, ascent: 0.88, box }),
    };
  };
  const fits = (n: number) => {
    const r = at(n);
    return r.layout.lineCount <= maxLines && !r.layout.overflow;
  };
  let lo = 1;
  let hi = words.length;
  if (!fits(lo)) return at(lo);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}

export interface ParagraphContext extends ParagraphCandidate {
  /** Number of Form usage locations on the paragraph's page (A1-1: all are instantiated by direct page redaction) */
  formUsagesOnPage: number;
  /** Text Forms overlapping the paragraph area, and their restrictions */
  textFormsOverlapping: {
    objectNumber: number;
    usages: number;
    depth: number;
    L1NoResources: boolean;
    L2StructParents: boolean;
    L6ParseError: boolean;
    L7OptionalContent: boolean;
  }[];
  /** Number of MCIDs in the paragraph's page content (tagged PDF structure linkage) */
  mcidOnPage: number;
  tagged: boolean;
  /** Character-mapping risk among the paragraph's fonts (non-standard encoding without ToUnicode, Type3) */
  fontMappingRisk: string[];
}

export interface Restriction {
  code:
    | 'L1'
    | 'L2'
    | 'L5'
    | 'L6'
    | 'L7'
    | 'form-instancing'
    | 'tagged'
    | 'existing-redact'
    | 'link-removed'
    | 'font-mapping'
    | 'unmapped-text';
  /** v1 classification: edit restriction (limit) or warning (warn) */
  level: 'limit' | 'warn';
  detail: string;
}

export interface ParagraphResult {
  index: number;
  pageIndex: number;
  rect: Rect;
  lineCount: number;
  charCount: number;
  fontSize: number;
  linePitch: number;
  fonts: string[];
  hangulRatio: number;
  restrictions: Restriction[];
  redaction: {
    ok: boolean;
    error: string | null;
    ms: number;
    targetLinesTotal: number;
    targetLinesRemaining: number;
    neighborLinesTotal: number;
    neighborLinesLost: number;
    /** Number of other pixels outside the edit area (strict), number exceeding GLYPH_DELTA (classification criterion), maximum channel difference */
    outsidePx: number;
    outsideStrongPx: number;
    outsideMaxDelta: number;
    outsideBbox: [number, number, number, number] | null;
  };
  layout: {
    text: string;
    lineCount: number;
    maxLines: number;
    overflow: boolean;
    missing: number[];
    glyphs: number;
  } | null;
  preSave: {
    /** Number of pixels that differ from the reference render (strict) */
    vsReferencePx: number;
    /** Of those, number whose channel difference exceeds GLYPH_DELTA (classification criterion) */
    vsReferenceStrongPx: number;
    vsReferenceMaxDelta: number;
    referenceInkPx: number;
    outsidePx: number;
    outsideStrongPx: number;
  } | null;
  reopen: {
    textFound: boolean;
    targetLinesRemaining: number;
    neighborLinesLost: number;
    searchHits: Record<string, number>;
    vsPreSavePx: number;
    outsidePx: number;
    outsideStrongPx: number;
  } | null;
  /** For Poppler classification (pixel conversion is done by the caller) */
  exclusion: Rect;
  pageBounds: Rect;
  searchTerms: string[];
  failures: string[];
}

export interface CorpusEditResult {
  paragraphs: ParagraphResult[];
  font: FontObjectInfo | null;
  otherPages: { pageIndex: number; diffPx: number }[];
  save: {
    ok: boolean;
    error: string | null;
    method: SaveMethod | null;
    options: string | null;
    reason: string | null;
    canBeSavedIncrementally: { afterOpen: boolean; beforeSave: boolean };
    heap: HeapEstimate | null;
    subsetMs: number;
    saveMs: number;
    bytes: number;
    wasmHeapAfterSaveBytes: number | null;
  };
  openMs: number;
  mupdfMessages: { count: number; sample: string[] };
  savedBytes: Uint8Array | null;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * Glyph classification threshold (channel 0–255). Even for the same glyph, when the origin straddles a 1/4 px quantization boundary the edge changes by about 64 levels
 * (measured: zen-ko-moon 1 character up to 65 levels), and pages with transparency groups differ by 1 level from compositing rounding
 * (zen-ko-kimtw all 15,040 px by 1 level). Missing or substituted glyphs (Day 1 CFF failure) are 255 levels, so this value separates them.
 */
export const GLYPH_DELTA = 96;

/** Number of differing pixels, number exceeding GLYPH_DELTA, maximum channel difference. Pixels inside exclude (pixel coordinates) are not counted. */
function diffStats(
  a: Raster,
  b: Raster,
  exclude?: Rect,
): { differing: number; strong: number; maxDelta: number } {
  let differing = 0;
  let strong = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.pixels.length; i += 3) {
    if (exclude) {
      const p = i / 3;
      const x = p % a.width;
      const y = (p - x) / a.width;
      if (x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3]) continue;
    }
    const d = Math.max(
      Math.abs(a.pixels[i]! - b.pixels[i]!),
      Math.abs(a.pixels[i + 1]! - b.pixels[i + 1]!),
      Math.abs(a.pixels[i + 2]! - b.pixels[i + 2]!),
    );
    if (d > 0) differing++;
    if (d > GLYPH_DELTA) strong++;
    if (d > maxDelta) maxDelta = d;
  }
  return { differing, strong, maxDelta };
}
const round3 = (n: number) => Number(formatNumber(n));

/** Rounds the line origin to three decimal places like serialization, and shifts that line's glyphs by the same amount. */
function snapLines(layout: ParagraphLayout): void {
  let g = 0;
  for (const line of layout.lines) {
    if (line.gids.length === 0) continue;
    const dx = round3(line.x) - line.x;
    const dy = round3(line.y) - line.y;
    line.x += dx;
    line.y += dy;
    for (let i = 0; i < line.gids.length; i++, g++) {
      layout.glyphs[g]!.x += dx;
      layout.glyphs[g]!.y += dy;
    }
  }
}
const pageText = (page: mupdf.Page) => page.toStructuredText('preserve-whitespace').asText();

const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

/**
 * Number of erased paragraph lines that remain. The same sentence may appear again on the same page (another usage location of a shared Form, etc.), so
 * classify by whether the occurrence count dropped by the in-paragraph count, not by existence. Text is compared with whitespace removed.
 */
function targetRemaining(lines: string[], target: string, before: string, after: string): number {
  return lines.filter(
    (l) => occurrences(after, l) > occurrences(before, l) - occurrences(target, l),
  ).length;
}

/** Number of other block lines whose occurrence count dropped (erased along with it). */
function neighborsLost(lines: string[], target: string, before: string, after: string): number {
  return [...new Set(lines)].filter(
    (l) => occurrences(after, l) < occurrences(before, l) - occurrences(target, l),
  ).length;
}

const meaningful = (lines: string[]) => lines.map(squash).filter((l) => l.length >= 8);

function toPdfRect(page: mupdf.PDFPage, rect: Rect): Rect {
  const r = mupdf.Rect.transform(rect, mupdf.Matrix.invert(page.getTransform()));
  return [r[0], r[1], r[2], r[3]];
}

/** Page coordinates → render pixel coordinates (2px margin). The renderPage pixmap origin is floor(bounds × scale). */
function pixelRect(rect: Rect, bounds: Rect, scale: number): Rect {
  const ox = Math.floor(bounds[0] * scale);
  const oy = Math.floor(bounds[1] * scale);
  return [
    Math.floor(rect[0] * scale) - ox - 2,
    Math.floor(rect[1] * scale) - oy - 2,
    Math.ceil(rect[2] * scale) - ox + 2,
    Math.ceil(rect[3] * scale) - oy + 2,
  ];
}

export const renderScale = (bounds: Rect) =>
  Math.min(2, 2000 / Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]));

/** Classifies v1 edit restrictions and warnings from paragraph info (PLAN.md 1.4·3.1·3.3·3.4). */
export function judgeRestrictions(p: ParagraphContext): Restriction[] {
  const out: Restriction[] = [];
  for (const f of p.textFormsOverlapping) {
    const tag = `Form ${f.objectNumber}(사용 ${f.usages}곳, 깊이 ${f.depth})`;
    if (f.L1NoResources)
      out.push({ code: 'L1', level: 'limit', detail: `${tag}: 자체 /Resources 없음` });
    if (f.L2StructParents)
      out.push({ code: 'L2', level: 'limit', detail: `${tag}: /StructParents·MCID` });
    if (f.depth > 8) out.push({ code: 'L5', level: 'limit', detail: `${tag}: 깊이 > 8` });
    if (f.L6ParseError) out.push({ code: 'L6', level: 'limit', detail: `${tag}: 토크나이저 실패` });
    if (f.L7OptionalContent) out.push({ code: 'L7', level: 'warn', detail: `${tag}: /OC` });
  }
  if (p.formUsagesOnPage > 0)
    out.push({
      code: 'form-instancing',
      level: 'warn',
      detail: `쪽의 Form 사용 위치 ${p.formUsagesOnPage}곳이 페이지 redaction 으로 인스턴스화됨(A1-1)`,
    });
  if (p.tagged)
    out.push({
      code: 'tagged',
      level: p.mcidOnPage > 0 ? 'limit' : 'warn',
      detail: `태그 PDF(쪽 MCID ${p.mcidOnPage}개): 편집 영역 구조 갱신 미보장(1.4)`,
    });
  if (p.fontMappingRisk.length)
    out.push({
      code: 'font-mapping',
      level: 'warn',
      detail: `ToUnicode 없는 비표준 인코딩·Type3: ${p.fontMappingRisk.join(', ')}`,
    });
  if (p.unmappedRatio > 0)
    out.push({
      code: 'unmapped-text',
      level: 'limit',
      detail: `추출 문자 중 U+FFFD·PUA ${(p.unmappedRatio * 100).toFixed(1)}%`,
    });
  return out;
}

export interface CorpusEditInput {
  bytes: Uint8Array;
  paragraphs: ParagraphContext[];
  fontBytes: Uint8Array;
  /**
   * Call `doc.subsetFonts()` before saving (default true). MuPDF 1.28.1 re-subsets all fonts in the document and rounds the original simple fonts'
   * /Widths to integers and sets unused glyphs to 0 (measured). false in the control run that isolates that effect.
   */
  subsetFonts?: boolean;
  onPhase?: (phase: string) => void;
}

export function runCorpusEdit(input: CorpusEditInput): CorpusEditResult {
  const phase = input.onPhase ?? (() => {});
  return captureMupdfLog((messages) => {
    const t0 = performance.now();
    const doc = openPdf(input.bytes);
    const openMs = performance.now() - t0;
    const afterOpen = doc.canBeSavedIncrementally();
    phase('open');

    // Render of unedited pages (first and last) as the reference
    const edited = new Set(input.paragraphs.map((p) => p.pageIndex));
    const others = [0, doc.countPages() - 1].filter(
      (p, i, a) => !edited.has(p) && a.indexOf(p) === i,
    );
    const otherBefore = new Map<number, Raster>();
    for (const p of others) {
      const page = doc.loadPage(p);
      otherBefore.set(p, renderPage(page, renderScale(page.getBounds() as Rect)));
      page.destroy();
    }

    let embedded: EmbeddedFont | null = null;
    let resourceName: string | null = null;
    const results: ParagraphResult[] = [];
    const states: {
      before: Raster;
      preSave: Raster | null;
      scale: number;
      exclusionPx: Rect;
      neighborLines: string[];
      targetLines: string[];
      /** Original paragraph text and pre-edit page text, with whitespace removed */
      target: string;
      beforeText: string;
      text: string;
    }[] = [];

    input.paragraphs.forEach((para, index) => {
      const k = index + 1;
      let page = doc.loadPage(para.pageIndex);
      const bounds = [...page.getBounds()] as Rect;
      const scale = renderScale(bounds);
      const blocks = readTextBlocks(page);
      const targetLines = meaningful(para.lines.map((l) => l.text));
      const neighborLines = meaningful(
        blocks
          .filter((_b, i) => !para.memberBlocks.includes(i))
          .flatMap((b) => b.lines.map(lineText)),
      );
      const before = renderPage(page, scale);
      const target = squash(para.lines.map((l) => l.text).join(''));
      const beforeText = squash(pageText(page));
      const impact = assessRedactionImpact(doc, para.pageIndex, [para.rect]);
      const restrictions = judgeRestrictions(para);
      if (impact.preexisting.length)
        restrictions.push({
          code: 'existing-redact',
          level: 'warn',
          detail: impact.messages.find((m) => m.includes('Redact')) ?? '',
        });
      if (impact.linksRemoved.length)
        restrictions.push({
          code: 'link-removed',
          level: 'warn',
          detail: `편집 영역 링크 ${impact.linksRemoved.length}개 제거`,
        });

      // Placement area: so the first baseline equals the original paragraph's first baseline (ascent 0.88), and the line count equals the original paragraph's
      const b1 = para.lines[0]!.baseline;
      const bL = para.lines.at(-1)!.baseline;
      const x0 = Math.min(...para.lines.map((l) => l.x0));
      const x1 = Math.max(...para.lines.map((l) => l.x1));
      const boxFz: Rect = [x0, b1 - 0.88 * para.fontSize, x1, bL + 0.3 * para.fontSize];
      const exclusion: Rect = (() => {
        const u = unionRect(para.rect, boxFz);
        return [u[0] - 1, u[1] - 1, u[2] + 1, u[3] + 1];
      })();
      const exclusionPx = pixelRect(exclusion, bounds, scale);
      const result: ParagraphResult = {
        index: k,
        pageIndex: para.pageIndex,
        rect: para.rect,
        lineCount: para.lines.length,
        charCount: para.charCount,
        fontSize: para.fontSize,
        linePitch: para.linePitch,
        fonts: para.fonts,
        hangulRatio: para.hangulRatio,
        restrictions,
        redaction: {
          ok: false,
          error: null,
          ms: 0,
          targetLinesTotal: targetLines.length,
          targetLinesRemaining: targetLines.length,
          neighborLinesTotal: neighborLines.length,
          neighborLinesLost: 0,
          outsidePx: -1,
          outsideStrongPx: -1,
          outsideMaxDelta: -1,
          outsideBbox: null,
        },
        layout: null,
        preSave: null,
        reopen: null,
        exclusion,
        pageBounds: bounds,
        searchTerms: [],
        failures: [],
      };
      results.push(result);
      states.push({
        before,
        preSave: null,
        scale,
        exclusionPx,
        neighborLines,
        targetLines,
        target,
        beforeText,
        text: '',
      });

      // 1. redaction (text only)
      try {
        const tr = performance.now();
        redactRegions(page, [para.rect]);
        result.redaction.ms = performance.now() - tr;
        result.redaction.ok = true;
      } catch (e) {
        result.redaction.error = String(e);
        result.failures.push('redaction-exception');
        return;
      }
      page = doc.loadPage(para.pageIndex);
      const redacted = renderPage(page, scale);
      const textAfter = squash(pageText(page));
      result.redaction.targetLinesRemaining = targetRemaining(
        targetLines,
        target,
        beforeText,
        textAfter,
      );
      result.redaction.neighborLinesLost = neighborsLost(
        neighborLines,
        target,
        beforeText,
        textAfter,
      );
      const outside = diffRasters(before, redacted, exclusionPx);
      const outsideStats = diffStats(before, redacted, exclusionPx);
      result.redaction.outsidePx = outside.differing;
      result.redaction.outsideStrongPx = outsideStats.strong;
      result.redaction.outsideMaxDelta = outsideStats.maxDelta;
      result.redaction.outsideBbox = outside.bbox;
      phase(`redact:${k}`);

      // 2. fallback font (once per document) + placement
      embedded ??= embedFont(doc, 'NotoSansKR', input.fontBytes);
      const box = toPdfRect(page, boxFz);
      // Serialization (Tf·Tm) rounds to three decimal places, so the reference render is placed with the same values.
      const fontSize = round3(para.fontSize);
      const fit = fitReplacement(
        embedded.font,
        k,
        fontSize,
        para.linePitch / fontSize,
        box,
        para.lines.length,
      );
      snapLines(fit.layout);
      states[index]!.text = fit.text;
      result.searchTerms = searchTermsFor(k).filter((t) => squash(fit.text).includes(squash(t)));
      result.layout = {
        text: fit.text,
        lineCount: fit.layout.lineCount,
        maxLines: para.lines.length,
        overflow: fit.layout.overflow,
        missing: missingCodepoints(embedded.font, fit.text),
        glyphs: fit.layout.glyphs.length,
      };
      // The reference render compares only content without annotations (excludes the ordering difference where existing annotation appearances are drawn over the new text).
      const reference = renderPage(
        page,
        scale,
        { font: embedded.font, fontSize, glyphs: fit.layout.glyphs },
        { contentsOnly: true },
      );

      // 3. new content stream
      resourceName = addPageFontResource(doc, page, embedded.ref);
      appendPageContent(
        doc,
        page,
        serializeTextBlock({
          fontResource: resourceName,
          fontSize,
          color: [0, 0, 0],
          lines: fit.layout.lines,
        }),
      );
      page = doc.loadPage(para.pageIndex);
      const preSave = renderPage(page, scale);
      states[index]!.preSave = preSave;
      const glyph = diffStats(
        renderPage(page, scale, undefined, { contentsOnly: true }),
        reference,
      );
      result.preSave = {
        vsReferencePx: glyph.differing,
        vsReferenceStrongPx: glyph.strong,
        vsReferenceMaxDelta: glyph.maxDelta,
        referenceInkPx: inkPixels(reference, exclusionPx),
        ...(() => {
          const o = diffStats(before, preSave, exclusionPx);
          return { outsidePx: o.differing, outsideStrongPx: o.strong };
        })(),
      };
      page.destroy();
      phase(`content:${k}`);
    });

    // 4. subset + choose save method + full save
    const changes: ChangeKind[] = ['redaction', 'font-embed', 'content-stream'];
    const beforeSave = doc.canBeSavedIncrementally();
    const save: CorpusEditResult['save'] = {
      ok: false,
      error: null,
      method: null,
      options: null,
      reason: null,
      canBeSavedIncrementally: { afterOpen, beforeSave },
      heap: null,
      subsetMs: 0,
      saveMs: 0,
      bytes: 0,
      wasmHeapAfterSaveBytes: null,
    };
    let savedBytes: Uint8Array | null = null;
    if (embedded !== null) {
      try {
        const ts = performance.now();
        if (input.subsetFonts !== false) doc.subsetFonts();
        save.subsetMs = performance.now() - ts;
        phase('subset-fonts');
        const decision = decideSaveMethod(changes, beforeSave, {
          inputBytes: input.bytes.byteLength,
        });
        save.method = decision.method;
        save.options = decision.options;
        save.reason = decision.reason;
        save.heap = decision.heap ?? null;
        const tv = performance.now();
        const buf = doc.saveToBuffer(decision.options);
        save.saveMs = performance.now() - tv;
        savedBytes = buf.asUint8Array().slice();
        buf.destroy();
        save.ok = true;
        save.bytes = savedBytes.byteLength;
        save.wasmHeapAfterSaveBytes = wasmHeapBytes();
        phase('save');
      } catch (e) {
        save.error = String(e);
        save.wasmHeapAfterSaveBytes = wasmHeapBytes();
        phase('save-failed');
      }
    }
    doc.destroy();

    // 5. reopen verification
    let font: FontObjectInfo | null = null;
    const otherPages: CorpusEditResult['otherPages'] = [];
    if (savedBytes) {
      const re = openPdf(savedBytes);
      results.forEach((r, i) => {
        const s = states[i]!;
        if (!r.redaction.ok || !s.preSave) return;
        const page = re.loadPage(r.pageIndex);
        const text = squash(pageText(page));
        const raster = renderPage(page, s.scale);
        r.reopen = {
          textFound: text.includes(squash(s.text)),
          targetLinesRemaining: targetRemaining(s.targetLines, s.target, s.beforeText, text),
          neighborLinesLost: neighborsLost(s.neighborLines, s.target, s.beforeText, text),
          searchHits: Object.fromEntries(
            r.searchTerms.map((t) => [t, page.search(t, '').length] as const),
          ),
          vsPreSavePx: diffRasters(raster, s.preSave).differing,
          ...(() => {
            const o = diffStats(s.before, raster, s.exclusionPx);
            return { outsidePx: o.differing, outsideStrongPx: o.strong };
          })(),
        };
        if (font === null && resourceName) font = inspectFont(page as mupdf.PDFPage, resourceName);
        page.destroy();
      });
      for (const [p, before] of otherBefore) {
        const page = re.loadPage(p);
        otherPages.push({
          pageIndex: p,
          diffPx: diffRasters(before, renderPage(page, renderScale(page.getBounds() as Rect)))
            .differing,
        });
        page.destroy();
      }
      re.destroy();
      phase('verify:reopen');
    }

    for (const r of results) {
      const f = r.failures;
      if (!r.redaction.ok) continue;
      if (r.redaction.targetLinesRemaining > 0) f.push('target-text-remains');
      if (r.redaction.neighborLinesLost > 0) f.push('neighbor-text-lost');
      // Outside the edit area: only differences above 96 levels fail (differences at the 1/4 px origin quantization level are recorded by the caller as observations)
      if (r.redaction.outsideStrongPx !== 0) f.push('outside-diff-after-redaction');
      if (r.layout?.missing.length) f.push('glyph-missing');
      if (r.preSave && r.preSave.vsReferenceStrongPx !== 0) f.push('glyph-render-mismatch');
      if (r.preSave && r.preSave.outsideStrongPx !== 0) f.push('outside-diff-after-content');
      if (!save.ok) f.push('save-failed');
      if (r.reopen) {
        if (!r.reopen.textFound) f.push('reopen-text-missing');
        if (r.reopen.targetLinesRemaining > 0) f.push('reopen-target-text-remains');
        if (r.reopen.neighborLinesLost > 0) f.push('reopen-neighbor-text-lost');
        if (Object.values(r.reopen.searchHits).some((n) => n < 1)) f.push('reopen-search-miss');
        if (r.reopen.vsPreSavePx !== 0) f.push('reopen-render-changed');
        if (r.reopen.outsideStrongPx !== 0) f.push('reopen-outside-diff');
      }
    }
    return {
      paragraphs: results,
      font,
      otherPages,
      save,
      openMs,
      mupdfMessages: { count: messages.length, sample: messages.slice(0, 8) },
      savedBytes,
    };
  });
}
