// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addFontResource,
  appendFormContent,
  decideSaveMethod,
  embedFont,
  listXObjectUsages,
  missingCodepoints,
  outsideFormBBox,
  redactFormUsage,
  redactRegions,
  serializeTextBlock,
  type EmbeddedFont,
  type Matrix,
  type XObjectUsage,
} from '@pdf-editor/pdf-ops';
import type { ChangeKind, Rect, SaveMethod } from '@pdf-editor/shared-types';
import {
  BADGE_LINES,
  BADGE_TEXT_BOX,
  BADGE_TEXT_RECT,
  buildSharedXObjectPdf,
  CARD_PARAGRAPH,
  CARD_PARAGRAPH_RECT,
  CARD_TEXT_BOX,
  CARD_TITLE,
  type SharedXObjectVariant,
} from './fixture-xobject.js';
import { layoutParagraph } from './layout.js';
import { canonicalDecodedHash, canonicalHash, diffObjects } from './objdiff.js';
import { diffRasters, inkPixels, renderPage, type Raster, type TextOverlay } from './raster.js';
import { captureMupdfLog } from './spike.js';

export const CARD_REPLACEMENT =
  '공유 Form XObject 의 선택 위치만 복제해 이 문단을 교체했습니다. 다른 위치와 다른 페이지는 원본 그대로입니다.';
export const BADGE_REPLACEMENT = '중첩 Form 교체: 한글 배지';

/** Usage location label: `p{page}:{Do index chain}` → fixture description (fixture-xobject.ts) */
export const USAGE_LABELS: Record<string, string> = {
  'p1:0': 'A',
  'p1:0>0': 'A/Fx2',
  'p1:1': 'B',
  'p1:1>0': 'B/Fx2',
  'p2:0': 'C',
  'p2:0>0': 'C/Fx2',
  'p2:1': 'D',
  'p2:1>0': 'D/Fx2',
  'p2:2': 'E(Fx2 직접)',
};

export type XObjectCase = 'mupdf-page-redaction' | 'depth1' | 'depth2' | 'sequential';

export interface UsageState {
  label: string;
  objectNumber: number;
  original: boolean;
}

export interface XObjectCaseResult {
  case: XObjectCase;
  description: string;
  /** Number of document-wide usage locations per original Form before the edit */
  usageCountsBefore: Record<string, number>;
  /** Rectangle of the selected usage location (page 1 B) Form BBox in page user space */
  selectedPageBox: Rect;
  edits: {
    usage: string;
    originalUsageCount: number;
    newForms: number;
    pageResourceName: string | null;
    redactMs: number;
    layout: { lineCount: number; overflow: boolean; missing: number[]; outsideFormBBox: boolean };
  }[];
  objects: { changed: string[]; added: number };
  /** Changed span of page 1 content (decoded): what remains after removing the common prefix and suffix (up to 160 characters) */
  page1Content: { beforeBytes: number; afterBytes: number; removed: string; inserted: string };
  usagesAfter: UsageState[];
  render: {
    /** Page 1 right after redaction vs expected page (only the target text is missing) */
    afterRemovalVsExpectedPx: number;
    /** Page 1 right after redaction vs original, outside the selected usage location area */
    page1OutsideSelectedPx: number;
    page2VsOriginalPx: number;
    /** Page 1 after adding text vs reference (expected page + direct render from the font file) */
    preSaveVsReferencePx: number | null;
    referenceInkPx: number | null;
  };
  save: {
    method: SaveMethod;
    options: string;
    reason: string;
    canBeSavedIncrementally: boolean;
    subsetMs: number;
    saveMs: number;
    bytes: number;
  };
  reopen: {
    page1VsReferencePx: number | null;
    page1VsExpectedPx: number | null;
    page2VsOriginalPx: number;
    newTextFound: boolean[];
    page1Counts: Record<string, number>;
    page2TextSame: boolean;
    /** Page 2 object tree (independent of numbers) decoded content is identical */
    page2TreeDecodedSame: boolean;
    /** Page 2 object tree is identical down to the raw stream bytes */
    page2TreeRawSame: boolean;
  };
  mupdfMessages: string[];
  savedBytes: Uint8Array;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const pageText = (doc: mupdf.PDFDocument, p: number) =>
  doc.loadPage(p).toStructuredText('preserve-whitespace').asText();
const occurrences = (hay: string, needle: string) => squash(hay).split(squash(needle)).length - 1;

function usageKey(u: XObjectUsage): string {
  return `p${u.pageIndex + 1}:${u.path.map((s) => s.doOrdinal).join('>')}`;
}

function allUsages(doc: mupdf.PDFDocument): XObjectUsage[] {
  const out: XObjectUsage[] = [];
  for (let p = 0; p < doc.countPages(); p++) out.push(...listXObjectUsages(doc, p));
  return out;
}

function findUsage(doc: mupdf.PDFDocument, label: string): XObjectUsage {
  const u = allUsages(doc).find((x) => USAGE_LABELS[usageKey(x)] === label);
  if (!u) throw new Error(`사용 위치 없음: ${label}`);
  return u;
}

function pixelRectOf(page: mupdf.PDFPage, pdfRect: Rect, scale: number): Rect {
  const r = mupdf.Rect.transform(pdfRect, page.getTransform());
  return [
    Math.floor(r[0] * scale) - 2,
    Math.floor(r[1] * scale) - 2,
    Math.ceil(r[2] * scale) + 2,
    Math.ceil(r[3] * scale) + 2,
  ];
}

function renderOf(doc: mupdf.PDFDocument, p: number, scale: number, o?: TextOverlay[]): Raster {
  return renderPage(doc.loadPage(p), scale, o);
}

function objectLabels(doc: mupdf.PDFDocument): Map<number, string> {
  const labels = new Map<number, string>();
  labels.set(doc.getTrailer().get('Root').asIndirect(), 'Catalog');
  labels.set(doc.getTrailer().get('Root').get('Pages').asIndirect(), 'Pages');
  for (let p = 0; p < doc.countPages(); p++) {
    const po = doc.findPage(p);
    labels.set(po.asIndirect(), `page${p + 1}`);
    const c = po.get('Contents');
    if (c.isIndirect()) labels.set(c.asIndirect(), `page${p + 1}.Contents`);
    const r = po.get('Resources');
    if (r.isIndirect()) labels.set(r.asIndirect(), 'Resources(공유)');
  }
  for (const u of allUsages(doc)) {
    if (u.objectNumber && !labels.has(u.objectNumber)) {
      labels.set(u.objectNumber, u.path.at(-1)!.resourceName);
    }
  }
  return labels;
}

function pageContentString(doc: mupdf.PDFDocument, p: number): string {
  const c = doc.findPage(p).get('Contents');
  const parts: string[] = [];
  if (c.isArray()) c.resolve().forEach((x) => void parts.push(x.readStream().asString()));
  else parts.push(c.readStream().asString());
  return parts.join('\n');
}

function changedSpan(a: string, b: string): { removed: string; inserted: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
  return { removed: cut(a.slice(i, a.length - j)), inserted: cut(b.slice(i, b.length - j)) };
}

function countNewForms(doc: mupdf.PDFDocument, from: number): number {
  let n = 0;
  for (let i = from; i < doc.countObjects(); i++) {
    const o = doc.newIndirect(i);
    if (o.isStream() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Form') n++;
  }
  return n;
}

interface PlacedText {
  overlay: TextOverlay;
  layout: { lineCount: number; overflow: boolean; missing: number[]; outsideFormBBox: boolean };
}

/** Attaches a fallback-font paragraph to the target Form (Form space). */
function placeText(
  doc: mupdf.PDFDocument,
  form: mupdf.PDFObject,
  toPage: Matrix,
  font: EmbeddedFont,
  text: string,
  fontSize: number,
  box: Rect,
): PlacedText {
  const layout = layoutParagraph({
    font: font.font,
    text,
    fontSize,
    lineHeight: 1.4,
    ascent: 0.88,
    box,
  });
  const name = addFontResource(doc, form, font.ref);
  appendFormContent(
    form,
    serializeTextBlock({ fontResource: name, fontSize, color: [0, 0, 0], lines: layout.lines }),
  );
  return {
    overlay: { font: font.font, fontSize, glyphs: layout.glyphs, matrix: toPage },
    layout: {
      lineCount: layout.lineCount,
      overflow: layout.overflow,
      missing: missingCodepoints(font.font, text),
      outsideFormBBox: outsideFormBBox(form, box),
    },
  };
}

export interface XObjectSpikeInput {
  fontBytes: Uint8Array;
  renderScale?: number;
}

const CASES: Record<XObjectCase, { description: string; expected: SharedXObjectVariant }> = {
  'mupdf-page-redaction': {
    description: '대조: 1쪽 페이지 redaction(Day 1 경로)으로 B 의 카드 문단 영역 제거',
    expected: 'expected-b-card',
  },
  depth1: { description: '1쪽 B 의 Fx1 문단 교체(선택 위치만 복제)', expected: 'expected-b-card' },
  depth2: {
    description: '1쪽 B 안의 중첩 Fx2 텍스트 교체(상위 체인 복제)',
    expected: 'expected-b-badge',
  },
  sequential: {
    description: 'depth1 후 같은 B 에서 depth2 연속 편집',
    expected: 'expected-b-both',
  },
};

export function runXObjectCase(c: XObjectCase, input: XObjectSpikeInput): XObjectCaseResult {
  const scale = input.renderScale ?? 2;
  const spec = CASES[c];
  return captureMupdfLog((mupdfMessages) => {
    const original = buildSharedXObjectPdf('original');
    const before = openPdf(original);
    const doc = openPdf(original);
    const labelsBefore = objectLabels(before);
    const usagesBefore = allUsages(before);
    const usageCountsBefore: Record<string, number> = {};
    for (const u of usagesBefore) {
      const name = labelsBefore.get(u.objectNumber) ?? String(u.objectNumber);
      usageCountsBefore[name] = (usageCountsBefore[name] ?? 0) + 1;
    }
    const originalRenders = [0, 1].map((p) => renderOf(before, p, scale));
    const expectedDoc = openPdf(buildSharedXObjectPdf(spec.expected));
    const expectedRender = renderOf(expectedDoc, 0, scale);
    const selectedBox = findUsage(before, 'B').pageBox;
    const edits: XObjectCaseResult['edits'] = [];
    const overlays: TextOverlay[] = [];

    let font: EmbeddedFont | null = null;
    const fontOnce = () => (font ??= embedFont(doc, 'NotoSansKR', input.fontBytes));

    let afterRemoval: Raster;
    if (c === 'mupdf-page-redaction') {
      const b = findUsage(doc, 'B');
      const page = doc.loadPage(0);
      const fz = mupdf.Rect.transform(
        mupdf.Rect.transform(CARD_PARAGRAPH_RECT, b.toPage),
        page.getTransform(),
      ) as Rect;
      const t0 = performance.now();
      redactRegions(page, [fz]);
      edits.push({
        usage: 'B(페이지 redaction)',
        originalUsageCount: usagesBefore.filter((u) => u.objectNumber === b.objectNumber).length,
        newForms: countNewForms(doc, before.countObjects()),
        pageResourceName: null,
        redactMs: performance.now() - t0,
        layout: { lineCount: 0, overflow: false, missing: [], outsideFormBBox: false },
      });
      afterRemoval = renderOf(doc, 0, scale);
    } else {
      const steps: { label: string; rect: Rect; text: string; size: number; box: Rect }[] = [];
      if (c === 'depth1' || c === 'sequential') {
        steps.push({
          label: 'B',
          rect: CARD_PARAGRAPH_RECT,
          text: CARD_REPLACEMENT,
          size: 11,
          box: CARD_TEXT_BOX,
        });
      }
      if (c === 'depth2' || c === 'sequential') {
        steps.push({
          label: 'B/Fx2',
          rect: BADGE_TEXT_RECT,
          text: BADGE_REPLACEMENT,
          size: 9,
          box: BADGE_TEXT_BOX,
        });
      }
      const removed: Raster[] = [];
      for (const s of steps) {
        const usage = findUsage(doc, s.label);
        const t0 = performance.now();
        const r = redactFormUsage(doc, usage, [s.rect]);
        const redactMs = performance.now() - t0;
        removed.push(renderOf(doc, 0, scale));
        const placed = placeText(doc, r.target, r.toPage, fontOnce(), s.text, s.size, s.box);
        overlays.push(placed.overlay);
        edits.push({
          usage: s.label,
          originalUsageCount: r.originalUsageCount,
          newForms: r.newForms.length,
          pageResourceName: r.pageResourceName,
          redactMs,
          layout: placed.layout,
        });
      }
      afterRemoval = removed.at(-1)!;
    }

    const changedObjs = diffObjects(before, doc);
    const contentBefore = pageContentString(before, 0);
    const contentAfter = pageContentString(doc, 0);
    const usagesAfter: UsageState[] = allUsages(doc).map((u) => {
      const label = USAGE_LABELS[usageKey(u)] ?? usageKey(u);
      const was = usagesBefore.find((x) => usageKey(x) === usageKey(u));
      return {
        label,
        objectNumber: u.objectNumber,
        original: was?.objectNumber === u.objectNumber,
      };
    });
    const page1Px = pixelRectOf(doc.loadPage(0), selectedBox, scale);
    // Consecutive edits: the render just before the last step contains the earlier step's new text, so compare with an expected render that draws the same overlay.
    const expectedForRemoval =
      c === 'sequential'
        ? renderPage(expectedDoc.loadPage(0), scale, overlays.slice(0, -1))
        : expectedRender;
    const reference = overlays.length ? renderPage(expectedDoc.loadPage(0), scale, overlays) : null;
    const preSave = renderOf(doc, 0, scale);
    const render: XObjectCaseResult['render'] = {
      afterRemovalVsExpectedPx: diffRasters(afterRemoval, expectedForRemoval).differing,
      page1OutsideSelectedPx: diffRasters(originalRenders[0]!, preSave, page1Px).differing,
      page2VsOriginalPx: diffRasters(originalRenders[1]!, renderOf(doc, 1, scale)).differing,
      preSaveVsReferencePx: reference ? diffRasters(preSave, reference).differing : null,
      referenceInkPx: reference ? inkPixels(reference, page1Px) : null,
    };

    const changes: ChangeKind[] =
      c === 'mupdf-page-redaction' ? ['redaction'] : ['redaction', 'font-embed', 'content-stream'];
    const can = doc.canBeSavedIncrementally();
    const t0 = performance.now();
    doc.subsetFonts();
    const subsetMs = performance.now() - t0;
    const decision = decideSaveMethod(changes, can);
    const t1 = performance.now();
    const buf = doc.saveToBuffer(decision.options);
    const saveMs = performance.now() - t1;
    const savedBytes = buf.asUint8Array().slice();
    buf.destroy();

    const reopened = openPdf(savedBytes);
    const t1Text = pageText(reopened, 0);
    const texts =
      c === 'mupdf-page-redaction'
        ? []
        : edits.map((e) => (e.usage === 'B' ? CARD_REPLACEMENT : BADGE_REPLACEMENT));
    const reopenRender = renderOf(reopened, 0, scale);
    const reopen: XObjectCaseResult['reopen'] = {
      page1VsReferencePx: reference ? diffRasters(reopenRender, reference).differing : null,
      page1VsExpectedPx: reference ? null : diffRasters(reopenRender, expectedRender).differing,
      page2VsOriginalPx: diffRasters(originalRenders[1]!, renderOf(reopened, 1, scale)).differing,
      newTextFound: texts.map((t) => occurrences(t1Text, t) === 1),
      page1Counts: {
        [CARD_TITLE]: occurrences(t1Text, CARD_TITLE),
        [CARD_PARAGRAPH[0]!]: occurrences(t1Text, CARD_PARAGRAPH[0]!),
        [BADGE_LINES[0]!]: occurrences(t1Text, BADGE_LINES[0]!),
      },
      page2TextSame: pageText(reopened, 1) === pageText(before, 1),
      page2TreeDecodedSame:
        canonicalDecodedHash(reopened.findPage(1)) === canonicalDecodedHash(before.findPage(1)),
      page2TreeRawSame: canonicalHash(reopened.findPage(1)) === canonicalHash(before.findPage(1)),
    };
    const result: XObjectCaseResult = {
      case: c,
      description: spec.description,
      usageCountsBefore,
      selectedPageBox: selectedBox,
      edits,
      objects: {
        changed: changedObjs.changed.map((n) => labelsBefore.get(n) ?? `obj${n}`),
        added: changedObjs.added,
      },
      page1Content: {
        beforeBytes: contentBefore.length,
        afterBytes: contentAfter.length,
        ...changedSpan(contentBefore, contentAfter),
      },
      usagesAfter,
      render,
      save: {
        method: decision.method,
        options: decision.options,
        reason: decision.reason,
        canBeSavedIncrementally: can,
        subsetMs,
        saveMs,
        bytes: savedBytes.byteLength,
      },
      reopen,
      mupdfMessages: [...mupdfMessages],
      savedBytes,
    };
    reopened.destroy();
    expectedDoc.destroy();
    doc.destroy();
    before.destroy();
    return result;
  });
}

export const XOBJECT_CASES = Object.keys(CASES) as XObjectCase[];
