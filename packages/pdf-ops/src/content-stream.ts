/**
 * 콘텐츠 스트림 토크나이저(PDF 32000-1 7.2, 8.9.7). M1 인터프리터(PLAN.md 3.4 SourceMap)의 최소 기반.
 * 현재 범위: 연산자 단위 분리와 바이트 범위, 피연산자 값(숫자·이름), 인라인 이미지 건너뛰기.
 * 그래픽 상태 추적은 호출자(xobject.ts)가 한다.
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

/** 인라인 이미지 데이터 끝(EI 다음 위치). `from` = ID 직후 위치. */
function skipInlineImage(bytes: Uint8Array, from: number): number {
  // ID 뒤 공백 1바이트, 이후 "공백 EI 공백|끝" 을 찾는다(데이터 안의 우연한 EI 는 완전히 배제하지 못한다).
  const n = bytes.length;
  for (let i = from + 1; i + 1 < n; i++) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      isWhite(bytes[i - 1]!) &&
      (i + 2 >= n || isWhite(bytes[i + 2]!) || isDelim(bytes[i + 2]!))
    ) {
      return i + 2;
    }
  }
  throw new Error(`인라인 이미지 EI 없음: ${from}`);
}

/** 콘텐츠 스트림(디코드된 바이트)을 연산자 단위로 나눈다. */
export function parseContentOps(bytes: Uint8Array): ContentOp[] {
  const ops: ContentOp[] = [];
  let operands: Token[] = [];
  let depth = 0;
  let pos = 0;
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
      let id: Token | null;
      for (;;) {
        id = nextToken(bytes, pos);
        if (!id) throw new Error(`인라인 이미지 ID 없음: ${t.start}`);
        pos = id.end;
        if (id.kind === 'keyword' && id.value === 'ID') break;
      }
      pos = skipInlineImage(bytes, id.end);
      ops.push({ op: 'BI', operands: [], start, end: pos });
    } else {
      ops.push({ op: t.value as string, operands, start, end: t.end });
    }
    operands = [];
  }
  return ops;
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
