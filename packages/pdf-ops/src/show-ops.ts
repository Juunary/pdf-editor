/**
 * 텍스트 표시 연산(Tj·TJ·'·")의 명세 폭 분석과 다시 쓰기(docs/m3-contract.md D2·D3).
 *
 * - 분석: 연산 바이트를 다시 읽어 글리프마다 코드 바이트와 가로 변위(텍스트 공간, Tc·Tw·Th 포함, 명세 폭
 *   `PdfFont.advanceSpec`)를 구한다. 계산할 수 없으면 `RemoveSkipCode`.
 * - 다시 쓰기: 지울 글리프는 같은 변위의 TJ 숫자 조정으로, 남길 글리프는 원 코드 바이트의 16진 문자열로 바꾼
 *   TJ 를 만든다(연산 일부만 지우기). `'`·`"` 는 앞 효과(`T*`·`Tw`·`Tc`)를 남긴다. 편집 블록 삽입점이 연산 안이면
 *   그 글리프 경계에서 TJ 를 둘로 나누고 사이에 삽입 텍스트를 넣는다(D3 규칙 2).
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

/** 연산 피연산자. content-interp readOperands 와 같은 선택: 최상위 숫자, 마지막 문자열, 마지막 배열. */
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

/** 글리프 1개: 문자열 안 코드 바이트와 가로 변위(텍스트 공간 단위, Th 포함). */
export interface ShowGlyph {
  bytes: Uint8Array;
  tx: number;
}

export type ShowItem = { num: number } | { glyph: number };

export interface ShowAnalysis {
  parts: OpParts;
  items: ShowItem[];
  glyphs: ShowGlyph[];
  /** 연산 전체 변위(텍스트 공간, TJ 숫자 포함). */
  total: number;
  fontSize: number;
  hScale: number;
}

/** 연산 바이트(그 연산 범위만)를 다시 읽는다. 다른 연산이 섞이거나 오류면 null. */
export function reparseOp(op: SourceOp, opBytes: Uint8Array): OpParts | null {
  const parsed = parseContentOpsLenient(opBytes);
  const parsedOp = parsed.ops[0];
  if (parsed.error || parsed.ops.length !== 1 || parsedOp?.op !== op.op) return null;
  return opParts(parsedOp.operands);
}

/** TJ 숫자(1/1000 텍스트 공간 단위) → 가로 변위(텍스트 공간, Th 포함). */
const numDisplacement = (n: number, size: number, th: number) => (-n / 1000) * size * th;

/** 가로 변위 → 같은 변위의 TJ 숫자. */
export const tjNumberFor = (tx: number, size: number, th: number) => (-tx / (size * th)) * 1000;

/** 연산을 명세 폭으로 분석한다. opBytes 는 그 연산 범위의 바이트. */
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
      // MuPDF 는 배열 안 Tw·Tc 키워드를 실행하지만 명세 밖이라 뷰어마다 다르다.
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
      // MuPDF 는 전진하지 않고, 명세대로 그리는 뷰어는 CID 0 폭으로 전진한다.
      if (cid < 0) {
        return { code: 'cid-unmapped', detail: 'CID 매핑 없는 코드(뷰어마다 전진량이 다름)' };
      }
      // Tw 는 1바이트 코드 32 에만 적용한다(MuPDF·명세 공통, 폰트 종류 무관).
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

/** 글리프 [0, end) 까지의 변위(그 앞 TJ 숫자 포함, end 글리프 앞 숫자도 포함). */
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

/** `'`·`"` 의 앞 효과(T*·Tw·Tc). Tj·TJ 는 빈 문자열. */
function prefixOf(op: SourceOp, opBytes: Uint8Array, parts: OpParts): string {
  if (op.op === "'") return 'T* ';
  if (op.op === '"') {
    const [aw, ac] = parts.nums;
    return `${srcText(opBytes, aw!)} Tw ${srcText(opBytes, ac!)} Tc T* `;
  }
  return '';
}

/**
 * 연산을 다시 쓴 텍스트. remove[i] 가 true 인 글리프는 같은 변위의 숫자로 바꾼다. split 이 있으면 그 글리프 바로
 * 앞에서 TJ 를 끝내고 split.insert 를 넣은 뒤 나머지 TJ 를 잇는다(split.glyph 앞에 남길 글리프가 있어야 한다).
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
