/**
 * Common helpers for paragraph editing (M3): matrices and rectangles, resource chain, stream byte cache, number formatting.
 * The matrix convention is the same as content-interp.ts (point p' = p × M, concat(a, b) = a then b).
 */
import type * as mupdf from 'mupdf';
import type { FormStep, Matrix, Point, Rect, SourceOp } from '@pdf-editor/shared-types';
import { readStreamBytes } from './mupdf-util.js';

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

/** Applies only the linear part (direction vector). */
export function applyLinear(m: Matrix, x: number, y: number): Point {
  return [x * m[0] + y * m[2], x * m[1] + y * m[3]];
}

export const determinant = (m: Matrix) => m[0] * m[3] - m[1] * m[2];

/** Inverse matrix. null if singular. */
export function invert(m: Matrix): Matrix | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const r = 1 / det;
  const a = m[3] * r;
  const b = -m[1] * r;
  const c = -m[2] * r;
  const d = m[0] * r;
  return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d];
}

export function preTranslate(m: Matrix, tx: number, ty: number): Matrix {
  return [m[0], m[1], m[2], m[3], tx * m[0] + ty * m[2] + m[4], tx * m[1] + ty * m[3] + m[5]];
}

export function transformRect(r: Rect, m: Matrix): Rect {
  const pts = [
    apply(m, r[0], r[1]),
    apply(m, r[2], r[1]),
    apply(m, r[0], r[3]),
    apply(m, r[2], r[3]),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Intersection. A zero-area rectangle if they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect {
  const r: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  if (r[2] < r[0]) r[2] = r[0];
  if (r[3] < r[1]) r[3] = r[1];
  return r;
}

export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return [...b];
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Overlap with non-zero area. */
export const overlaps = (a: Rect, b: Rect) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** 9 significant digits (no exponent notation). Contract D3 `<Tlm>`. */
export function fmt9(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0';
  let s = Number(v.toPrecision(9)).toString();
  if (/e/i.test(s)) s = v.toFixed(12);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Round-trip exact notation (shortest decimal, no exponent notation). */
export function fmtExact(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  let s = String(v);
  if (/e/i.test(s)) {
    s =
      Math.abs(v) < 1
        ? v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '')
        : BigInt(Math.round(v)).toString();
  }
  return s === '-0' ? '0' : s;
}

export const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const latin1String = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) {
    s += String.fromCharCode(...b.subarray(i, i + 4096));
  }
  return s;
};

/** Identifying key of a Form usage path (equal for the same Do usage location). 'page' for page content. */
export function formKey(path: readonly FormStep[]): string {
  if (path.length === 0) return 'page';
  return path
    .map(
      (s) =>
        `${s.stream.objectNumber}:${s.stream.contentsIndex ?? 'f'}:${s.nameRange[0]}:${s.objectNumber}`,
    )
    .join('/');
}

/** Stream storage key. The /Contents slot for page content, the object number for a Form. */
export const streamKey = (op: { stream: SourceOp['stream'] }) =>
  op.stream.contentsIndex === null
    ? `f:${op.stream.objectNumber}`
    : `p:${op.stream.contentsIndex}:${op.stream.objectNumber}`;

/** Decoded stream byte cache (used only within a single classification/apply). */
export class StreamCache {
  private readonly cache = new Map<number, Uint8Array>();
  constructor(private readonly doc: mupdf.PDFDocument) {}
  get(num: number): Uint8Array {
    let b = this.cache.get(num);
    if (!b) {
      b = readStreamBytes(this.doc.newIndirect(num));
      this.cache.set(num, b);
    }
    return b;
  }
  opBytes(op: SourceOp): Uint8Array {
    return this.get(op.stream.objectNumber).subarray(op.range[0], op.range[1]);
  }
}

/** Resource chain (innermost first): each /Resources along the Form path, then the page /Resources (including inherited). */
export function resourceChain(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  formPath: readonly FormStep[],
): mupdf.PDFObject[] {
  const chain: mupdf.PDFObject[] = [];
  for (let i = formPath.length - 1; i >= 0; i--) {
    const res = doc.newIndirect(formPath[i]!.objectNumber).get('Resources');
    if (!res.isNull()) chain.push(res);
  }
  const page = doc.findPage(pageIndex).getInheritable('Resources');
  if (!page.isNull()) chain.push(page);
  return chain;
}

/** The first category/name resource in the chain. null if absent. The value is the raw, unresolved object (indirect references kept). */
export function lookupResource(
  chain: readonly mupdf.PDFObject[],
  category: string,
  name: string,
): mupdf.PDFObject | null {
  for (const res of chain) {
    const sub = res.get(category);
    if (sub.isNull()) continue;
    const v = sub.get(name);
    if (!v.isNull()) return v;
  }
  return null;
}

/** Canonical PDF name notation (delimiters, whitespace and # become #xx). */
export function pdfName(name: string): string {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch))
      out += `#${c.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

/** Regular character (not a delimiter or whitespace). */
const isRegular = (c: number | undefined) =>
  c !== undefined && !(c <= 0x20 || '()<>[]{}/%'.includes(String.fromCharCode(c)));

/** Adds whitespace only where needed so replacement text does not stick to adjacent tokens. */
export function padReplacement(
  bytes: Uint8Array,
  start: number,
  end: number,
  text: string,
): string {
  let t = text;
  if (isRegular(bytes[start - 1]) && isRegular(t.charCodeAt(0))) t = ` ${t}`;
  if (isRegular(bytes[end]) && isRegular(t.charCodeAt(t.length - 1))) t = `${t} `;
  return t;
}
