// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  decideSaveMethod,
  embedFont,
  missingCodepoints,
  redactRegions,
  serializeTextBlock,
  TEXT_REPLACE_REDACTION,
} from '@pdf-editor/pdf-ops';
import type { ChangeKind, Rect, SaveMethod } from '@pdf-editor/shared-types';
import {
  ADJACENT_LINES,
  FOOTER_TEXT,
  TARGET_LINES,
  TARGET_RECT,
  TARGET_TEXT_BOX,
  TITLE_TEXT,
} from './fixture.js';
import { layoutParagraph } from './layout.js';
import { diffRasters, inkPixels, renderPage, type Raster } from './raster.js';

export const REPLACEMENT_TEXT =
  '새 문단: 원본에 없던 한글 문장을 폴백 폰트(Noto Sans KR)로 임베딩했습니다. 저장 후 다시 열어 검색과 복사가 되는지 확인합니다.';
export const SEARCH_TERMS = ['한글', '폴백 폰트', '임베딩', '검색과 복사'];

export interface SpikeInput {
  sampleBytes: Uint8Array;
  /** Page from the sample with only the target paragraph removed. Compared pixel by pixel with the redaction result. */
  expectedBytes: Uint8Array;
  fontBytes: Uint8Array;
  fontName: string;
  renderScale?: number;
  /** Called at each stage boundary (for time·memory measurement). */
  onPhase?: (phase: string) => void;
}

export interface FontObjectInfo {
  resourceName: string;
  subtype: string;
  descendantSubtype: string;
  baseFont: string;
  subsetTagged: boolean;
  fontFileKey: 'FontFile' | 'FontFile2' | 'FontFile3' | null;
  fontFileBytes: number | null;
  hasToUnicode: boolean;
}

export interface SpikeResult {
  canBeSavedIncrementally: { afterOpen: boolean; afterRedaction: boolean; afterContent: boolean };
  redaction: {
    rect: Rect;
    options: typeof TEXT_REPLACE_REDACTION;
    preexistingRedactAnnots: number;
    targetTextBefore: boolean;
    targetTextAfter: boolean;
    /** Whole-page pixel difference between the redaction result and the expected page (no target paragraph) */
    diffVsExpectedPx: number;
    /** Pixel difference outside the target area before and after redaction */
    diffOutsideRectPx: number;
  };
  layout: {
    fontSize: number;
    lineCount: number;
    glyphCount: number;
    overflow: boolean;
    missing: number[];
  };
  preSave: { diffVsReferencePx: number; referenceInkPx: number };
  save: {
    changes: ChangeKind[];
    method: SaveMethod;
    options: string;
    reason: string;
    subsetMs: number;
    saveMs: number;
    bytes: number;
  };
  reopen: {
    textFound: boolean;
    removedTextAbsent: boolean;
    keptTextsPresent: boolean;
    searchHits: Record<string, number>;
    diffVsReferencePx: number;
    renderedInkPx: number;
    font: FontObjectInfo | null;
  };
  mupdfMessages: string[];
  savedBytes: Uint8Array;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const pageText = (page: mupdf.Page) => page.toStructuredText('preserve-whitespace').asText();
const hasText = (text: string, needle: string) => squash(text).includes(squash(needle));

/** Collects MuPDF warnings and errors (subset failures etc. appear only in the log, without exceptions). */
export function captureMupdfLog<T>(fn: (messages: string[]) => T): T {
  const messages: string[] = [];
  mupdf.setLog({
    error: (m) => messages.push(`error: ${m}`),
    warning: (m) => messages.push(`warning: ${m}`),
  });
  try {
    return fn(messages);
  } finally {
    mupdf.setLog(null);
  }
}

/** fz page coordinate rectangle → PDF user space rectangle (y up). */
function toPdfRect(page: mupdf.PDFPage, rect: Rect): Rect {
  const inv = mupdf.Matrix.invert(page.getTransform());
  const r = mupdf.Rect.transform(rect, inv);
  return [r[0], r[1], r[2], r[3]];
}

function pixelRect(rect: Rect, scale: number): Rect {
  return [
    Math.floor(rect[0] * scale) - 2,
    Math.floor(rect[1] * scale) - 2,
    Math.ceil(rect[2] * scale) + 2,
    Math.ceil(rect[3] * scale) + 2,
  ];
}

export function inspectFont(page: mupdf.PDFPage, resourceName: string): FontObjectInfo | null {
  const ref = page.getObject().get('Resources').get('Font').get(resourceName);
  if (ref.isNull()) return null;
  const font = ref.resolve();
  const desc = font.get('DescendantFonts').get(0).resolve();
  const fd = desc.get('FontDescriptor').resolve();
  const key =
    (['FontFile2', 'FontFile3', 'FontFile'] as const).find((k) => !fd.get(k).isNull()) ?? null;
  const baseFont = font.get('BaseFont').isName() ? font.get('BaseFont').asName() : '';
  return {
    resourceName,
    subtype: font.get('Subtype').asName(),
    descendantSubtype: desc.get('Subtype').asName(),
    baseFont,
    subsetTagged: /^[A-Z]{6}\+/.test(baseFont),
    fontFileKey: key,
    fontFileBytes: key ? fd.get(key).readStream().getLength() : null,
    hasToUnicode: !font.get('ToUnicode').isNull(),
  };
}

/**
 * M0 Day 1 spike: hard-coded-coordinate paragraph redaction → fallback font embedding → new content stream →
 * full save → reopen verification.
 */
export function runSpike(input: SpikeInput): SpikeResult {
  const scale = input.renderScale ?? 2;
  const phase = input.onPhase ?? (() => {});
  return captureMupdfLog((mupdfMessages) => {
    // 1. open
    const doc = openPdf(input.sampleBytes);
    let page = doc.loadPage(0);
    const afterOpen = doc.canBeSavedIncrementally();
    const targetText = TARGET_LINES.join(' ');
    phase('open');
    const targetTextBefore = hasText(pageText(page), targetText);
    const original = renderPage(page, scale);
    phase('verify:original-render');

    // 2. remove the target paragraph (text only)
    const red = redactRegions(page, [TARGET_RECT]);
    page = doc.loadPage(0);
    const afterRedaction = doc.canBeSavedIncrementally();
    phase('redact');
    const redacted = renderPage(page, scale);
    const expectedDoc = openPdf(input.expectedBytes);
    const expected = renderPage(expectedDoc.loadPage(0), scale);
    expectedDoc.destroy();
    const diffVsExpected = diffRasters(redacted, expected);
    const diffOutsideRect = diffRasters(original, redacted, pixelRect(TARGET_RECT, scale));
    const targetTextAfter = hasText(pageText(page), targetText);
    phase('verify:redaction');

    // 3. fallback font embedding + placement
    const embedded = embedFont(doc, input.fontName, input.fontBytes);
    phase('embed-font');
    const box = toPdfRect(page, TARGET_TEXT_BOX);
    const fontSize = 11;
    const layout = layoutParagraph({
      font: embedded.font,
      text: REPLACEMENT_TEXT,
      fontSize,
      lineHeight: 1.4,
      ascent: 0.88,
      box,
    });
    const missing = missingCodepoints(embedded.font, REPLACEMENT_TEXT);

    // Reference render: glyphs drawn directly from the font file over the redaction result
    const reference = renderPage(page, scale, {
      font: embedded.font,
      fontSize,
      glyphs: layout.glyphs,
    });
    const textRegion = pixelRect(TARGET_RECT, scale);
    const referenceInk = inkPixels(reference, textRegion);
    phase('layout+reference-render');

    // 4. new content stream
    const resourceName = addPageFontResource(doc, page, embedded.ref);
    appendPageContent(
      doc,
      page,
      serializeTextBlock({
        fontResource: resourceName,
        fontSize,
        color: [0, 0, 0],
        lines: layout.lines,
      }),
    );
    page = doc.loadPage(0);
    const afterContent = doc.canBeSavedIncrementally();
    phase('append-content');
    const preSave = renderPage(page, scale);
    const preSaveDiff = diffRasters(preSave, reference);
    phase('verify:pre-save');

    // 5. subset + choose save method + full save
    const changes: ChangeKind[] = ['redaction', 'font-embed', 'content-stream'];
    const t0 = performance.now();
    doc.subsetFonts();
    const subsetMs = performance.now() - t0;
    phase('subset-fonts');
    const decision = decideSaveMethod(changes, afterContent);
    const t1 = performance.now();
    const buffer = doc.saveToBuffer(decision.options);
    const saveMs = performance.now() - t1;
    const savedBytes = buffer.asUint8Array().slice();
    buffer.destroy();
    phase('save');
    doc.destroy();

    // 6. reopen verification
    const reopened = openPdf(savedBytes);
    const rp = reopened.loadPage(0);
    const text = pageText(rp);
    const searchHits = Object.fromEntries(SEARCH_TERMS.map((t) => [t, rp.search(t, '').length]));
    phase('reopen+extract+search');
    const reopenedRaster = renderPage(rp, scale);
    const reopenResult = {
      textFound: hasText(text, REPLACEMENT_TEXT),
      removedTextAbsent: !TARGET_LINES.some((l) => hasText(text, l)),
      keptTextsPresent: [TITLE_TEXT, ...ADJACENT_LINES, FOOTER_TEXT].every((t) => hasText(text, t)),
      searchHits,
      diffVsReferencePx: diffRasters(reopenedRaster, reference).differing,
      renderedInkPx: inkPixels(reopenedRaster, textRegion),
      font: inspectFont(rp, resourceName),
    };
    reopened.destroy();
    phase('verify:reopen-render');

    return {
      canBeSavedIncrementally: { afterOpen, afterRedaction, afterContent },
      redaction: {
        rect: TARGET_RECT,
        options: TEXT_REPLACE_REDACTION,
        preexistingRedactAnnots: red.preexistingRedactAnnots,
        targetTextBefore,
        targetTextAfter,
        diffVsExpectedPx: diffVsExpected.differing,
        diffOutsideRectPx: diffOutsideRect.differing,
      },
      layout: {
        fontSize,
        lineCount: layout.lineCount,
        glyphCount: layout.glyphs.length,
        overflow: layout.overflow,
        missing,
      },
      preSave: { diffVsReferencePx: preSaveDiff.differing, referenceInkPx: referenceInk },
      save: {
        changes,
        method: decision.method,
        options: decision.options,
        reason: decision.reason,
        subsetMs,
        saveMs,
        bytes: savedBytes.byteLength,
      },
      reopen: reopenResult,
      mupdfMessages: [...mupdfMessages],
      savedBytes,
    };
  });
}

export interface IncrementalControl {
  /**
   * Control 1: try an incremental save right after redaction. If MuPDF does not reject it, check whether the first part of the output (earlier revision) is
   * the same as the original — if so, the removed paragraph remains in the file.
   */
  afterRedaction: {
    canBeSavedIncrementally: boolean;
    ok: boolean;
    error: string | null;
    bytes: number | null;
    prefixIsOriginal: boolean | null;
  };
  /** Control 2: add only an annotation */
  annotationOnly: {
    canBeSavedIncrementally: boolean;
    decided: SaveMethod;
    ok: boolean;
    bytes: number | null;
    appendedBytes: number | null;
  };
}

function tryIncremental(
  doc: mupdf.PDFDocument,
  original: Uint8Array,
): { ok: boolean; error: string | null; bytes: number | null; prefixIsOriginal: boolean | null } {
  try {
    const buf = doc.saveToBuffer('incremental');
    const out = buf.asUint8Array();
    const prefixIsOriginal =
      out.byteLength >= original.byteLength &&
      out.subarray(0, original.byteLength).every((b, i) => b === original[i]);
    const bytes = out.byteLength;
    buf.destroy();
    return { ok: true, error: null, bytes, prefixIsOriginal };
  } catch (e) {
    return { ok: false, error: String(e), bytes: null, prefixIsOriginal: null };
  }
}

export function runIncrementalControls(sampleBytes: Uint8Array): IncrementalControl {
  return captureMupdfLog(() => {
    const a = openPdf(sampleBytes);
    redactRegions(a.loadPage(0), [TARGET_RECT]);
    const aCan = a.canBeSavedIncrementally();
    const aTry = tryIncremental(a, sampleBytes);
    a.destroy();

    const b = openPdf(sampleBytes);
    const annot = b.loadPage(0).createAnnotation('Text');
    annot.setRect([20, 20, 40, 40]);
    annot.setContents('M0 증분 저장 대조');
    annot.update();
    const bCan = b.canBeSavedIncrementally();
    const decided = decideSaveMethod(['annotation'], bCan).method;
    const bTry = tryIncremental(b, sampleBytes);
    b.destroy();
    return {
      afterRedaction: { canBeSavedIncrementally: aCan, ...aTry },
      annotationOnly: {
        canBeSavedIncrementally: bCan,
        decided,
        ok: bTry.ok,
        bytes: bTry.bytes,
        appendedBytes: bTry.bytes === null ? null : bTry.bytes - sampleBytes.byteLength,
      },
    };
  });
}

export type { Raster };
