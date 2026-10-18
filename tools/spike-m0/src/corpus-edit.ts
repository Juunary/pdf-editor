// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(packages/core/src/wasm-module.ts).
import { openPdf, wasmHeapBytes } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  assessRedactionImpact,
  decideSaveMethod,
  embedFont,
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
 * 코퍼스 문서 문단 교체(Day 1 스파이크 절차의 일반화, docs/m0-corpus-recheck.md 2절).
 * 선택 문단마다 redaction(텍스트 제거, 선화·이미지 보존) → 한글 폴백 폰트 임베딩 → 새 콘텐츠 스트림,
 * 문서당 한 번 전체 저장 → 재열기 검증. 좌표는 MuPDF 페이지 좌표(원점 좌상단).
 */

const REPLACEMENT_POOL = [
  '원본 문단을 지우고 한글 폴백 폰트로 다시 썼습니다.',
  '주변의 선과 배경, 인접 문단은 그대로 남아야 합니다.',
  '저장 후 다시 열어 검색과 복사가 되는지 확인합니다.',
  '다람쥐 헌 쳇바퀴에 타고파.',
];

export const replacementPrefix = (k: number) => `교체 문단 ${k}:`;
/** 재열기 검색어. 배치된 텍스트에 실제로 들어간 것만 판정한다. */
export const searchTermsFor = (k: number) => [`교체 문단 ${k}`, '폴백 폰트로'];

/** 원 문단 줄 수 안에 들어가는 가장 긴 교체 문장(어절 경계)을 고른다. */
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
  /** 문단 쪽의 Form 사용 위치 수(A1-1: 페이지 직접 redaction 시 모두 인스턴스화) */
  formUsagesOnPage: number;
  /** 문단 영역과 겹치는 텍스트 Form 과 제한 조건 */
  textFormsOverlapping: {
    objectNumber: number;
    usages: number;
    depth: number;
    L1NoResources: boolean;
    L2StructParents: boolean;
    L6ParseError: boolean;
    L7OptionalContent: boolean;
  }[];
  /** 문단 쪽 콘텐츠의 MCID 수(태그 PDF 구조 연결) */
  mcidOnPage: number;
  tagged: boolean;
  /** 문단 글꼴 중 문자 매핑 위험(ToUnicode 없는 비표준 인코딩·Type3) */
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
  /** v1 판정: 편집 제한(limit) 또는 경고(warn) */
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
    outsidePx: number;
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
  preSave: { vsReferencePx: number; referenceInkPx: number; outsidePx: number } | null;
  reopen: {
    textFound: boolean;
    targetLinesRemaining: number;
    neighborLinesLost: number;
    searchHits: Record<string, number>;
    vsPreSavePx: number;
    outsidePx: number;
  } | null;
  /** Poppler 판정용(픽셀 변환은 호출자) */
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
const pageText = (page: mupdf.Page) => page.toStructuredText('preserve-whitespace').asText();

const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;

/**
 * 지운 문단 줄이 남은 수. 같은 쪽에 같은 문장이 또 있을 수 있으므로(공유 Form 의 다른 사용 위치 등)
 * 존재 여부가 아니라 등장 횟수가 문단 안 횟수만큼 줄었는지로 판정한다. 텍스트는 공백 제거 기준.
 */
function targetRemaining(lines: string[], target: string, before: string, after: string): number {
  return lines.filter(
    (l) => occurrences(after, l) > occurrences(before, l) - occurrences(target, l),
  ).length;
}

/** 다른 블록 줄 중 등장 횟수가 줄어든(함께 지워진) 수. */
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

/** 페이지 좌표 → 렌더 픽셀 좌표(여유 2px). renderPage 의 픽스맵 원점은 floor(bounds × scale). */
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

/** 문단 정보로 v1 편집 제한·경고 판정(PLAN.md 1.4·3.1·3.3·3.4). */
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

    // 편집하지 않는 쪽(첫 쪽·마지막 쪽) 기준 렌더
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
      /** 공백 제거한 원 문단 텍스트·편집 전 쪽 텍스트 */
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

      // 배치 영역: 첫 기준선이 원 문단 첫 기준선과 같도록(ascent 0.88), 줄 수는 원 문단과 같게
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

      // 1. redaction(텍스트만)
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
      result.redaction.outsidePx = outside.differing;
      result.redaction.outsideBbox = outside.bbox;
      phase(`redact:${k}`);

      // 2. 폴백 폰트(문서당 1회) + 배치
      embedded ??= embedFont(doc, 'NotoSansKR', input.fontBytes);
      const box = toPdfRect(page, boxFz);
      const fit = fitReplacement(
        embedded.font,
        k,
        para.fontSize,
        para.linePitch / para.fontSize,
        box,
        para.lines.length,
      );
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
      // 참조 렌더는 주석을 뺀 콘텐츠만 비교한다(기존 주석 외관이 새 텍스트 위에 그려지는 순서 차이 제외).
      const reference = renderPage(
        page,
        scale,
        { font: embedded.font, fontSize: para.fontSize, glyphs: fit.layout.glyphs },
        { contentsOnly: true },
      );

      // 3. 새 콘텐츠 스트림
      resourceName = addPageFontResource(doc, page, embedded.ref);
      appendPageContent(
        doc,
        page,
        serializeTextBlock({
          fontResource: resourceName,
          fontSize: para.fontSize,
          color: [0, 0, 0],
          lines: fit.layout.lines,
        }),
      );
      page = doc.loadPage(para.pageIndex);
      const preSave = renderPage(page, scale);
      states[index]!.preSave = preSave;
      result.preSave = {
        vsReferencePx: diffRasters(
          renderPage(page, scale, undefined, { contentsOnly: true }),
          reference,
        ).differing,
        referenceInkPx: inkPixels(reference, exclusionPx),
        outsidePx: diffRasters(before, preSave, exclusionPx).differing,
      };
      page.destroy();
      phase(`content:${k}`);
    });

    // 4. 서브셋 + 저장 방식 결정 + 전체 저장
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
        doc.subsetFonts();
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

    // 5. 재열기 검증
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
          outsidePx: diffRasters(s.before, raster, s.exclusionPx).differing,
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
      if (r.redaction.outsidePx !== 0) f.push('outside-diff-after-redaction');
      if (r.layout?.missing.length) f.push('glyph-missing');
      if (r.preSave && r.preSave.vsReferencePx !== 0) f.push('glyph-render-mismatch');
      if (r.preSave && r.preSave.outsidePx !== 0) f.push('outside-diff-after-content');
      if (!save.ok) f.push('save-failed');
      if (r.reopen) {
        if (!r.reopen.textFound) f.push('reopen-text-missing');
        if (r.reopen.targetLinesRemaining > 0) f.push('reopen-target-text-remains');
        if (r.reopen.neighborLinesLost > 0) f.push('reopen-neighbor-text-lost');
        if (Object.values(r.reopen.searchHits).some((n) => n < 1)) f.push('reopen-search-miss');
        if (r.reopen.vsPreSavePx !== 0) f.push('reopen-render-changed');
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
