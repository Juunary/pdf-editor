/**
 * M3 synthetic PDFs and common checks (contract 8.1, 8.3).
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

/** Pages with Helvetica (/F1) and Times (/F2) simple fonts. Resources are merged with spec.resources. */
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

/** Top-left of the page bounds (page space). */
export function pageOrigin(doc: mupdf.PDFDocument, pageIndex: number): [number, number] {
  const page = doc.loadPage(pageIndex);
  try {
    const b = page.getBounds();
    return [b[0], b[1]];
  } finally {
    page.destroy();
  }
}

/** The render difference outside the edit region is 0 in all three engines. */
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

/** Re-extraction order (contract 8.3): prev end < new start, new end < next start (three engines, whitespace-stripped strings). */
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

/** PageModel character index corresponding to needle in the page text (character order). */
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

/** Builds one paragraph from a group of characters (when the test decides the layout input). */
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

/** A copy with ctx.layout replaced by the given paragraphs. */
export function withParagraphs(
  ctx: ParagraphEditContext,
  paragraphs: LayoutParagraph[],
): ParagraphEditContext {
  return { ...ctx, layout: { ...ctx.layout, paragraphs, readingOrder: [] } };
}

/** MuPDF structured text characters and origins. */
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

/** Character origins of a word (consecutive characters). null if absent. */
export function wordOrigins(list: { c: string; x: number; y: number }[], word: string) {
  const s = list.map((x) => x.c).join('');
  const i = s.indexOf(word);
  return i < 0 ? null : list.slice(i, i + word.length);
}

/** Two origin lists are equal (tolerance in pt). */
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

/** Allowed change region (contract 8.3): original paragraph bbox ∪ layout box ∪ region. */
export const allowedOf = (bbox: Rect, contentBox: Rect, area?: Rect): Rect[] =>
  area ? [bbox, contentBox, area] : [bbox, contentBox];

/**
 * 3x3 ruled table content (page 500x300, page-space x 100-400, row boundaries y = rows). The characters of cell (r, c) are "R{r}C{c}",
 * baseline at cell left + 5pt, row top + 14pt. text(r, c) changes the cell text (a string array gives several lines at 12pt spacing).
 */
export function gridTable(
  rows: number[] = [100, 120, 140, 160],
  text: (r: number, c: number) => string | string[] = (r, c) => `R${r}C${c}`,
): string {
  const xs = [100, 200, 300, 400];
  const H = 300;
  const rules: string[] = [];
  for (const y of rows) rules.push(`${xs[0]} ${H - y} m ${xs[3]} ${H - y} l S`);
  for (const x of xs) rules.push(`${x} ${H - rows[0]!} m ${x} ${H - rows[3]!} l S`);
  const cells: string[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const t = text(r, c);
      (Array.isArray(t) ? t : [t]).forEach((line, k) =>
        cells.push(`BT /F1 10 Tf ${xs[c]! + 5} ${H - (rows[r]! + 14 + 12 * k)} Td (${line}) Tj ET`),
      );
    }
  return `0.5 w ${rules.join(' ')} ${cells.join(' ')}`;
}
