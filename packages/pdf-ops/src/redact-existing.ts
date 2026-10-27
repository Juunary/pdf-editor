import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * Detection, reporting and handling policy for Redact annotations that were in the document before editing (pending "redaction marks" awaiting application) (PLAN.md 3.1).
 *
 * Redaction for editing applies only new annotations via per-annotation `applyRedaction()` (redact.ts), so existing annotations are
 * not applied and remain as marks after saving. Existing annotations are temporarily detached only when behavior that applies all
 * Redact annotations on the page is needed, like page-level `applyRedactions()`.
 */

export interface RedactAnnotInfo {
  pageIndex: number;
  /** Index in the page `/Annots` array */
  annotIndex: number;
  /** Indirect object number (0 for a direct object) */
  objectNumber: number;
  /** MuPDF page coordinates (origin at top left) */
  rect: Rect;
  quadPointCount: number;
  overlayText: string | null;
  contents: string;
}

export interface RedactAnnotReport {
  total: number;
  /** Page number (from 0) that has Redact annotations */
  pages: number[];
  annots: RedactAnnotInfo[];
}

/** Count and positions of Redact annotations in the document (or the given pages). */
export function listRedactAnnots(
  doc: mupdf.PDFDocument,
  pageIndices?: readonly number[],
): RedactAnnotReport {
  const indices = pageIndices ?? Array.from({ length: doc.countPages() }, (_, i) => i);
  const annots: RedactAnnotInfo[] = [];
  for (const pageIndex of indices) {
    const pageAnnots = doc.findPage(pageIndex).get('Annots');
    if (!pageAnnots.isArray()) continue;
    const page = doc.loadPage(pageIndex);
    const toFz = page.getTransform();
    page.destroy();
    pageAnnots.resolve().forEach((a, i) => {
      const subtype = a.get('Subtype');
      if (!subtype.isName() || subtype.asName() !== 'Redact') return;
      const overlay = a.get('OverlayText');
      const quads = a.get('QuadPoints');
      const contents = a.get('Contents');
      annots.push({
        pageIndex,
        annotIndex: Number(i),
        objectNumber: a.isIndirect() ? a.asIndirect() : 0,
        rect: annotRect(a, toFz),
        quadPointCount: quads.isArray() ? Math.floor(quads.length / 8) : 0,
        overlayText: overlay.isString() ? overlay.asString() : null,
        contents: contents.isString() ? contents.asString() : '',
      });
    });
  }
  return { total: annots.length, pages: [...new Set(annots.map((a) => a.pageIndex))], annots };
}

/** Annotation /Rect (PDF coordinates) → MuPDF page coordinates. */
function annotRect(annot: mupdf.PDFObject, toFz: mupdf.Matrix): Rect {
  const r = annot.get('Rect');
  const t = mupdf.Rect.transform([0, 1, 2, 3].map((i) => r.get(i).asNumber()) as Rect, toFz);
  return [Math.min(t[0], t[2]), Math.min(t[1], t[3]), Math.max(t[0], t[2]), Math.max(t[1], t[3])];
}

/** Whether they intersect with non-zero area. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export type ImpactLevel = 'none' | 'info' | 'warn';

export interface RedactionImpact {
  pageIndex: number;
  /** Redact annotations on the page from before editing. Editing does not apply these annotations */
  preexisting: RedactAnnotInfo[];
  /** Those overlapping the edit region: applying them later would also erase the new text */
  overlapping: RedactAnnotInfo[];
  /** Links overlapping the edit region that MuPDF redaction also erases */
  linksRemoved: { rect: Rect; uri: string }[];
  level: ImpactLevel;
  messages: string[];
}

/**
 * Classifies the effect on existing Redact annotations and links before redaction for editing (draft policy, default "warn").
 * - Existing Redact annotation, no overlap → info: left as a mark, not applied
 * - Existing Redact annotation overlapping the edit region → warn: applying it later would also erase the new text
 * - Link overlapping the edit region → warn: MuPDF redaction erases the link (measured 2026-10-18)
 */
export function assessRedactionImpact(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  editRects: readonly Rect[],
): RedactionImpact {
  const preexisting = listRedactAnnots(doc, [pageIndex]).annots;
  const hits = (r: Rect) => editRects.some((e) => rectsOverlap(r, e));
  const overlapping = preexisting.filter((a) => hits(a.rect));
  const page = doc.loadPage(pageIndex);
  const linksRemoved = page
    .getLinks()
    .map((l) => ({ rect: [...l.getBounds()] as Rect, uri: l.getURI() }))
    .filter((l) => hits(l.rect));
  page.destroy();
  const messages: string[] = [];
  if (preexisting.length > 0) {
    messages.push(
      `이 페이지에 적용되지 않은 Redact 표시 ${preexisting.length}개가 있습니다. 편집은 이 표시를 적용하지 않으며 저장 후에도 표시로 남습니다.`,
    );
  }
  if (overlapping.length > 0) {
    messages.push(
      `편집 영역이 기존 Redact 표시 ${overlapping.length}개와 겹칩니다. 나중에 그 표시를 적용하면 새 텍스트도 지워집니다.`,
    );
  }
  if (linksRemoved.length > 0) {
    messages.push(`편집 영역의 링크 ${linksRemoved.length}개가 함께 제거됩니다.`);
  }
  const level: ImpactLevel =
    overlapping.length > 0 || linksRemoved.length > 0
      ? 'warn'
      : preexisting.length > 0
        ? 'info'
        : 'none';
  return { pageIndex, preexisting, overlapping, linksRemoved, level, messages };
}

export interface DetachedRedactAnnots {
  pageIndex: number;
  /** `/Annots` order before detaching (indirect object numbers) */
  order: number[];
  detached: mupdf.PDFObject[];
}

/**
 * Takes Redact annotations out of the page `/Annots` (temporary detach). The annotation objects themselves are not modified.
 *
 * MuPDF caches open page objects and does not re-read `/Annots` changes (measured: if an open page exists,
 * page-level redaction still applies the detached annotations after detaching). So if a page newly opened after detaching shows
 * the detached annotation, it is reverted immediately and an exception is thrown. Before calling, every `PDFPage` of that page must be `destroy()`ed.
 */
export function detachRedactAnnots(
  doc: mupdf.PDFDocument,
  pageIndex: number,
): DetachedRedactAnnots {
  const pageObj = doc.findPage(pageIndex);
  const annots = pageObj.get('Annots');
  const result: DetachedRedactAnnots = { pageIndex, order: [], detached: [] };
  if (!annots.isArray()) return result;
  const keep = doc.newArray();
  annots.resolve().forEach((a) => {
    if (!a.isIndirect()) throw new Error('/Annots 원소가 간접 객체가 아님');
    result.order.push(a.asIndirect());
    const subtype = a.get('Subtype');
    if (subtype.isName() && subtype.asName() === 'Redact') result.detached.push(a);
    else keep.push(a);
  });
  if (result.detached.length === 0) return result;
  pageObj.put('Annots', keep);

  const nums = new Set(result.detached.map((a) => a.asIndirect()));
  const page = doc.loadPage(pageIndex);
  const stale = page.getAnnotations().some((a) => nums.has(a.getObject().asIndirect()));
  page.destroy();
  if (stale) {
    reattachRedactAnnots(doc, result);
    throw new Error(
      `${pageIndex + 1}쪽 페이지 객체가 열려 있어 Redact 주석 분리가 반영되지 않음(PDFPage.destroy() 필요)`,
    );
  }
  return result;
}

/** Puts the detached Redact annotations back in their original order. Annotations newly created during detachment go at the end. */
export function reattachRedactAnnots(doc: mupdf.PDFDocument, d: DetachedRedactAnnots): void {
  if (d.detached.length === 0) return;
  const pageObj = doc.findPage(d.pageIndex);
  const current: mupdf.PDFObject[] = [];
  const annots = pageObj.get('Annots');
  if (annots.isArray()) annots.resolve().forEach((a) => void current.push(a));
  const byNum = new Map<number, mupdf.PDFObject>();
  for (const a of [...current, ...d.detached]) if (a.isIndirect()) byNum.set(a.asIndirect(), a);
  const detachedNums = new Set(d.detached.map((a) => a.asIndirect()));
  const currentNums = new Set(current.filter((a) => a.isIndirect()).map((a) => a.asIndirect()));
  const out = doc.newArray();
  const used = new Set<number>();
  for (const num of d.order) {
    if (detachedNums.has(num) || currentNums.has(num)) {
      out.push(byNum.get(num)!);
      used.add(num);
    }
  }
  for (const a of current) if (!a.isIndirect() || !used.has(a.asIndirect())) out.push(a);
  pageObj.put('Annots', out);
}

/** Runs fn with Redact annotations temporarily detached and then restores them (policy "temporary detach"). */
export function withRedactAnnotsDetached<T>(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  fn: () => T,
): T {
  const d = detachRedactAnnots(doc, pageIndex);
  try {
    return fn();
  } finally {
    reattachRedactAnnots(doc, d);
  }
}
