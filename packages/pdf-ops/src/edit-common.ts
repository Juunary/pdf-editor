/**
 * 문단 편집(M3) 공통 도구: 행렬·사각형, 리소스 체인, 스트림 바이트 캐시, 숫자 표기.
 * 행렬 규약은 content-interp.ts 와 같다(점 p' = p × M, concat(a, b) = a 다음 b).
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

/** 선형 부분만 적용(방향 벡터). */
export function applyLinear(m: Matrix, x: number, y: number): Point {
  return [x * m[0] + y * m[2], x * m[1] + y * m[3]];
}

export const determinant = (m: Matrix) => m[0] * m[3] - m[1] * m[2];

/** 역행렬. 특이 행렬이면 null. */
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

/** 교집합. 겹치지 않으면 면적 0 사각형. */
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

/** 면적이 있는 겹침. */
export const overlaps = (a: Rect, b: Rect) =>
  a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** 유효숫자 9자리(지수 표기 없이). 계약 D3 `<Tlm>`. */
export function fmt9(v: number): string {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0';
  let s = Number(v.toPrecision(9)).toString();
  if (/e/i.test(s)) s = v.toFixed(12);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** 왕복 정확 표기(가장 짧은 십진 표기, 지수 표기 없이). */
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

/** Form 사용 경로의 식별 키(같은 Do 사용 위치면 같다). 쪽 콘텐츠면 'page'. */
export function formKey(path: readonly FormStep[]): string {
  if (path.length === 0) return 'page';
  return path
    .map(
      (s) =>
        `${s.stream.objectNumber}:${s.stream.contentsIndex ?? 'f'}:${s.nameRange[0]}:${s.objectNumber}`,
    )
    .join('/');
}

/** 스트림 저장 키. 쪽 콘텐츠는 /Contents 칸, Form 은 객체 번호. */
export const streamKey = (op: { stream: SourceOp['stream'] }) =>
  op.stream.contentsIndex === null
    ? `f:${op.stream.objectNumber}`
    : `p:${op.stream.contentsIndex}:${op.stream.objectNumber}`;

/** 스트림 디코드 바이트 캐시(한 번의 판정·적용 안에서만 쓴다). */
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

/** 리소스 체인(안쪽 먼저): Form 경로의 각 /Resources, 그다음 쪽 /Resources(상속 포함). */
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

/** 체인에서 category/name 리소스(첫 번째). 없으면 null. 값은 해석하지 않은 원 객체(간접 참조 유지). */
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

/** 정규 PDF 이름 표기(구분 문자·공백·# 는 #xx). */
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

/** 일반 문자(구분 문자·공백 아님). */
const isRegular = (c: number | undefined) =>
  c !== undefined && !(c <= 0x20 || '()<>[]{}/%'.includes(String.fromCharCode(c)));

/** 교체 텍스트가 앞뒤 토큰과 붙지 않게 필요한 곳에만 공백을 붙인다. */
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
