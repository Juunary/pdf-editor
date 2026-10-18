// core 를 mupdf 보다 먼저 import 해야 WASM 힙 측정 객체가 연결된다(packages/core/src/wasm-module.ts).
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
 * 실제 코퍼스의 공유 Form XObject 에 M0 정책(docs/m0-dod-xobject-redact-save.md 1절, A1-2)을 적용한다:
 * 텍스트가 있는 공유 Form 의 사용 위치 1곳만 `redactFormUsage`(임시 페이지 redaction)로 새 인스턴스로
 * 바꿔 그 안의 텍스트를 지우고, 인스턴스에 한글 한 줄을 넣는다. 같은 Form 의 다른 사용 위치(다른 쪽·같은 쪽)는
 * 렌더가 바뀌지 않아야 한다. Form 마다 새로 열어 독립 실행한다.
 */

const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);
const MAX_OTHER_PAGES = 3;

export interface FormEditResult {
  objectNumber: number;
  usages: number;
  pages: number[];
  textShowOps: number;
  /** /BBox 가 [x0 y0 x1 y1](x0≤x1, y0≤y1) 형태였는지 */
  bboxNormalized: boolean;
  selected: { pageIndex: number; path: string; depth: number; pageBox: Rect };
  /** v1 제한 조건(PLAN.md 3.4 L1·L2·L7)과 L3(새 텍스트가 BBox 밖) */
  limits: { L1: boolean; L2: boolean; L3: boolean; L7: boolean };
  /** 같은 줄 상자에 대한 pdf-ops `outsideFormBBox` 결과(정규화 안 된 /BBox 에서 오판 여부 확인용) */
  pdfOpsOutsideFormBBox: boolean | null;
  redact: { ok: boolean; error: string | null; ms: number; newForms: number };
  /** 선택 사용 위치 박스 안 글자 수(공백 제외): 편집 전 → redaction 후 */
  charsInBox: { before: number; after: number };
  /** 선택 쪽 박스 밖 텍스트(공백 제거) 동일 */
  outsideTextSame: boolean | null;
  render: {
    /** redaction + 새 텍스트 후 선택 쪽, 선택 사용 위치 박스 밖 */
    selectedPageOutsidePx: number;
    /** 같은 Form 을 쓰는 다른 쪽(최대 3쪽) */
    otherPages: { pageIndex: number; diffPx: number }[];
  };
  save: { ok: boolean; error: string | null; ms: number; bytes: number };
  reopen: {
    newTextFound: boolean;
    /** newTextFound 가 false 일 때 추출 텍스트에서 '공유' 주변(원인 확인용) */
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

/** 박스 안(글자 중심 기준) 글자 수와 박스 밖 텍스트. */
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

/** 텍스트가 있는 공유 Form 상위 `max` 개(텍스트 연산 수 순). */
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

    // 1. 선택 사용 위치만 인스턴스화 + Form BBox 전체 텍스트 제거(선화·이미지 보존)
    // /BBox 는 정규화되지 않은 사각형일 수 있다(실측: nasa-eo Form [0 792 612 0]).
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

    // 2. 인스턴스에 한글 한 줄(쪽 공간 약 9pt)
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
    // pdf-ops outsideFormBBox 는 /BBox 를 정규화하지 않으므로 여기서는 정규화한 bbox 로 판정한다.
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

    // 3. 전체 저장 → 재열기
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
