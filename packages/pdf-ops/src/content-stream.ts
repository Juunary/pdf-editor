/**
 * Content stream tokenizer (PDF 32000-1 7.2, 8.9.7). Foundation of the M1 interpreter (PLAN.md 3.4 SourceMap).
 * Scope: splitting by operator with byte ranges, operand values (numbers, names), string decoding (including original byte positions),
 * and skipping inline images (same EI classification as MuPDF 1.28 parse_inline_image).
 * Graphics state tracking is done by the callers (xobject.ts, content-interp.ts).
 */

export type TokenKind =
  | 'number'
  | 'name'
  | 'string'
  | 'hexstring'
  | 'array-open'
  | 'array-close'
  | 'dict-open'
  | 'dict-close'
  | 'keyword';

export interface Token {
  kind: TokenKind;
  /** Byte range [start, end) */
  start: number;
  end: number;
  /** number: value, name: name decoded after '/', keyword: operator or true/false/null */
  value?: number | string;
}

export interface ContentOp {
  /** Operator keyword. An inline image is 'BI' (one operation through ID … EI). */
  op: string;
  operands: Token[];
  /** From the start of the first operand (or the operator if none) to the end of the operator */
  start: number;
  end: number;
  /** BI only: dictionary tokens between BI and ID (alternating key and value). */
  inlineDict?: Token[];
}

export interface ContentParseError {
  offset: number;
  message: string;
}

export interface ContentParseResult {
  /** Operations split before the error. */
  ops: ContentOp[];
  /** First token split error. Nothing after it is interpreted (L6). */
  error: ContentParseError | null;
}

/** Decoded string bytes and the original position [starts[i], ends[i]) of each byte. */
export interface DecodedString {
  data: Uint8Array;
  starts: Int32Array;
  ends: Int32Array;
}

const isWhite = (c: number) =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
const isDelim = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;
const isRegular = (c: number) => !isWhite(c) && !isDelim(c);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function decodeName(bytes: Uint8Array, start: number, end: number): string {
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    const c = bytes[i]!;
    if (c === 0x23 && i + 2 < end) {
      const h = hexValue(bytes[i + 1]!);
      const l = hexValue(bytes[i + 2]!);
      if (h >= 0 && l >= 0) {
        out.push(h * 16 + l);
        i += 2;
        continue;
      }
    }
    out.push(c);
  }
  return String.fromCharCode(...out);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** Next token. null at the end. */
function nextToken(bytes: Uint8Array, pos: number): Token | null {
  const n = bytes.length;
  let i = pos;
  for (;;) {
    while (i < n && isWhite(bytes[i]!)) i++;
    if (i < n && bytes[i] === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++;
      continue;
    }
    break;
  }
  if (i >= n) return null;
  const start = i;
  const c = bytes[i]!;
  if (c === 0x2f) {
    i++;
    while (i < n && isRegular(bytes[i]!)) i++;
    return { kind: 'name', start, end: i, value: decodeName(bytes, start + 1, i) };
  }
  if (c === 0x28) {
    let depth = 1;
    i++;
    while (i < n && depth > 0) {
      const d = bytes[i]!;
      if (d === 0x5c) i += 2;
      else {
        if (d === 0x28) depth++;
        else if (d === 0x29) depth--;
        i++;
      }
    }
    if (depth > 0) throw new Error(`닫히지 않은 문자열: ${start}`);
    return { kind: 'string', start, end: i };
  }
  if (c === 0x3c) {
    if (bytes[i + 1] === 0x3c) return { kind: 'dict-open', start, end: i + 2 };
    while (i < n && bytes[i] !== 0x3e) i++;
    if (i >= n) throw new Error(`닫히지 않은 16진 문자열: ${start}`);
    return { kind: 'hexstring', start, end: i + 1 };
  }
  if (c === 0x3e) {
    if (bytes[i + 1] === 0x3e) return { kind: 'dict-close', start, end: i + 2 };
    throw new Error(`예상하지 않은 '>': ${start}`);
  }
  if (c === 0x5b) return { kind: 'array-open', start, end: i + 1 };
  if (c === 0x5d) return { kind: 'array-close', start, end: i + 1 };
  if (c === 0x7b || c === 0x7d)
    return { kind: 'keyword', start, end: i + 1, value: ascii(bytes, i, i + 1) };
  if (c === 0x29) throw new Error(`예상하지 않은 ')': ${start}`);
  while (i < n && isRegular(bytes[i]!)) i++;
  const word = ascii(bytes, start, i);
  if (NUMBER.test(word)) return { kind: 'number', start, end: i, value: Number(word) };
  return { kind: 'keyword', start, end: i, value: word };
}

const INLINE_KEYS: Record<string, string> = {
  W: 'Width',
  H: 'Height',
  BPC: 'BitsPerComponent',
  CS: 'ColorSpace',
  F: 'Filter',
  IM: 'ImageMask',
};

/** Inline image dictionary tokens → keys (abbreviations expanded to full names) → value tokens. */
export function inlineImageEntries(dict: readonly Token[]): Map<string, Token[]> {
  const out = new Map<string, Token[]>();
  let key: string | null = null;
  let depth = 0;
  for (const t of dict) {
    if (key === null) {
      if (t.kind === 'name') {
        const k = t.value as string;
        key = INLINE_KEYS[k] ?? k;
        out.set(key, []);
      }
      continue;
    }
    out.get(key)!.push(t);
    if (t.kind === 'array-open' || t.kind === 'dict-open') depth++;
    else if (t.kind === 'array-close' || t.kind === 'dict-close') depth--;
    if (depth === 0) key = null;
  }
  return out;
}

const COMPONENTS: Record<string, number> = {
  G: 1,
  DeviceGray: 1,
  CalGray: 1,
  RGB: 3,
  DeviceRGB: 3,
  CalRGB: 3,
  CMYK: 4,
  DeviceCMYK: 4,
  I: 1,
  Indexed: 1,
};

/** Data length of an inline image without a filter. null if unknown (heuristic search). */
function unfilteredLength(dict: readonly Token[]): number | null {
  const e = inlineImageEntries(dict);
  const filter = e.get('Filter');
  if (filter && filter.some((t) => t.kind === 'name')) return null;
  const num = (k: string) => {
    const t = e.get(k)?.[0];
    return t?.kind === 'number' ? (t.value as number) : null;
  };
  const w = num('Width');
  const h = num('Height');
  const mask = e.get('ImageMask')?.[0]?.value === 'true';
  const bpc = num('BitsPerComponent') ?? (mask ? 1 : null);
  let ncomp: number | null = mask ? 1 : null;
  if (!mask) {
    const cs = e.get('ColorSpace');
    const first = cs?.[0]?.kind === 'array-open' ? cs[1] : cs?.[0];
    if (first?.kind === 'name') ncomp = COMPONENTS[first.value as string] ?? null;
    if (cs?.[0]?.kind === 'array-open' && first?.kind === 'name' && first.value !== 'I') {
      ncomp = first.value === 'Indexed' ? 1 : null;
    }
  }
  if (w === null || h === null || bpc === null || ncomp === null) return null;
  if (w <= 0 || h <= 0) return null;
  return h * Math.ceil((w * ncomp * bpc) / 8);
}

/** End of inline image data (position after EI). `idEnd` = position right after the ID keyword. */
function skipInlineImage(bytes: Uint8Array, idEnd: number, dict: readonly Token[]): number {
  // MuPDF: one whitespace byte after ID (two for CRLF), the data, then look for "EI" + (end | ≤0x20 | '<' | '/').
  // For an image without a filter, the data length is computed and the search starts after it. With a filter the data is not decoded, so
  // to reduce accidental EI inside the data, only an EI preceded by whitespace is accepted (this cannot be excluded completely).
  const n = bytes.length;
  let p = idEnd + (bytes[idEnd] === 0x0d && bytes[idEnd + 1] === 0x0a ? 2 : 1);
  const len = unfilteredLength(dict);
  if (len !== null) p += len;
  for (let i = p; i + 1 < n; i++) {
    if (bytes[i] !== 0x45 || bytes[i + 1] !== 0x49) continue;
    if (len === null && (i === 0 || !isWhite(bytes[i - 1]!))) continue;
    const next = bytes[i + 2];
    if (next === undefined || next <= 0x20 || next === 0x3c || next === 0x2f) return i + 2;
  }
  throw new Error(`인라인 이미지 EI 없음: ${idEnd}`);
}

/** Splits a content stream (decoded bytes) by operator. A token error throws. */
export function parseContentOps(bytes: Uint8Array): ContentOp[] {
  const r = parseContentOpsLenient(bytes);
  if (r.error) throw new Error(r.error.message);
  return r.ops;
}

/** Same as parseContentOps, but on an error returns the operations before it and the error position. */
export function parseContentOpsLenient(bytes: Uint8Array): ContentParseResult {
  const ops: ContentOp[] = [];
  let operands: Token[] = [];
  let depth = 0;
  let pos = 0;
  try {
    for (;;) {
      const t = nextToken(bytes, pos);
      if (!t) break;
      pos = t.end;
      if (t.kind === 'array-open' || t.kind === 'dict-open') depth++;
      if (t.kind === 'array-close' || t.kind === 'dict-close') depth--;
      const isOperator =
        t.kind === 'keyword' &&
        depth === 0 &&
        t.value !== 'true' &&
        t.value !== 'false' &&
        t.value !== 'null';
      if (!isOperator) {
        operands.push(t);
        continue;
      }
      const start = operands[0]?.start ?? t.start;
      if (t.value === 'BI') {
        // BI <key value>* ID <data> EI
        const dict: Token[] = [];
        let id: Token | null;
        for (;;) {
          id = nextToken(bytes, pos);
          if (!id) throw new Error(`인라인 이미지 ID 없음: ${t.start}`);
          pos = id.end;
          if (id.kind === 'keyword' && id.value === 'ID') break;
          dict.push(id);
        }
        pos = skipInlineImage(bytes, id.end, dict);
        ops.push({ op: 'BI', operands: [], start, end: pos, inlineDict: dict });
      } else {
        ops.push({ op: t.value as string, operands, start, end: t.end });
      }
      operands = [];
    }
  } catch (e) {
    return { ops, error: { offset: pos, message: e instanceof Error ? e.message : String(e) } };
  }
  return { ops, error: null };
}

/**
 * Decodes a string token (literal or hex) (rules of MuPDF 1.28 lex_string and lex_hex_string).
 * Literal: escapes (\n \r \t \b \f \( \) \\ \ddd), \+newline is ignored, any other \c is c,
 * an unescaped CR, LF or CRLF is one 0x0a byte. Hex: whitespace ignored, an odd number of digits is padded with 0,
 * non-hex characters are also treated as digits (MuPDF proceeds after a warning).
 */
export function decodeStringToken(bytes: Uint8Array, tok: Token): DecodedString {
  const data: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const push = (v: number, s: number, e: number) => {
    data.push(v & 0xff);
    starts.push(s);
    ends.push(e);
  };
  if (tok.kind === 'hexstring') {
    let hi = -1;
    let hiPos = 0;
    for (let i = tok.start + 1; i < tok.end - 1; i++) {
      const c = bytes[i]!;
      if (isWhite(c)) continue;
      const v = Math.max(0, hexValue(c));
      if (hi < 0) {
        hi = v;
        hiPos = i;
      } else {
        push(hi * 16 + v, hiPos, i + 1);
        hi = -1;
      }
    }
    if (hi >= 0) push(hi * 16, hiPos, hiPos + 1);
  } else if (tok.kind === 'string') {
    const end = tok.end - 1;
    for (let i = tok.start + 1; i < end;) {
      const c = bytes[i]!;
      if (c === 0x5c) {
        const d = bytes[i + 1];
        if (d === undefined || i + 1 >= end) break;
        const simple: Record<number, number> = {
          0x6e: 0x0a,
          0x72: 0x0d,
          0x74: 0x09,
          0x62: 0x08,
          0x66: 0x0c,
          0x28: 0x28,
          0x29: 0x29,
          0x5c: 0x5c,
        };
        if (d in simple) {
          push(simple[d]!, i, i + 2);
          i += 2;
        } else if (d >= 0x30 && d <= 0x37) {
          let v = d - 0x30;
          let j = i + 2;
          for (let k = 0; k < 2 && j < end && bytes[j]! >= 0x30 && bytes[j]! <= 0x37; k++, j++) {
            v = v * 8 + (bytes[j]! - 0x30);
          }
          push(v, i, j);
          i = j;
        } else if (d === 0x0a) {
          i += 2;
        } else if (d === 0x0d) {
          i += bytes[i + 2] === 0x0a && i + 2 < end ? 3 : 2;
        } else {
          push(d, i, i + 2);
          i += 2;
        }
      } else if (c === 0x0d) {
        const crlf = bytes[i + 1] === 0x0a && i + 1 < end;
        push(0x0a, i, i + (crlf ? 2 : 1));
        i += crlf ? 2 : 1;
      } else {
        push(c, i, i + 1);
        i++;
      }
    }
  } else {
    throw new Error(`문자열 토큰 아님: ${tok.kind}`);
  }
  return {
    data: Uint8Array.from(data),
    starts: Int32Array.from(starts),
    ends: Int32Array.from(ends),
  };
}

export function concatBytes(parts: readonly Uint8Array[], separator?: number): Uint8Array {
  const sep = separator === undefined ? 0 : 1;
  const total = parts.reduce((s, p) => s + p.byteLength, 0) + sep * Math.max(0, parts.length - 1);
  const out = new Uint8Array(total);
  let o = 0;
  parts.forEach((p, i) => {
    if (i > 0 && separator !== undefined) out[o++] = separator;
    out.set(p, o);
    o += p.byteLength;
  });
  return out;
}

/** New array with [start, end) of bytes replaced by replacement (Latin-1, for ASCII such as operators and names). */
export function spliceBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
  replacement: string,
): Uint8Array {
  const rep = Uint8Array.from(replacement, (ch) => {
    const c = ch.charCodeAt(0);
    if (c > 0xff) throw new Error(`Latin-1 밖 문자: ${ch}`);
    return c;
  });
  return concatBytes([bytes.subarray(0, start), rep, bytes.subarray(end)]);
}
