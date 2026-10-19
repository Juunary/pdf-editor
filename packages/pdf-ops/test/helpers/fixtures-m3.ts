/**
 * M3 합성 PDF 와 공통 검사(계약 8.1·8.3).
 */
import { expect } from 'vitest';
import * as mupdf from 'mupdf';
import type { LayoutParagraph, Rect } from '@pdf-editor/shared-types';
import type { ParagraphEditContext } from '../../src/index.js';
import {
  ENGINES,
  diffOutside,
  pageText,
  popplerAvailable,
  raster,
  squash,
  type Engine,
} from './engines.js';

export const HAS_POPPLER = popplerAvailable();
export const engines = (): Engine[] =>
  HAS_POPPLER ? ENGINES : ENGINES.filter((e) => e !== 'poppler');

export interface DocSpec {
  content: string;
  resources?: Record<string, unknown>;
  mediabox?: [number, number, number, number];
  rotate?: 0 | 90 | 180 | 270;
}

/** Helvetica(/F1)·Times(/F2) 단순 폰트 쪽들. 리소스는 spec.resources 와 합친다. */
export function makeDoc(
  pages: (DocSpec | string)[],
  build?: (
    src: mupdf.PDFDocument,
    fonts: { F1: mupdf.PDFObject; F2: mupdf.PDFObject },
  ) => Record<string, unknown>,
): mupdf.PDFDocument {
  const src = new mupdf.PDFDocument();
  const F1 = src.addSimpleFont(new mupdf.Font('Helvetica'));
  const F2 = src.addSimpleFont(new mupdf.Font('Times-Roman'));
  const extra = build ? build(src, { F1, F2 }) : {};
  for (const p of pages) {
    const spec: DocSpec = typeof p === 'string' ? { content: p } : p;
    const res = { Font: { F1, F2 }, ...extra, ...(spec.resources ?? {}) } as Record<
      string,
      unknown
    >;
    src.insertPage(
      -1,
      src.addPage(spec.mediabox ?? [0, 0, 400, 300], spec.rotate ?? 0, res, spec.content),
    );
  }
  return mupdf.Document.openDocument(
    src.saveToBuffer('').asUint8Array().slice(),
    'application/pdf',
  ) as mupdf.PDFDocument;
}

export const bytesOf = (doc: mupdf.PDFDocument) =>
  doc.saveToBuffer('garbage=yes,compress').asUint8Array().slice();

/** 쪽 경계 왼쪽 위(페이지 공간). */
export function pageOrigin(doc: mupdf.PDFDocument, pageIndex: number): [number, number] {
  const page = doc.loadPage(pageIndex);
  try {
    const b = page.getBounds();
    return [b[0], b[1]];
  } finally {
    page.destroy();
  }
}

/** 편집 영역 밖 렌더 차이가 세 엔진 모두 0 이다. */
export async function expectNoChangeOutside(
  before: Uint8Array,
  after: Uint8Array,
  pageIndex: number,
  allow: readonly Rect[],
  origin: [number, number] = [0, 0],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const e of engines()) {
    const a = await raster(e, before, pageIndex);
    const b = await raster(e, after, pageIndex);
    out[e] = diffOutside(a, b, allow, origin);
  }
  expect(out).toEqual(Object.fromEntries(engines().map((e) => [e, 0])));
  return out;
}

/** 재추출 순서(계약 8.3): prev 끝 < new 처음, new 끝 < next 처음(세 엔진, 공백 제거 문자열). */
export async function expectOrder(
  bytes: Uint8Array,
  pageIndex: number,
  prev: string | null,
  inserted: string,
  next: string | null,
): Promise<void> {
  for (const e of engines()) {
    const t = squash(await pageText(e, bytes, pageIndex));
    const ins = squash(inserted);
    const i = t.indexOf(ins);
    expect(i, `${e}: 새 텍스트 없음 in ${t}`).toBeGreaterThanOrEqual(0);
    if (prev !== null) {
      const p = t.indexOf(squash(prev));
      expect(p, `${e}: 이전 문단`).toBeGreaterThanOrEqual(0);
      expect(p + squash(prev).length, `${e}: 순서(이전) ${t}`).toBeLessThanOrEqual(i);
    }
    if (next !== null) {
      const n = t.indexOf(squash(next), i);
      expect(n, `${e}: 다음 문단이 새 텍스트 뒤에 없음 ${t}`).toBeGreaterThanOrEqual(
        i + ins.length,
      );
    }
  }
}

/** 쪽 텍스트(글자 순)에서 needle 에 해당하는 PageModel 글자 인덱스. */
export function charsOfText(ctx: ParagraphEditContext, needle: string, from = 0): number[] {
  const chars = ctx.model.chars;
  let s = '';
  const at: number[] = [];
  chars.forEach((c, i) => {
    for (let k = 0; k < c.text.length; k++) at.push(i);
    s += c.text;
  });
  const i = s.indexOf(needle, from);
  if (i < 0) throw new Error(`글자 없음: ${needle} in ${s}`);
  return [...new Set(at.slice(i, i + needle.length))];
}

/** 글자 묶음으로 문단 하나를 만든다(레이아웃 입력을 테스트가 정할 때). */
export function paragraphOf(
  ctx: ParagraphEditContext,
  chars: number[],
  id: number,
): LayoutParagraph {
  const m = ctx.model;
  let bbox: Rect | null = null;
  for (const c of chars) {
    const q = m.chars[c]!.quad;
    const r: Rect = [
      Math.min(q[0], q[4]),
      Math.min(q[1], q[3]),
      Math.max(q[2], q[6]),
      Math.max(q[5], q[7]),
    ];
    bbox = bbox
      ? [
          Math.min(bbox[0], r[0]),
          Math.min(bbox[1], r[1]),
          Math.max(bbox[2], r[2]),
          Math.max(bbox[3], r[3]),
        ]
      : r;
  }
  const first = m.chars[chars[0]!]!;
  const font = m.fonts[first.fontId];
  return {
    id,
    bbox: bbox!,
    lines: [...new Set(chars.map((c) => m.chars[c]!.line).filter((l) => l >= 0))],
    chars,
    text: chars.map((c) => m.chars[c]!.text).join(''),
    role: 'body',
    column: 0,
    table: null,
    figure: null,
    lineHeight: null,
    firstLineIndent: 0,
    align: 'left',
    styleRuns: [
      {
        start: 0,
        end: chars.length,
        fontId: first.fontId,
        size: Math.round(first.size * 10) / 10,
        bold: font?.bold ?? false,
        italic: font?.italic ?? false,
        color: first.color,
      },
    ],
    continuesTo: null,
  };
}

/** ctx.layout 을 주어진 문단들로 바꾼 사본. */
export function withParagraphs(
  ctx: ParagraphEditContext,
  paragraphs: LayoutParagraph[],
): ParagraphEditContext {
  return { ...ctx, layout: { ...ctx.layout, paragraphs, readingOrder: [] } };
}

/** MuPDF 구조화 텍스트 글자와 원점. */
export function stextChars(
  doc: mupdf.PDFDocument,
  pageIndex: number,
): { c: string; x: number; y: number }[] {
  const out: { c: string; x: number; y: number }[] = [];
  const page = doc.loadPage(pageIndex);
  const st = page.toStructuredText('preserve-whitespace');
  st.walk({ onChar: (c, origin) => out.push({ c, x: origin[0], y: origin[1] }) });
  st.destroy();
  page.destroy();
  return out;
}

/** 단어(연속 글자)의 글자 원점. 없으면 null. */
export function wordOrigins(list: { c: string; x: number; y: number }[], word: string) {
  const s = list.map((x) => x.c).join('');
  const i = s.indexOf(word);
  return i < 0 ? null : list.slice(i, i + word.length);
}

/** 두 원점 목록이 같다(허용 오차 pt). */
export function expectSameOrigins(
  a: { x: number; y: number }[] | null,
  b: { x: number; y: number }[] | null,
  tol = 1e-3,
): void {
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(b!.length).toBe(a!.length);
  a!.forEach((p, i) => {
    expect(Math.abs(b![i]!.x - p.x), `x[${i}]`).toBeLessThanOrEqual(tol);
    expect(Math.abs(b![i]!.y - p.y), `y[${i}]`).toBeLessThanOrEqual(tol);
  });
}

/** 변경 허용 영역(계약 8.3): 원 문단 bbox ∪ 배치 상자 ∪ 영역. */
export const allowedOf = (bbox: Rect, contentBox: Rect, area?: Rect): Rect[] =>
  area ? [bbox, contentBox, area] : [bbox, contentBox];
