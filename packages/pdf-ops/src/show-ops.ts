/**
 * Spec-width analysis and rewriting of text-showing operations (Tj, TJ, ', ") (docs/m3-contract.md D2, D3).
 *
 * - Analysis: re-reads the operation bytes and gets, per glyph, the code bytes and the horizontal displacement (text space, including Tc, Tw and Th, spec width
 *   `PdfFont.advanceSpec`). `RemoveSkipCode` if it cannot be computed.
 * - Rewriting: builds a TJ in which glyphs to erase become TJ number adjustments of the same displacement and glyphs to keep become hex strings of
 *   the original code bytes (erasing only part of an operation). `'` and `"` keep their preceding effects (`T*`, `Tw`, `Tc`). If the edit block insertion point is inside an operation,
 *   the TJ is split in two at that glyph boundary and the inserted text goes between (D3 rule 2).
 */
import type { RemoveSkipCode, SourceOp } from '@pdf-editor/shared-types';
import { decodeStringToken, parseContentOpsLenient, type Token } from './content-stream.js';
import type { PdfFont } from './pdf-fonts.js';
import { formatNumber } from './text-ops.js';

export interface SkipInfo {
  code: RemoveSkipCode;
  detail: string;
}

export const isSkip = (v: unknown): v is SkipInfo =>
  typeof v === 'object' && v !== null && 'code' in v && 'detail' in v;

/** Operation operands. Same selection as content-interp readOperands: top-level numbers, last string, last array. */
export interface OpParts {
  nums: Token[];
  str: Token | null;
  array: Token[] | null;
}

export function opParts(tokens: readonly Token[]): OpParts {
  const out: OpParts = { nums: [], str: null, array: null };
  let depth = 0;
  let group: Token[] = [];
  let isArray = false;
  for (const t of tokens) {
    if (depth > 0) {
      if (t.kind === 'array-open' || t.kind === 'dict-open') depth++;
      else if (t.kind === 'array-close' || t.kind === 'dict-close') depth--;
      if (depth === 0) {
        if (isArray) out.array = group;
      } else group.push(t);
      continue;
    }
    if (t.kind === 'array-open' || t.kind === 'dict-open') {
      depth = 1;
      group = [];
      isArray = t.kind === 'array-open';
    } else if (t.kind === 'number') out.nums.push(t);
    else if (t.kind === 'string' || t.kind === 'hexstring') out.str = t;
  }
  return out;
}

/** One glyph: code bytes in the string and horizontal displacement (text-space units, including Th). */
export interface ShowGlyph {
  bytes: Uint8Array;
  tx: number;
}

export type ShowItem = { num: number } | { glyph: number };

export interface ShowAnalysis {
  parts: OpParts;
  items: ShowItem[];
  glyphs: ShowGlyph[];
  /** Total displacement of the operation (text space, including TJ numbers). */
  total: number;
  fontSize: number;
  hScale: number;
}

/** Re-reads the operation bytes (only that operation's range). null if another operation is mixed in or on error. */
export function reparseOp(op: SourceOp, opBytes: Uint8Array): OpParts | null {
  const parsed = parseContentOpsLenient(opBytes);
  const parsedOp = parsed.ops[0];
  if (parsed.error || parsed.ops.length !== 1 || parsedOp?.op !== op.op) return null;
  return opParts(parsedOp.operands);
}

/** TJ number (1/1000 text-space units) → horizontal displacement (text space, including Th). */
const numDisplacement = (n: number, size: number, th: number) => (-n / 1000) * size * th;

/** Horizontal displacement → TJ number of the same displacement. */
export const tjNumberFor = (tx: number, size: number, th: number) => (-tx / (size * th)) * 1000;

/** Analyzes an operation by spec widths. opBytes are the bytes of that operation's range. */
export function analyzeShow(
  op: SourceOp,
  opBytes: Uint8Array,
  font: PdfFont,
): ShowAnalysis | SkipInfo {
  const t = op.text;
  if (!t) return { code: 'not-text-show', detail: '텍스트 표시 연산 아님' };
  if (t.fontSize === 0) return { code: 'font-size-zero', detail: 'Tf 크기 0' };
  if (t.horizontalScale === 0) return { code: 'hscale-zero', detail: 'Tz 0' };
  if (font.fallbackReason !== undefined) {
    return {
      code: 'fallback-font',
      detail: `MuPDF 대체 폰트(로드 실패: ${font.fallbackReason})`,
    };
  }
  if (font.wmode === 1) return { code: 'vertical', detail: '세로쓰기' };
  if (font.type3Matrix) return { code: 'type3', detail: 'Type3 폰트' };
  if (font.unresolved.length > 0) {
    return { code: 'width-uncertain', detail: `폰트 폭 불확실: ${font.unresolved.join('; ')}` };
  }
  const parts = reparseOp(op, opBytes);
  if (!parts) return { code: 'reread-failed', detail: '연산 바이트를 다시 읽지 못함' };
  if (op.op === '"' && parts.nums.length < 2) {
    return { code: 'quote-operands', detail: '" 피연산자 부족' };
  }
  const tokens: (Token | number)[] = [];
  if (op.op === 'TJ') {
    for (const tok of parts.array ?? []) {
      if (tok.kind === 'string' || tok.kind === 'hexstring') tokens.push(tok);
      else if (tok.kind === 'number') tokens.push(tok.value as number);
      // MuPDF executes Tw and Tc keywords inside the array, but they are outside the spec so viewers differ.
      else return { code: 'tj-bad-token', detail: 'TJ 배열에 문자열·숫자 밖 토큰' };
    }
  } else if (parts.str) tokens.push(parts.str);
  const size = t.fontSize;
  const th = t.horizontalScale;
  const items: ShowItem[] = [];
  const glyphs: ShowGlyph[] = [];
  let total = 0;
  for (const tok of tokens) {
    if (typeof tok === 'number') {
      items.push({ num: tok });
      total += numDisplacement(tok, size, th);
      continue;
    }
    const s = decodeStringToken(opBytes, tok);
    for (const c of font.decode(s.data)) {
      const cid = font.cid(c.code);
      // MuPDF does not advance, while viewers that draw per the spec advance by the CID 0 width.
      if (cid < 0) {
        return { code: 'cid-unmapped', detail: 'CID 매핑 없는 코드(뷰어마다 전진량이 다름)' };
      }
      // Tw applies only to 1-byte code 32 (common to MuPDF and the spec, regardless of font type).
      const ws = c.length === 1 && c.code === 32 ? t.wordSpacing : 0;
      const tx = ((font.advanceSpec(cid) / 1000) * size + t.charSpacing + ws) * th;
      items.push({ glyph: glyphs.length });
      glyphs.push({ bytes: s.data.slice(c.offset, c.offset + c.length), tx });
      total += tx;
    }
  }
  if (glyphs.length !== t.glyphs.length) {
    return {
      code: 'glyph-count-mismatch',
      detail: `글리프 수 불일치(SourceMap ${t.glyphs.length}, 다시 읽기 ${glyphs.length})`,
    };
  }
  return { parts, items, glyphs, total, fontSize: size, hScale: th };
}

/** Displacement up to glyph [0, end) (including the TJ numbers before it, and the number before the end glyph). */
export function displacementBefore(a: ShowAnalysis, end: number): number {
  let d = 0;
  for (const item of a.items) {
    if ('num' in item) d += numDisplacement(item.num, a.fontSize, a.hScale);
    else if (item.glyph >= end) break;
    else d += a.glyphs[item.glyph]!.tx;
  }
  return d;
}

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

const srcText = (bytes: Uint8Array, tok: Token) =>
  String.fromCharCode(...bytes.subarray(tok.start, tok.end));

/** Preceding effects of `'` and `"` (T*, Tw, Tc). Empty string for Tj and TJ. */
function prefixOf(op: SourceOp, opBytes: Uint8Array, parts: OpParts): string {
  if (op.op === "'") return 'T* ';
  if (op.op === '"') {
    const [aw, ac] = parts.nums;
    return `${srcText(opBytes, aw!)} Tw ${srcText(opBytes, ac!)} Tc T* `;
  }
  return '';
}

/**
 * The text with the operation rewritten. Glyphs with remove[i] true become numbers of the same displacement. If split is present, the TJ ends right before that glyph,
 * split.insert is placed, then the rest of the TJ continues (there must be a glyph to keep before split.glyph).
 */
export function rewriteShow(
  op: SourceOp,
  opBytes: Uint8Array,
  a: ShowAnalysis,
  remove: readonly boolean[],
  split: { glyph: number; insert: string } | null = null,
): string {
  const arrays: string[][] = [[]];
  let pending = 0;
  let run: number[] = [];
  const cur = () => arrays[arrays.length - 1]!;
  const flushRun = () => {
    if (run.length === 0) return;
    cur().push(`<${run.map((g) => hex(a.glyphs[g]!.bytes)).join('')}>`);
    run = [];
  };
  const flushNum = () => {
    if (pending === 0) return;
    const s = formatNumber(pending);
    if (s !== '0') cur().push(s);
    pending = 0;
  };
  for (const item of a.items) {
    if ('num' in item) {
      flushRun();
      pending += item.num;
      continue;
    }
    const g = item.glyph;
    if (split && g === split.glyph) {
      flushRun();
      flushNum();
      arrays.push([]);
    }
    if (remove[g]) {
      flushRun();
      pending += tjNumberFor(a.glyphs[g]!.tx, a.fontSize, a.hScale);
    } else {
      flushNum();
      run.push(g);
    }
  }
  flushRun();
  flushNum();
  const tj = (items: string[]) => `[${items.join(' ')}] TJ`;
  const prefix = prefixOf(op, opBytes, a.parts);
  if (!split) return `${prefix}${tj(arrays[0]!)}`;
  const [first, second] = arrays as [string[], string[]];
  return `${prefix}${tj(first)} ${split.insert}${second.length > 0 ? ` ${tj(second)}` : ''}`;
}
