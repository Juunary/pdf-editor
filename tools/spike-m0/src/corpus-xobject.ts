// core must be imported before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { openPdf } from '@pdf-editor/core';
import * as mupdf from 'mupdf';
import {
  addFontResource,
  appendFormContent,
  decideSaveMethod,
  embedFont,
  indexXObjectUsages,
  outsideFormBBox,
  parseContentOps,
  redactFormUsage,
  serializeTextBlock,
  type XObjectUsage,
} from '@pdf-editor/pdf-ops';
import type { Rect } from '@pdf-editor/shared-types';
import { renderScale } from './corpus-edit.js';
import { readTextBlocks } from './corpus-select.js';
import { layoutParagraph } from './layout.js';
import { diffRasters, renderPage, type Raster } from './raster.js';
import { captureMupdfLog } from './spike.js';

/**
 * Applies the M0 policy (docs/m0-dod-xobject-redact-save.md section 1, A1-2) to shared Form XObjects in the real corpus:
 * only one usage location of a shared Form that has text is turned into a new instance with `redactFormUsage` (temporary page redaction),
 * its text is erased, and one Korean line is put into the instance. Other usage locations of the same Form (other pages, same page)
 * must not change in render. Each Form runs independently, reopened fresh.
 */

const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const MAX_OTHER_PAGES = 3;

export interface FormEditResult {
  objectNumber: number;
  usages: number;
  pages: number[];
  textShowOps: number;
  /** Whether /BBox was of the form [x0 y0 x1 y1] (x0≤x1, y0≤y1) */
  bboxNormalized: boolean;
  selected: { pageIndex: number; path: string; depth: number; pageBox: Rect };
  /** v1 restrictions (PLAN.md 3.4 L1·L2·L7) and L3 (new text outside BBox) */
  limits: { L1: boolean; L2: boolean; L3: boolean; L7: boolean };
  /** pdf-ops `outsideFormBBox` result for the same line box (to check for misclassification with an unnormalized /BBox) */
  pdfOpsOutsideFormBBox: boolean | null;
  redact: { ok: boolean; error: string | null; ms: number; newForms: number };
  /** Character count inside the selected usage location's box (excluding whitespace): before edit → after redaction */
  charsInBox: { before: number; after: number };
  /** Same for text outside the selected page's box (whitespace removed) */
  outsideTextSame: boolean | null;
  render: {
    /** Selected page after redaction + new text, outside the selected usage location's box */
    selectedPageOutsidePx: number;
    /** Other pages using the same Form (up to 3 pages) */
    otherPages: { pageIndex: number; diffPx: number }[];
  };
  save: { ok: boolean; error: string | null; ms: number; bytes: number };
  reopen: {
    newTextFound: boolean;
    /** Around '공유' in the extracted text when newTextFound is false (for root-cause checking) */
    textAround: string | null;
    searchHits: number;
    selectedPageOutsidePx: number;
    otherPages: { pageIndex: number; diffPx: number }[];
  } | null;
  mupdfMessages: number;
  failures: string[];
}

const squash = (s: string) => s.replace(/\s+/g, '');

function pageBoxFz(page: mupdf.PDFPage, pdfBox: Rect): Rect {
  const r = mupdf.Rect.transform(pdfBox, page.getTransform());
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

function pixelRect(r: Rect, bounds: Rect, s: number): Rect {
  return [
    Math.floor(r[0] * s) - Math.floor(bounds[0] * s) - 2,
    Math.floor(r[1] * s) - Math.floor(bounds[1] * s) - 2,
    Math.ceil(r[2] * s) - Math.floor(bounds[0] * s) + 2,
    Math.ceil(r[3] * s) - Math.floor(bounds[1] * s) + 2,
  ];
}

/** Number of characters inside the box (by character center) and the text outside the box. */
function splitText(page: mupdf.Page, box: Rect): { inside: number; outside: string } {
  let inside = 0;
  let outside = '';
  for (const b of readTextBlocks(page))
    for (const l of b.lines)
      for (const c of l.chars) {
        if (/\s/u.test(c.c)) continue;
        const cx = (c.box[0] + c.box[2]) / 2;
        const cy = (c.box[1] + c.box[3]) / 2;
        if (cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]) inside++;
        else outside += c.c;
      }
  return { inside, outside };
}

const pathKey = (u: XObjectUsage) =>
  u.path.map((s) => `${s.resourceName}#${s.doOrdinal}`).join('>');

/** Top `max` shared Forms with text (ordered by number of text operators). */
export function pickSharedTextForms(
  doc: mupdf.PDFDocument,
  max = 2,
): { objectNumber: number; usages: XObjectUsage[]; textShowOps: number }[] {
  const out: { objectNumber: number; usages: XObjectUsage[]; textShowOps: number }[] = [];
  for (const [num, usages] of indexXObjectUsages(doc)) {
    if (usages.length < 2 || usages[0]!.subtype !== 'Form') continue;
    let textShowOps: number;
    try {
      textShowOps = parseContentOps(
        doc.newIndirect(num).readStream().asUint8Array().slice(),
      ).filter((o) => TEXT_SHOW.has(o.op)).length;
    } catch {
      continue;
    }
    if (textShowOps > 0) out.push({ objectNumber: num, usages, textShowOps });
  }
  return out.sort((a, b) => b.textShowOps - a.textShowOps).slice(0, max);
}

export function runFormUsageEdit(
  bytes: Uint8Array,
  fontBytes: Uint8Array,
  objectNumber: number,
  k: number,
): FormEditResult {
  return captureMupdfLog((messages) => {
    const doc = openPdf(bytes);
    const usages = indexXObjectUsages(doc).get(objectNumber) ?? [];
    const sel = usages[0]!;
    const form = doc.newIndirect(objectNumber);
    const pages = [...new Set(usages.map((u) => u.pageIndex))];
    let textShowOps: number;
    try {
      textShowOps = parseContentOps(form.readStream().asUint8Array().slice()).filter((o) =>
        TEXT_SHOW.has(o.op),
      ).length;
    } catch {
      textShowOps = -1;
    }
    const others = pages.filter((p) => p !== sel.pageIndex).slice(0, MAX_OTHER_PAGES);
    const result: FormEditResult = {
      objectNumber,
      usages: usages.length,
      pages: pages.slice(0, 20),
      textShowOps,
      bboxNormalized: true,
      selected: {
        pageIndex: sel.pageIndex,
        path: pathKey(sel),
        depth: sel.path.length,
        pageBox: sel.pageBox,
      },
      limits: {
        L1: form.get('Resources').isNull(),
        L2: !form.get('StructParents').isNull(),
        L3: false,
        L7: !form.get('OC').isNull(),
      },
      pdfOpsOutsideFormBBox: null,
      redact: { ok: false, error: null, ms: 0, newForms: 0 },
      charsInBox: { before: 0, after: 0 },
      outsideTextSame: null,
      render: { selectedPageOutsidePx: -1, otherPages: [] },
      save: { ok: false, error: null, ms: 0, bytes: 0 },
      reopen: null,
      mupdfMessages: 0,
      failures: [],
    };

    let page = doc.loadPage(sel.pageIndex);
    const bounds = [...page.getBounds()] as Rect;
    const scale = renderScale(bounds);
    const boxFz = pageBoxFz(page, sel.pageBox);
    const boxPx = pixelRect(boxFz, bounds, scale);
    const before = renderPage(page, scale);
    const textBefore = splitText(page, boxFz);
    result.charsInBox.before = textBefore.inside;
    page.destroy();
    const otherBefore = new Map<number, Raster>();
    for (const p of others) {
      const op = doc.loadPage(p);
      otherBefore.set(p, renderPage(op, renderScale([...op.getBounds()] as Rect)));
      op.destroy();
    }

    // 1. Instantiate only the selected usage location + remove all text in the Form BBox (keep line art and images)
    // /BBox may be an unnormalized rectangle (measured: nasa-eo Form [0 792 612 0]).
    const raw = [0, 1, 2, 3].map((i) => form.get('BBox').get(i).asNumber());
    const bbox: Rect = [
      Math.min(raw[0]!, raw[2]!),
      Math.min(raw[1]!, raw[3]!),
      Math.max(raw[0]!, raw[2]!),
      Math.max(raw[1]!, raw[3]!),
    ];
    result.bboxNormalized = raw[0]! <= raw[2]! && raw[1]! <= raw[3]!;
    let edit: ReturnType<typeof redactFormUsage>;
    try {
      const t0 = performance.now();
      edit = redactFormUsage(doc, sel, [bbox]);
      result.redact.ms = performance.now() - t0;
      result.redact.ok = true;
      result.redact.newForms = edit.newForms.length;
    } catch (e) {
      result.redact.error = String(e);
      result.failures.push('redact-form-usage-exception');
      doc.destroy();
      result.mupdfMessages = messages.length;
      return result;
    }
    page = doc.loadPage(sel.pageIndex);
    const textAfter = splitText(page, boxFz);
    result.charsInBox.after = textAfter.inside;
    result.outsideTextSame = squash(textAfter.outside) === squash(textBefore.outside);
    page.destroy();

    // 2. One Korean line in the instance (about 9pt in page space)
    const det = Math.abs(edit.toPage[0] * edit.toPage[3] - edit.toPage[1] * edit.toPage[2]);
    const fontSize = 9 / Math.sqrt(det || 1);
    const embedded = embedFont(doc, 'NotoSansKR', fontBytes);
    const text = `공유 Form 교체 ${k}`;
    const box: Rect = [bbox[0] + fontSize * 0.5, bbox[1], bbox[2], bbox[3] - fontSize * 0.3];
    const layout = layoutParagraph({
      font: embedded.font,
      text,
      fontSize,
      lineHeight: 1.3,
      ascent: 0.88,
      box,
    });
    const line = layout.lines[0];
    const lineBox: Rect = line
      ? [line.x, line.y - 0.25 * fontSize, line.x + 1, line.y + 0.88 * fontSize]
      : box;
    // pdf-ops outsideFormBBox does not normalize /BBox, so here the check uses a normalized bbox.
    result.limits.L3 =
      layout.overflow ||
      lineBox[0] < bbox[0] ||
      lineBox[1] < bbox[1] ||
      lineBox[2] > bbox[2] ||
      lineBox[3] > bbox[3];
    result.pdfOpsOutsideFormBBox = outsideFormBBox(edit.target, lineBox);
    const name = addFontResource(doc, edit.target, embedded.ref);
    appendFormContent(
      edit.target,
      serializeTextBlock({ fontResource: name, fontSize, color: [0, 0, 0], lines: layout.lines }),
    );

    page = doc.loadPage(sel.pageIndex);
    result.render.selectedPageOutsidePx = diffRasters(
      before,
      renderPage(page, scale),
      boxPx,
    ).differing;
    page.destroy();
    for (const [p, r] of otherBefore) {
      const op = doc.loadPage(p);
      result.render.otherPages.push({
        pageIndex: p,
        diffPx: diffRasters(r, renderPage(op, renderScale([...op.getBounds()] as Rect))).differing,
      });
      op.destroy();
    }

    // 3. full save → reopen
    let saved: Uint8Array | null = null;
    try {
      doc.subsetFonts();
      const d = decideSaveMethod(
        ['redaction', 'font-embed', 'content-stream'],
        doc.canBeSavedIncrementally(),
      );
      const t1 = performance.now();
      const buf = doc.saveToBuffer(d.options);
      result.save.ms = performance.now() - t1;
      saved = buf.asUint8Array().slice();
      buf.destroy();
      result.save.ok = true;
      result.save.bytes = saved.byteLength;
    } catch (e) {
      result.save.error = String(e);
      result.failures.push('save-failed');
    }
    doc.destroy();
    if (saved) {
      const re = openPdf(saved);
      const rp = re.loadPage(sel.pageIndex);
      const others2: { pageIndex: number; diffPx: number }[] = [];
      for (const [p, r] of otherBefore) {
        const op = re.loadPage(p);
        others2.push({
          pageIndex: p,
          diffPx: diffRasters(r, renderPage(op, renderScale([...op.getBounds()] as Rect)))
            .differing,
        });
        op.destroy();
      }
      const extracted = rp.toStructuredText('preserve-whitespace').asText();
      const found = squash(extracted).includes(squash(text));
      const at = extracted.indexOf('공유');
      result.reopen = {
        newTextFound: found,
        textAround: found || at < 0 ? null : extracted.slice(Math.max(0, at - 40), at + 60),
        searchHits: rp.search(text, '').length,
        selectedPageOutsidePx: diffRasters(before, renderPage(rp, scale), boxPx).differing,
        otherPages: others2,
      };
      rp.destroy();
      re.destroy();
    }

    const f = result.failures;
    if (result.charsInBox.after > 0 && result.charsInBox.after >= result.charsInBox.before)
      f.push('form-text-not-removed');
    if (result.outsideTextSame === false) f.push('text-outside-usage-changed');
    if (result.render.selectedPageOutsidePx !== 0) f.push('outside-usage-diff');
    if (result.render.otherPages.some((o) => o.diffPx !== 0)) f.push('other-usage-page-diff');
    if (result.reopen) {
      if (!result.reopen.newTextFound) f.push('reopen-text-missing');
      if (result.reopen.searchHits < 1) f.push('reopen-search-miss');
      if (result.reopen.selectedPageOutsidePx !== 0) f.push('reopen-outside-usage-diff');
      if (result.reopen.otherPages.some((o) => o.diffPx !== 0))
        f.push('reopen-other-usage-page-diff');
    }
    result.mupdfMessages = messages.length;
    return result;
  });
}
