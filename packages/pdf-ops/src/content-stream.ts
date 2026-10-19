/**
 * 콘텐츠 스트림 토크나이저(PDF 32000-1 7.2, 8.9.7). M1 인터프리터(PLAN.md 3.4 SourceMap)의 기반.
 * 범위: 연산자 단위 분리와 바이트 범위, 피연산자 값(숫자·이름), 문자열 디코드(원본 바이트 위치 포함),
 * 인라인 이미지 건너뛰기(MuPDF 1.28 parse_inline_image 와 같은 EI 판정).
 * 그래픽 상태 추적은 호출자(xobject.ts, content-interp.ts)가 한다.
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
  /** 바이트 범위 [start, end) */
  start: number;
  end: number;
  /** number: 값, name: '/' 뒤 디코드한 이름, keyword: 연산자·true/false/null */
  value?: number | string;
}

export interface ContentOp {
  /** 연산자 키워드. 인라인 이미지는 'BI'(ID … EI 까지 한 연산). */
  op: string;
  operands: Token[];
  /** 첫 피연산자(없으면 연산자) 시작 ~ 연산자 끝 */
  start: number;
  end: number;
  /** BI 만: BI 와 ID 사이 사전 토큰(키·값 교대). */
  inlineDict?: Token[];
}

export interface ContentParseError {
  offset: number;
  message: string;
}

export interface ContentParseResult {
  /** 오류 전까지 분리한 연산. */
  ops: ContentOp[];
  /** 첫 토큰 분리 오류. 그 뒤는 해석하지 않는다(L6). */
  error: ContentParseError | null;
}

/** 디코드한 문자열 바이트와 각 바이트의 원본 위치 [starts[i], ends[i]). */
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

/** 다음 토큰. 끝이면 null. */
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

/** 인라인 이미지 사전 토큰 → 키(약어는 전체 이름으로) → 값 토큰들. */
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

/** 필터 없는 인라인 이미지의 데이터 길이. 알 수 없으면 null(휴리스틱 탐색). */
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

/** 인라인 이미지 데이터 끝(EI 다음 위치). `idEnd` = ID 키워드 직후 위치. */
function skipInlineImage(bytes: Uint8Array, idEnd: number, dict: readonly Token[]): number {
  // MuPDF: ID 뒤 공백 1바이트(CRLF 는 2바이트), 데이터, 이후 "EI" + (끝|≤0x20|'<'|'/') 를 찾는다.
  // 필터 없는 이미지는 데이터 길이를 계산해 그 뒤부터 찾는다. 필터가 있으면 데이터를 디코드하지 않으므로
  // 데이터 안의 우연한 EI 를 줄이려고 앞에 공백이 있는 EI 만 인정한다(완전히 배제하지는 못한다).
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

/** 콘텐츠 스트림(디코드된 바이트)을 연산자 단위로 나눈다. 토큰 오류는 예외. */
export function parseContentOps(bytes: Uint8Array): ContentOp[] {
  const r = parseContentOpsLenient(bytes);
  if (r.error) throw new Error(r.error.message);
  return r.ops;
}

/** parseContentOps 와 같되, 오류가 나면 그 전까지의 연산과 오류 위치를 돌려준다. */
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
        // BI <키 값>* ID <데이터> EI
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
 * 문자열 토큰(리터럴·16진)을 디코드한다(MuPDF 1.28 lex_string·lex_hex_string 규칙).
 * 리터럴: 이스케이프(\n \r \t \b \f \( \) \\ \ddd), \+줄바꿈은 무시, 그 밖의 \c 는 c,
 * 이스케이프하지 않은 CR·LF·CRLF 는 0x0a 1바이트. 16진: 공백 무시, 홀수 자리는 0 을 덧붙인다,
 * 16진 숫자가 아닌 문자도 숫자로 취급(MuPDF 경고 후 진행).
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

/** bytes 의 [start, end) 를 replacement(Latin-1, 연산자·이름 등 ASCII 용)로 바꾼 새 배열. */
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
