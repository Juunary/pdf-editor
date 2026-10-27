// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addPageFontResource,
  appendPageContent,
  assessRedactionImpact,
  decideSaveMethod,
  embedFont,
  listRedactAnnots,
  redactRegions,
  serializeTextBlock,
  TEXT_REPLACE_REDACTION,
  withRedactAnnotsDetached,
  type ImpactLevel,
} from '@pdf-editor/pdf-ops';
import type { ChangeKind, Rect, SaveMethod } from '@pdf-editor/shared-types';
import {
  ADJACENT_LINES,
  FOOTER_TEXT,
  TARGET_LINES,
  TARGET_RECT,
  TARGET_TEXT_BOX,
} from './fixture.js';
import { buildPreexistingRedactPdf, LINK_URI, R1_OVERLAY } from './fixture-redact.js';
import { layoutParagraph } from './layout.js';
import { canonicalDecodedHash, diffObjects, snapshot } from './objdiff.js';
import { diffRasters, renderPage, type Raster } from './raster.js';
import { captureMupdfLog, REPLACEMENT_TEXT } from './spike.js';

export type RedactCase = 'per-annotation' | 'page-level' | 'detach';

const DESCRIPTIONS: Record<RedactCase, string> = {
  'per-annotation': '편집 경로: 새 Redact 주석만 주석 단위 적용 + 한글 문단 추가 + 전체 저장',
  'page-level': '대조: 페이지 단위 applyRedactions(기존 주석까지 적용)',
  detach: '정책 "임시 분리": 기존 Redact 주석을 뺀 상태로 페이지 단위 applyRedactions 후 되돌림',
};

export interface PageState {
  redactAnnots: [number, number];
  links: number;
  notePresent: boolean;
  adjacentTextPresent: boolean;
  targetTextPresent: boolean;
  page2FooterPresent: boolean;
  newTextFound: boolean;
}

export interface RedactCaseResult {
  case: RedactCase;
  description: string;
  reportBefore: { total: number; pages: number[] };
  impact: {
    preexisting: number;
    overlapping: string[];
    linksRemoved: string[];
    level: ImpactLevel;
    messages: string[];
  };
  afterEdit: PageState & {
    /** R1·R2·R3 annotation objects (dictionary strings) unchanged */
    existingObjectsUnchanged: boolean;
    changedObjects: string[];
  };
  render: { page1OutsideTargetPx: number; page2VsOriginalPx: number };
  save: { method: SaveMethod; options: string; saveMs: number; bytes: number };
  reopen: PageState & {
    /** Existing Redact annotations after save: same page, position, and OverlayText */
    reportSame: boolean;
    /** R1·R2·R3 object trees after save (independent of numbers, excluding /P) are identical */
    existingTreesSame: boolean[];
    page1OutsideTargetPx: number;
    page2VsOriginalPx: number;
  };
  mupdfMessages: string[];
  savedBytes: Uint8Array;
}

const squash = (s: string) => s.replace(/\s+/g, '');
const has = (hay: string, needle: string) => squash(hay).includes(squash(needle));

function pageText(doc: mupdf.PDFDocument, p: number): string {
  const page = doc.loadPage(p);
  const t = page.toStructuredText('preserve-whitespace').asText();
  page.destroy();
  return t;
}

function render(doc: mupdf.PDFDocument, p: number): Raster {
  const page = doc.loadPage(p);
  const r = renderPage(page, 2);
  page.destroy();
  return r;
}

function state(doc: mupdf.PDFDocument): PageState {
  const report = listRedactAnnots(doc);
  const page = doc.loadPage(0);
  const links = page.getLinks().length;
  const notePresent = page.getAnnotations().some((a) => a.getType() === 'Text');
  page.destroy();
  const t1 = pageText(doc, 0);
  return {
    redactAnnots: [0, 1].map((p) => report.annots.filter((a) => a.pageIndex === p).length) as [
      number,
      number,
    ],
    links,
    notePresent,
    adjacentTextPresent: ADJACENT_LINES.every((l) => has(t1, l)),
    targetTextPresent: TARGET_LINES.some((l) => has(t1, l)),
    page2FooterPresent: has(pageText(doc, 1), FOOTER_TEXT),
    newTextFound: has(t1, REPLACEMENT_TEXT),
  };
}

const TARGET_PX: Rect = [
  Math.floor(TARGET_RECT[0] * 2) - 2,
  Math.floor(TARGET_RECT[1] * 2) - 2,
  Math.ceil(TARGET_RECT[2] * 2) + 2,
  Math.ceil(TARGET_RECT[3] * 2) + 2,
];

export function runRedactCase(c: RedactCase, fontBytes: Uint8Array): RedactCaseResult {
  return captureMupdfLog((mupdfMessages) => {
    const original = buildPreexistingRedactPdf();
    const before = openPdf(original);
    const doc = openPdf(original);
    const reportBefore = listRedactAnnots(before);
    const existingNums = reportBefore.annots.map((a) => a.objectNumber);
    const labels = new Map<number, string>(existingNums.map((n, i) => [n, `R${i + 1}`]));
    labels.set(before.findPage(0).asIndirect(), 'page1');
    labels.set(before.findPage(1).asIndirect(), 'page2');
    const impact = assessRedactionImpact(doc, 0, [TARGET_RECT]);
    const originalRenders = [render(before, 0), render(before, 1)];

    const changes: ChangeKind[] = ['redaction'];
    if (c === 'per-annotation') {
      let page = doc.loadPage(0);
      redactRegions(page, [TARGET_RECT]);
      page.destroy();
      page = doc.loadPage(0);
      const font = embedFont(doc, 'NotoSansKR', fontBytes);
      const inv = mupdf.Matrix.invert(page.getTransform());
      const box = mupdf.Rect.transform(TARGET_TEXT_BOX, inv);
      const layout = layoutParagraph({
        font: font.font,
        text: REPLACEMENT_TEXT,
        fontSize: 11,
        lineHeight: 1.4,
        ascent: 0.88,
        box: [box[0], box[1], box[2], box[3]],
      });
      const name = addPageFontResource(doc, page, font.ref);
      appendPageContent(
        doc,
        page,
        serializeTextBlock({
          fontResource: name,
          fontSize: 11,
          color: [0, 0, 0],
          lines: layout.lines,
        }),
      );
      page.destroy();
      changes.push('font-embed', 'content-stream');
    } else {
      const apply = () => {
        const page = doc.loadPage(0);
        page.createAnnotation('Redact').setRect(TARGET_RECT);
        const o = TEXT_REPLACE_REDACTION;
        page.applyRedactions(o.blackBoxes, o.imageMethod, o.lineArtMethod, o.textMethod);
        page.destroy();
      };
      if (c === 'detach') withRedactAnnotsDetached(doc, 0, apply);
      else apply();
    }

    const snap = snapshot(doc);
    const existingAfter = existingNums.map((n) => snap.newIndirect(n).resolve().toString());
    snap.destroy();
    const existingBefore = existingNums.map((n) => before.newIndirect(n).resolve().toString());
    const afterEdit = {
      ...state(doc),
      existingObjectsUnchanged: existingAfter.every((s, i) => s === existingBefore[i]),
      changedObjects: diffObjects(before, doc).changed.map((n) => labels.get(n) ?? `obj${n}`),
    };
    const renders = {
      page1OutsideTargetPx: diffRasters(originalRenders[0]!, render(doc, 0), TARGET_PX).differing,
      page2VsOriginalPx: diffRasters(originalRenders[1]!, render(doc, 1)).differing,
    };

    doc.subsetFonts();
    const decision = decideSaveMethod(changes, doc.canBeSavedIncrementally());
    const t0 = performance.now();
    const buf = doc.saveToBuffer(decision.options);
    const saveMs = performance.now() - t0;
    const savedBytes = buf.asUint8Array().slice();
    buf.destroy();

    const reopened = openPdf(savedBytes);
    const reportAfter = listRedactAnnots(reopened);
    const key = (a: (typeof reportBefore.annots)[number]) =>
      JSON.stringify([a.pageIndex, a.rect, a.overlayText, a.contents]);
    const survivors = reportBefore.annots.map((a) =>
      reportAfter.annots.find((b) => key(b) === key(a)),
    );
    const reopen = {
      ...state(reopened),
      reportSame:
        reportAfter.total === reportBefore.total &&
        reportAfter.annots.every((a, i) => key(a) === key(reportBefore.annots[i]!)),
      existingTreesSame: survivors.map(
        (s, i) =>
          s !== undefined &&
          canonicalDecodedHash(reopened.newIndirect(s.objectNumber)) ===
            canonicalDecodedHash(before.newIndirect(existingNums[i]!)),
      ),
      page1OutsideTargetPx: diffRasters(originalRenders[0]!, render(reopened, 0), TARGET_PX)
        .differing,
      page2VsOriginalPx: diffRasters(originalRenders[1]!, render(reopened, 1)).differing,
    };
    const result: RedactCaseResult = {
      case: c,
      description: DESCRIPTIONS[c],
      reportBefore: { total: reportBefore.total, pages: reportBefore.pages },
      impact: {
        preexisting: impact.preexisting.length,
        overlapping: impact.overlapping.map(
          (a) => labels.get(a.objectNumber) ?? String(a.objectNumber),
        ),
        linksRemoved: impact.linksRemoved.map((l) => l.uri),
        level: impact.level,
        messages: impact.messages,
      },
      afterEdit,
      render: renders,
      save: {
        method: decision.method,
        options: decision.options,
        saveMs,
        bytes: savedBytes.byteLength,
      },
      reopen,
      mupdfMessages: [...mupdfMessages],
      savedBytes,
    };
    reopened.destroy();
    doc.destroy();
    before.destroy();
    return result;
  });
}

export const REDACT_CASES: RedactCase[] = ['per-annotation', 'page-level', 'detach'];
export { LINK_URI, R1_OVERLAY };
