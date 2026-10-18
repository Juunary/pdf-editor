import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/**
 * 편집 전부터 문서에 있던 Redact 주석(적용 대기 중인 "가림 표시") 감지·보고와 처리 정책(PLAN.md 3.1).
 *
 * 편집용 redaction 은 새 주석만 주석 단위 `applyRedaction()` 으로 적용하므로(redact.ts) 기존 주석은
 * 적용되지 않고 저장 후에도 표시로 남는다. 페이지 단위 `applyRedactions()` 처럼 페이지의 모든 Redact
 * 주석을 적용하는 동작이 필요할 때만 기존 주석을 임시 분리한다.
 */

export interface RedactAnnotInfo {
  pageIndex: number;
  /** 페이지 `/Annots` 배열 순번 */
  annotIndex: number;
  /** 간접 객체 번호(직접 객체면 0) */
  objectNumber: number;
  /** MuPDF 페이지 좌표(원점 좌상단) */
  rect: Rect;
  quadPointCount: number;
  overlayText: string | null;
  contents: string;
}

export interface RedactAnnotReport {
  total: number;
  /** Redact 주석이 있는 페이지 번호(0부터) */
  pages: number[];
  annots: RedactAnnotInfo[];
}

/** 문서(또는 지정 페이지)의 Redact 주석 수·위치. */
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

/** 주석 /Rect(PDF 좌표) → MuPDF 페이지 좌표. */
function annotRect(annot: mupdf.PDFObject, toFz: mupdf.Matrix): Rect {
  const r = annot.get('Rect');
  const t = mupdf.Rect.transform([0, 1, 2, 3].map((i) => r.get(i).asNumber()) as Rect, toFz);
  return [Math.min(t[0], t[2]), Math.min(t[1], t[3]), Math.max(t[0], t[2]), Math.max(t[1], t[3])];
}

/** 면적이 있는 교차 여부. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export type ImpactLevel = 'none' | 'info' | 'warn';

export interface RedactionImpact {
  pageIndex: number;
  /** 편집 전부터 페이지에 있던 Redact 주석. 편집은 이 주석을 적용하지 않는다 */
  preexisting: RedactAnnotInfo[];
  /** 그중 편집 영역과 겹치는 것: 나중에 적용하면 새 텍스트도 지워진다 */
  overlapping: RedactAnnotInfo[];
  /** 편집 영역과 겹쳐 MuPDF redaction 이 함께 지우는 링크 */
  linksRemoved: { rect: Rect; uri: string }[];
  level: ImpactLevel;
  messages: string[];
}

/**
 * 편집용 redaction 전에 기존 Redact 주석·링크에 미치는 영향을 판정한다(정책 초안, 기본 "경고").
 * - 기존 Redact 주석 있음, 겹침 없음 → info: 적용하지 않고 표시로 남김
 * - 편집 영역과 겹치는 기존 Redact 주석 → warn: 나중에 적용하면 새 텍스트도 지워짐
 * - 편집 영역과 겹치는 링크 → warn: MuPDF redaction 이 링크를 지움(실측 2026-10-18)
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
  /** 분리 전 `/Annots` 순서(간접 객체 번호) */
  order: number[];
  detached: mupdf.PDFObject[];
}

/**
 * 페이지 `/Annots` 에서 Redact 주석을 빼 둔다(임시 분리). 주석 객체 자체는 고치지 않는다.
 *
 * MuPDF 는 열려 있는 페이지 객체를 캐시하고 `/Annots` 변경을 다시 읽지 않는다(실측: 열린 페이지가 있으면
 * 분리 후에도 페이지 단위 redaction 이 분리한 주석을 적용함). 그래서 분리 후 새로 연 페이지에 분리한
 * 주석이 보이면 즉시 되돌리고 예외를 던진다. 호출 전 그 페이지의 `PDFPage` 를 모두 `destroy()` 해야 한다.
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

/** 분리한 Redact 주석을 원래 순서 자리에 되돌린다. 분리 중 새로 생긴 주석은 뒤에 둔다. */
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

/** Redact 주석을 임시 분리한 상태로 fn 을 실행하고 되돌린다(정책 "임시 분리"). */
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
