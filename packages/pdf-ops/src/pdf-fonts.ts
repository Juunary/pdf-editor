/**
 * PDF 폰트의 코드 분할·CID·글리프 폭을 MuPDF 1.28 과 같게 재현한다(Device 콜백의 글리프 원점과 맞추기 위함).
 * MuPDF 내부 폰트 로더는 JS 에 노출되지 않으므로 pdf-font.c / pdf-cmap.c / pdf-type3.c / pdf-metrics.c 의 분기를
 * 그대로 옮겼다. 정수 절단·반올림도 C 와 같게 둔다(float32 는 Math.fround).
 *
 * 정확: 폭 표가 폰트 사전에 있는 경우(/Widths, /W, Type3), Identity·임베디드 CMap, 표준 14 글꼴(/Widths 없음, 이름 해석 가능),
 *       사전 정의 CMap 의 코드 분할.
 * 근사(unresolved 에 사유를 남김): 사전 정의 CMap 의 CID 매핑(표 없음, /W 가 균일하지 않을 때), 임베디드 폰트 파일의 글리프 폭,
 *       AGL 표 밖 글리프 이름, Symbol·ZapfDingbats + /Encoding.
 *
 * 1.28.1 WASM 실측으로 C 소스·요구사항 발췌와 달랐던 점:
 * - pdf_to_int(실수) = floor(f + 0.5) (음수에서 (int)(f + 0.5) 가 아님)
 * - 표준 14 별칭 매칭은 "ABCDEF+" 부분 집합 접두어를 벗기지 않는다
 * - Type3 /FontMatrix 가 배열이 아니면(없으면) 항등행렬이다(명세 기본값 0.001 아님). 배열이면 모자란 칸은 0
 * - 임베디드 CMap: 코드스페이스가 없고 매핑 범위가 있으면 2바이트 <0000>-<FFFF> 를 넣고, 사전 /WMode 가 본문 WMode 를 덮는다
 * - 폰트 로드 실패(Type3 필수 키 없음, Type0 에서 CMap 이름 불명·FontDescriptor 없음 등)는 hail-mary(Times-Roman, 1바이트)로 대체된다
 */
import * as mupdf from 'mupdf';
import type { Matrix } from '@pdf-editor/shared-types';
import {
  STANDARD_ENCODING,
  SYMBOL_BUILTIN_GIDS,
  WIN_ANSI_ENCODING,
  MAC_ROMAN_ENCODING,
  ZAPF_BUILTIN_GIDS,
  glyphNameToUnicode,
  lookupPredefinedCMap,
  type CodespaceRange,
  type EncodingTable,
} from './glyph-names.js';
import { readStreamBytes } from './mupdf-util.js';

export interface DecodedCode {
  /** 원 코드 값: 바이트 big-endian (MuPDF cpt) */
  code: number;
  /** 디코드한 문자열 바이트 안의 오프셋과 길이 */
  offset: number;
  length: number;
}

export interface PdfFont {
  /** /Subtype 이름(Type0, Type1, MMType1, TrueType, Type3). 알 수 없으면 null */
  subtype: string | null;
  /** 폰트 사전의 간접 객체 번호. 직접 객체거나 hail-mary 면 null */
  objectNumber: number | null;
  wmode: 0 | 1;
  /** Type3 만: MuPDF 가 쓰는 /FontMatrix(없으면 항등, MuPDF 동작). 그 밖은 null */
  type3Matrix: Matrix | null;
  /** MuPDF 결과와 다를 수 있는 사유. 비어 있으면 정확 */
  unresolved: string[];
  /** MuPDF 가 이 사전을 로드하지 못해 hail-mary 로 대체했으면 그 사유 */
  fallbackReason?: string;
  /** 진단용: 내장 글꼴 경로(/Widths 없는 비임베디드 단순 폰트)에서 해석한 코드별 글리프 인덱스(Device 콜백 gid 와 비교 가능) */
  glyphIds?: readonly number[];
  /** 문자열 바이트를 코드로 분할(pdf_decode_cmap) */
  decode(bytes: Uint8Array): DecodedCode[];
  /** 코드 → CID(pdf_lookup_cmap). -1 이면 MuPDF 는 글리프를 그리지 않고 전진하지도 않는다 */
  cid(code: number): number;
  /** 가로 전진량 w0, 1/1000 텍스트 공간 단위 = pdf_lookup_hmtx(cid).w */
  advance(cid: number): number;
  /** 세로 지표 = pdf_lookup_vmtx(cid): w = w1y, x/y = 위치 벡터(1/1000) */
  vertical(cid: number): { w: number; x: number; y: number };
}

// ---------------------------------------------------------------- C 수치 규칙

const f32 = Math.fround;
const int16 = (v: number): number => (v << 16) >> 16;
const uint16 = (v: number): number => v & 0xffff;

/** pdf_to_int: 정수는 그대로, 실수는 (int)floorf(f + 0.5f), 그 밖은 0(간접 참조는 풀어서 본다) */
function toInt(o: mupdf.PDFObject): number {
  if (o.isInteger()) return o.asNumber();
  if (o.isReal()) return Math.floor(f32(f32(o.asNumber()) + 0.5));
  return 0;
}

/** pdf_to_real: 숫자가 아니면 0 */
function toReal(o: mupdf.PDFObject): number {
  return o.isNumber() ? o.asNumber() : 0;
}

/** pdf_array_get_int / pdf_array_get_real: 배열이 아니거나 범위 밖이면 null 객체 → 0 */
const arrInt = (a: mupdf.PDFObject, i: number): number => toInt(a.get(i));
const arrReal = (a: mupdf.PDFObject, i: number): number => toReal(a.get(i));

const nameOf = (o: mupdf.PDFObject): string => (o.isName() ? o.asName() : '');
const has = (o: mupdf.PDFObject): boolean => !o.isNull();

// ---------------------------------------------------------------- hmtx / vmtx (pdf-metrics.c)

interface HEntry {
  lo: number;
  hi: number;
  w: number;
}

/** pdf_hmtx 표. 등록 → lo 오름차순 정렬 → 이진 탐색(겹치면 탐색 중 먼저 걸린 항목). 못 찾으면 기본폭 */
class HmtxTable {
  readonly entries: HEntry[] = [];
  constructor(readonly dw: number) {}
  add(lo: number, hi: number, w: number): void {
    // lo/hi 는 unsigned short, w 는 int
    this.entries.push({ lo: uint16(lo), hi: uint16(hi), w: w | 0 });
  }
  end(): void {
    this.entries.sort((a, b) => a.lo - b.lo);
  }
  find(cid: number): HEntry | null {
    const e = this.entries;
    let l = 0;
    let r = e.length - 1;
    while (l <= r) {
      const m = (l + r) >> 1;
      const x = e[m]!;
      if (cid < x.lo) r = m - 1;
      else if (cid > x.hi) l = m + 1;
      else return x;
    }
    return null;
  }
  lookup(cid: number): number {
    return this.find(cid)?.w ?? this.dw;
  }
  /** 같은 lo 에 폭이 다른 항목이 있으면 MuPDF(qsort 불안정 정렬)와 순서가 다를 수 있다 */
  hasAmbiguousTies(): boolean {
    const seen = new Map<number, number>();
    for (const x of this.entries) {
      const prev = seen.get(x.lo);
      if (prev !== undefined && prev !== x.w) return true;
      seen.set(x.lo, x.w);
    }
    return false;
  }
}

interface VEntry {
  lo: number;
  hi: number;
  x: number;
  y: number;
  w: number;
}

class VmtxTable {
  readonly entries: VEntry[] = [];
  /** dvmtx.x 는 쓰이지 않는다(조회 때 hmtx.w / 2 로 덮는다) */
  constructor(
    readonly dy: number,
    readonly dw: number,
  ) {}
  add(lo: number, hi: number, x: number, y: number, w: number): void {
    // x, y, w 는 C short
    this.entries.push({ lo: uint16(lo), hi: uint16(hi), x: int16(x), y: int16(y), w: int16(w) });
  }
  end(): void {
    this.entries.sort((a, b) => a.lo - b.lo);
  }
  lookup(cid: number, h: HmtxTable): { w: number; x: number; y: number } {
    const e = this.entries;
    let l = 0;
    let r = e.length - 1;
    while (l <= r) {
      const m = (l + r) >> 1;
      const v = e[m]!;
      if (cid < v.lo) r = m - 1;
      else if (cid > v.hi) l = m + 1;
      else return { w: v.w, x: v.x, y: v.y };
    }
    // v = dvmtx; v.x = h.w / 2 (C int 나눗셈, short 대입)
    return { w: int16(this.dw), x: int16(Math.trunc(h.lookup(cid) / 2)), y: int16(this.dy) };
  }
}

// ---------------------------------------------------------------- CMap

const cs = (n: number, low: number, high: number): CodespaceRange => ({ n, low, high });

/** 코드 → CID. -1 = 매핑 없음 */
interface CMapSpec {
  codespaces: CodespaceRange[];
  wmode: 0 | 1;
  lookup(code: number): number;
  unresolved: string[];
  /** CID 가 코드 그대로인 자리표시자 매핑을 포함하는가(사전 정의 CMap) */
  placeholder: boolean;
}

/** pdf_decode_cmap 을 바이트열 전체에 반복 적용. 일치 코드스페이스가 없으면 코드 0, 길이 1 */
function decodeWith(codespaces: readonly CodespaceRange[], bytes: Uint8Array): DecodedCode[] {
  const out: DecodedCode[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const len = Math.min(4, bytes.length - pos);
    let c = 0;
    let matched = 0;
    for (let n = 0; n < len && matched === 0; n++) {
      c = ((c << 8) | bytes[pos + n]!) >>> 0;
      for (const r of codespaces) {
        if (r.n === n + 1 && c >= r.low && c <= r.high) {
          matched = n + 1;
          break;
        }
      }
    }
    if (matched > 0) {
      out.push({ code: c, offset: pos, length: matched });
      pos += matched;
    } else {
      out.push({ code: 0, offset: pos, length: 1 });
      pos += 1;
    }
  }
  return out;
}

interface Segment {
  lo: number;
  hi: number;
  out: number;
}

/** 정의 순서상 나중 범위가 이기는 구간 맵(MuPDF 의 splay 트리와 같은 결과) */
class RangeMap {
  private readonly segs: Segment[] = [];
  count = 0;
  add(lo: number, hi: number, out: number): void {
    if (lo > hi) return;
    this.count++;
    const s = this.segs;
    const last = s[s.length - 1];
    if (!last || lo > last.hi) {
      s.push({ lo, hi, out });
      return;
    }
    let a = 0;
    let b = s.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (s[m]!.hi < lo) a = m + 1;
      else b = m;
    }
    let e = a;
    while (e < s.length && s[e]!.lo <= hi) e++;
    const repl: Segment[] = [];
    if (a < e && s[a]!.lo < lo) repl.push({ lo: s[a]!.lo, hi: lo - 1, out: s[a]!.out });
    repl.push({ lo, hi, out });
    if (a < e) {
      const tail = s[e - 1]!;
      if (tail.hi > hi) repl.push({ lo: hi + 1, hi: tail.hi, out: tail.out + (hi + 1 - tail.lo) });
    }
    s.splice(a, e - a, ...repl);
  }
  lookup(code: number): number {
    const s = this.segs;
    let l = 0;
    let r = s.length - 1;
    while (l <= r) {
      const m = (l + r) >> 1;
      const x = s[m]!;
      if (code < x.lo) r = m - 1;
      else if (code > x.hi) l = m + 1;
      else return code - x.lo + x.out;
    }
    return -1;
  }
}

const IDENTITY_CODESPACE: CodespaceRange[] = [cs(2, 0x0000, 0xffff)];

function identityCMap(wmode: 0 | 1): CMapSpec {
  return {
    codespaces: [...IDENTITY_CODESPACE],
    wmode,
    lookup: (code) => (code <= 0xffff ? code : -1),
    unresolved: [],
    placeholder: false,
  };
}

/** 사전 정의 CMap(이름). null = MuPDF 가 읽지 못하는 이름 */
function namedCMap(name: string): CMapSpec | null {
  if (name === 'Identity-H') return identityCMap(0);
  if (name === 'Identity-V') return identityCMap(1);
  const p = lookupPredefinedCMap(name);
  if (!p) return null;
  const unresolved = [`사전 정의 CMap ${name}: CID 매핑표 없음(코드를 CID 로 간주)`];
  if (p.guessed) unresolved.push(`사전 정의 CMap ${name}: 코드스페이스 일부 추정`);
  return {
    codespaces: p.codespaces.map((r) => ({ ...r })),
    wmode: p.wmode,
    lookup: (code) => code,
    unresolved,
    placeholder: true,
  };
}

type CTok =
  | { t: 'hex'; v: number; n: number }
  | { t: 'int'; v: number }
  | { t: 'name'; v: string }
  | { t: 'kw'; v: string }
  | { t: 'other' };

const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
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

/** CMap 본문(PostScript 부분집합) 토큰화. 16진 문자열은 big-endian 정수와 바이트 수로 */
function lexCMap(b: Uint8Array): CTok[] {
  const out: CTok[] = [];
  const n = b.length;
  let i = 0;
  const hexv = (c: number) =>
    c >= 0x30 && c <= 0x39
      ? c - 0x30
      : c >= 0x41 && c <= 0x46
        ? c - 0x37
        : c >= 0x61 && c <= 0x66
          ? c - 0x57
          : -1;
  while (i < n) {
    const c = b[i]!;
    if (isWs(c)) {
      i++;
    } else if (c === 0x25) {
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
    } else if (c === 0x3c && b[i + 1] === 0x3c) {
      out.push({ t: 'other' });
      i += 2;
    } else if (c === 0x3e && b[i + 1] === 0x3e) {
      out.push({ t: 'other' });
      i += 2;
    } else if (c === 0x3c) {
      // 16진 문자열: 홀수 자리면 마지막 니블은 상위 비트에 둔다(PDF 규칙)
      i++;
      const nib: number[] = [];
      while (i < n && b[i] !== 0x3e) {
        const h = hexv(b[i]!);
        if (h >= 0) nib.push(h);
        i++;
      }
      i++;
      if (nib.length % 2 === 1) nib.push(0);
      let v = 0;
      for (let k = 0; k < nib.length; k += 2) v = ((v << 8) | (nib[k]! << 4) | nib[k + 1]!) >>> 0;
      out.push({ t: 'hex', v, n: nib.length / 2 });
    } else if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (b[i] === 0x5c) i++;
        else if (b[i] === 0x28) depth++;
        else if (b[i] === 0x29) depth--;
        i++;
      }
      out.push({ t: 'other' });
    } else if (c === 0x2f) {
      let j = i + 1;
      while (j < n && !isWs(b[j]!) && !isDelim(b[j]!)) j++;
      out.push({ t: 'name', v: String.fromCharCode(...b.subarray(i + 1, j)) });
      i = j;
    } else if (isDelim(c)) {
      out.push({ t: 'other' });
      i++;
    } else {
      let j = i;
      while (j < n && !isWs(b[j]!) && !isDelim(b[j]!)) j++;
      const s = String.fromCharCode(...b.subarray(i, j));
      if (/^[+-]?\d+$/.test(s)) out.push({ t: 'int', v: parseInt(s, 10) });
      else if (/^[+-]?(\d+\.\d*|\.\d+)$/.test(s)) out.push({ t: 'other' });
      else out.push({ t: 'kw', v: s });
      i = j;
    }
  }
  return out;
}

interface ParsedCMap {
  codespaces: CodespaceRange[];
  ranges: RangeMap;
  wmode: number | null;
  usecmap: string | null;
}

/** pdf_parse_cmap: codespacerange·cidrange·cidchar·WMode·usecmap 만 해석(bf* 등은 건너뜀) */
function parseCMapBody(data: Uint8Array): ParsedCMap {
  const toks = lexCMap(data);
  const res: ParsedCMap = { codespaces: [], ranges: new RangeMap(), wmode: null, usecmap: null };
  let lastName = '';
  let i = 0;
  while (i < toks.length) {
    const t = toks[i++]!;
    if (t.t === 'name') {
      if (t.v === 'WMode') {
        const nx = toks[i];
        if (nx?.t === 'int') {
          res.wmode = nx.v;
          i++;
        }
      } else lastName = t.v;
    } else if (t.t === 'kw') {
      if (t.v === 'endcmap') break;
      if (t.v === 'usecmap') res.usecmap = lastName;
      else if (t.v === 'begincodespacerange') {
        for (;;) {
          const a = toks[i];
          const z = toks[i + 1];
          if (a?.t !== 'hex' || z?.t !== 'hex') break;
          res.codespaces.push(cs(z.n, a.v, z.v));
          i += 2;
        }
      } else if (t.v === 'begincidrange') {
        for (;;) {
          const a = toks[i];
          const z = toks[i + 1];
          const o = toks[i + 2];
          if (a?.t !== 'hex' || z?.t !== 'hex' || o?.t !== 'int') break;
          res.ranges.add(a.v, z.v, o.v);
          i += 3;
        }
      } else if (t.v === 'begincidchar') {
        for (;;) {
          const a = toks[i];
          const o = toks[i + 1];
          if (a?.t !== 'hex' || o?.t !== 'int') break;
          res.ranges.add(a.v, a.v, o.v);
          i += 2;
        }
      } else if (/^begin(bf|notdef)/.test(t.v)) {
        while (i < toks.length) {
          const x = toks[i++]!;
          if (x.t === 'kw' && x.v.startsWith('end')) break;
        }
      }
    }
  }
  return res;
}

/**
 * pdf_load_embedded_cmap. 관측한 MuPDF 동작:
 * - 본문에 코드스페이스가 없고 매핑 범위가 있으면 2바이트 <0000>-<FFFF> 를 넣는다.
 * - usecmap(본문 이름·사전 /UseCMap)은 파싱 뒤에 적용되며, 코드스페이스가 비어 있을 때만 상속한다. 이름을 못 읽으면 무시한다.
 * - 사전에 /WMode 숫자가 있으면 본문 WMode 를 덮는다.
 */
function loadEmbeddedCMap(stream: mupdf.PDFObject, depth = 0): CMapSpec {
  const unresolved: string[] = [];
  const parsed = parseCMapBody(readStreamBytes(stream));
  const codespaces = parsed.codespaces;
  if (codespaces.length === 0 && parsed.ranges.count > 0) codespaces.push(cs(2, 0, 0xffff));

  let fallback: CMapSpec | null = null;
  let placeholder = false;
  const useDict = stream.get('UseCMap');
  if (useDict.isName() || (useDict.isStream() && depth < 8)) {
    if (useDict.isName()) fallback = namedCMap(useDict.asName());
    else fallback = loadEmbeddedCMap(useDict, depth + 1);
    if (!fallback) unresolved.push(`UseCMap ${nameOf(useDict)}: MuPDF 가 읽지 못하는 CMap(무시됨)`);
  } else if (parsed.usecmap !== null) {
    fallback = namedCMap(parsed.usecmap);
    if (!fallback) unresolved.push(`usecmap ${parsed.usecmap}: MuPDF 가 읽지 못하는 CMap(무시됨)`);
  }
  if (fallback) {
    if (codespaces.length === 0) codespaces.push(...fallback.codespaces);
    unresolved.push(...fallback.unresolved);
    placeholder = fallback.placeholder;
  }

  const dictW = stream.get('WMode');
  const wmode = (dictW.isNumber() ? toInt(dictW) : (parsed.wmode ?? 0)) === 1 ? 1 : 0;
  return {
    codespaces,
    wmode,
    lookup: (code) => {
      const c = parsed.ranges.lookup(code);
      return c >= 0 ? c : (fallback?.lookup(code) ?? -1);
    },
    unresolved,
    placeholder,
  };
}

// ---------------------------------------------------------------- 표준 14 글꼴 (pdf_load_builtin_font)

const BASE_FONT_NAMES: readonly (readonly string[])[] = [
  ['Courier', 'CourierNew', 'CourierNewPSMT'],
  ['Courier-Bold', 'CourierNew,Bold', 'Courier,Bold', 'CourierNewPS-BoldMT', 'CourierNew-Bold'],
  [
    'Courier-Oblique',
    'CourierNew,Italic',
    'Courier,Italic',
    'CourierNewPS-ItalicMT',
    'CourierNew-Italic',
  ],
  [
    'Courier-BoldOblique',
    'CourierNew,BoldItalic',
    'Courier,BoldItalic',
    'CourierNewPS-BoldItalicMT',
    'CourierNew-BoldItalic',
  ],
  ['Helvetica', 'ArialMT', 'Arial'],
  ['Helvetica-Bold', 'Arial-BoldMT', 'Arial,Bold', 'Arial-Bold', 'Helvetica,Bold'],
  [
    'Helvetica-Oblique',
    'Arial-ItalicMT',
    'Arial,Italic',
    'Arial-Italic',
    'Helvetica,Italic',
    'Helvetica-Italic',
  ],
  [
    'Helvetica-BoldOblique',
    'Arial-BoldItalicMT',
    'Arial,BoldItalic',
    'Arial-BoldItalic',
    'Helvetica,BoldItalic',
    'Helvetica-BoldItalic',
  ],
  ['Times-Roman', 'TimesNewRomanPSMT', 'TimesNewRoman', 'TimesNewRomanPS'],
  [
    'Times-Bold',
    'TimesNewRomanPS-BoldMT',
    'TimesNewRoman,Bold',
    'TimesNewRomanPS-Bold',
    'TimesNewRoman-Bold',
  ],
  [
    'Times-Italic',
    'TimesNewRomanPS-ItalicMT',
    'TimesNewRoman,Italic',
    'TimesNewRomanPS-Italic',
    'TimesNewRoman-Italic',
  ],
  [
    'Times-BoldItalic',
    'TimesNewRomanPS-BoldItalicMT',
    'TimesNewRoman,BoldItalic',
    'TimesNewRomanPS-BoldItalic',
    'TimesNewRoman-BoldItalic',
  ],
  [
    'Symbol',
    'Symbol,Italic',
    'Symbol,Bold',
    'Symbol,BoldItalic',
    'SymbolMT',
    'SymbolMT,Italic',
    'SymbolMT,Bold',
    'SymbolMT,BoldItalic',
  ],
  ['ZapfDingbats'],
];

/**
 * pdf_clean_font_name: 표(공백 무시 비교)에 있으면 표준 이름, 없으면 null.
 * 소스(skip_subset_prefix)와 달리 1.28.1 WASM 실측은 "ABCDEF+" 접두어를 벗기지 않는다("ABCDEF+Arial" → 표 불일치).
 */
function cleanFontName(fontname: string): string | null {
  const s = fontname.replace(/ /g, '');
  for (const row of BASE_FONT_NAMES) for (const alt of row) if (alt === s) return row[0]!;
  return null;
}

const FD_FIXED_PITCH = 1 << 0;
const FD_SERIF = 1 << 1;
const FD_SYMBOLIC = 1 << 2;
const FD_NONSYMBOLIC = 1 << 5;
const FD_ITALIC = 1 << 6;
const FD_FORCE_BOLD = 1 << 18;

/** pdf_lookup_substitute_font + pdf_load_system_font 의 플래그 판정 */
function substituteFace(fontname: string, flags: number): string {
  const bold = fontname.includes('Bold') || (flags & FD_FORCE_BOLD) !== 0;
  const italic =
    fontname.includes('Italic') || fontname.includes('Oblique') || (flags & FD_ITALIC) !== 0;
  const mono = (flags & FD_FIXED_PITCH) !== 0;
  const serif = (flags & FD_SERIF) !== 0;
  const family = mono ? 'Courier' : serif ? 'Times' : 'Helvetica';
  const style = bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Roman';
  if (family === 'Times') return `Times-${style}`;
  const sty = style === 'Roman' ? '' : `-${style.replace('Italic', 'Oblique')}`;
  return `${family}${sty}`;
}

/** ft_width: FT_Get_Advance * 1000 / upem (C int). advanceGlyph 는 float32 로 나눈 값이므로 잡음만큼 보정해 내림 */
const glyphWidth = (font: mupdf.Font, gid: number): number =>
  Math.floor(font.advanceGlyph(gid) * 1000 + 0.001);

function loadEncodingByName(est: (string | null)[], name: string, unresolved: Set<string>): void {
  let base: EncodingTable | null = null;
  if (name === 'StandardEncoding') base = STANDARD_ENCODING;
  else if (name === 'MacRomanEncoding') base = MAC_ROMAN_ENCODING;
  else if (name === 'WinAnsiEncoding') base = WIN_ANSI_ENCODING;
  else if (name === 'MacExpertEncoding') unresolved.add('MacExpertEncoding 표 없음(이름 미적용)');
  if (base) for (let i = 0; i < 256; i++) est[i] = base[i] ?? null;
}

/**
 * 내장 글꼴 face 의 256개 코드별 폭. 글리프는 이름 → 유니코드(AGL) → 글꼴 유니코드 cmap 으로 찾고,
 * 못 찾으면 내장 인코딩(텍스트 글꼴은 StandardEncoding, Symbol·ZapfDingbats 는 실측 표)으로 되돌린다.
 */
function builtinWidths(
  face: string,
  est: readonly (string | null)[],
  hasEncoding: boolean,
  unresolved: Set<string>,
): { widths: number[]; gids: number[] } {
  const font = new mupdf.Font(face);
  try {
    const symbolFace = face === 'Symbol' || face === 'ZapfDingbats';
    const table = face === 'Symbol' ? SYMBOL_BUILTIN_GIDS : ZAPF_BUILTIN_GIDS;
    const gidByUnicode = (u: number): number => font.encodeCharacter(u);
    const builtinGid = (code: number): number => {
      if (symbolFace) return table[code] ?? 0;
      const n = STANDARD_ENCODING[code];
      const u = n ? glyphNameToUnicode(n) : null;
      return u === null ? 0 : Math.max(0, gidByUnicode(u));
    };
    if (symbolFace && hasEncoding)
      unresolved.add(`${face} + /Encoding: 글리프 이름 → 글리프 매핑 근사`);
    const widths: number[] = [];
    const gids: number[] = [];
    for (let code = 0; code < 256; code++) {
      let gid = builtinGid(code);
      const name = est[code];
      if (name) {
        const u = glyphNameToUnicode(name);
        if (u === null) {
          // .notdef 는 글꼴에 있어도 이름 조회(ft_name_index > 0 검사)에서 걸러지므로 내장 글리프가 그대로 남는다
          if (name !== '.notdef') unresolved.add(`글리프 이름 미해석(글꼴에 없다고 가정): ${name}`);
        } else {
          const g = gidByUnicode(u);
          if (g > 0) gid = g;
        }
      }
      gids.push(gid);
      widths.push(glyphWidth(font, gid));
    }
    return { widths, gids };
  } finally {
    font.destroy();
  }
}

// ---------------------------------------------------------------- 폰트 구현

interface FontParts {
  subtype: string | null;
  objectNumber: number | null;
  wmode: 0 | 1;
  type3Matrix: Matrix | null;
  unresolved: string[];
  fallbackReason?: string;
  h: HmtxTable;
  v: VmtxTable | null;
  /** null = 1바이트 단순 폰트 */
  cmap: CMapSpec | null;
  gids?: number[];
}

function makeFont(p: FontParts): PdfFont {
  const font: PdfFont = {
    subtype: p.subtype,
    objectNumber: p.objectNumber,
    wmode: p.wmode,
    type3Matrix: p.type3Matrix,
    unresolved: p.unresolved,
    decode(bytes) {
      if (p.cmap) return decodeWith(p.cmap.codespaces, bytes);
      return Array.from(bytes, (b, i) => ({ code: b, offset: i, length: 1 }));
    },
    cid(code) {
      return p.cmap ? p.cmap.lookup(code) : code;
    },
    advance(cid) {
      return p.h.lookup(cid);
    },
    vertical(cid) {
      const v = p.v ?? new VmtxTable(880, -1000);
      return v.lookup(cid, p.h);
    },
  };
  if (p.fallbackReason !== undefined) font.fallbackReason = p.fallbackReason;
  if (p.gids) font.glyphIds = p.gids;
  return font;
}

/** MuPDF 가 로드에 실패해 hail-mary 로 대체하는 경우의 신호 */
class LoadFailure extends Error {}

/** pdf_load_simple_font. dict = null 이면 hail-mary(BaseFont 없음, Widths 없음) */
function buildSimple(dict: mupdf.PDFObject | null, subtype: string | null): FontParts {
  const unresolved = new Set<string>();
  const get = (k: string): mupdf.PDFObject => (dict ? dict.get(k) : mupdf.PDFObject.Null);

  const basefont = nameOf(get('BaseFont'));
  const descriptor = get('FontDescriptor');
  const hasDescriptor = has(descriptor);
  let flags = hasDescriptor ? toInt(descriptor.get('Flags')) : 0;
  const missingWidth = hasDescriptor ? toReal(descriptor.get('MissingWidth')) : 0;
  const embedded =
    hasDescriptor &&
    (['FontFile', 'FontFile2', 'FontFile3'] as const).some((k) => descriptor.get(k).isIndirect());

  // 글꼴 선택: 표준 이름 → 그 글꼴, 이름 불명 + 기술자 없음 → Times-Roman, 기술자 있음 → 플래그 기반 대체 글꼴
  const clean = cleanFontName(basefont);
  const face = clean ?? (hasDescriptor ? substituteFace(basefont, flags) : 'Times-Roman');
  if (face === 'Symbol' || face === 'ZapfDingbats') flags |= FD_SYMBOLIC;
  const symbolic = (flags & FD_NONSYMBOLIC) !== 0 ? false : (flags & FD_SYMBOLIC) !== 0;

  const h = new HmtxTable(Math.trunc(missingWidth));
  let gids: number[] | undefined;
  const widths = get('Widths');
  if (has(widths)) {
    let first = toInt(get('FirstChar'));
    let last = toInt(get('LastChar'));
    if (first < 0 || last > 255 || first > last) first = last = 0;
    for (let i = 0; i < last - first + 1; i++) h.add(i + first, i + first, arrInt(widths, i));
  } else if (embedded) {
    unresolved.add(
      '임베디드 폰트 + /Widths 없음: 폰트 파일 글리프 폭 해석 불가(MissingWidth 로 대체)',
    );
  } else {
    // 인코딩
    const est: (string | null)[] = new Array<string | null>(256).fill(null);
    const enc = get('Encoding');
    if (has(enc)) {
      if (enc.isName()) loadEncodingByName(est, enc.asName(), unresolved);
      if (enc.isDictionary()) {
        const base = enc.get('BaseEncoding');
        if (base.isName()) loadEncodingByName(est, base.asName(), unresolved);
        else if (!symbolic) loadEncodingByName(est, 'StandardEncoding', unresolved);
        const diff = enc.get('Differences');
        if (diff.isArray()) {
          let k = 0;
          for (let i = 0; i < diff.length; i++) {
            const item = diff.get(i);
            if (item.isInteger()) k = toInt(item);
            if (item.isName() && k >= 0 && k < 256) est[k++] = item.asName();
          }
        }
      }
    } else if (!symbolic) loadEncodingByName(est, 'StandardEncoding', unresolved);
    try {
      const r = builtinWidths(face, est, has(enc), unresolved);
      gids = r.gids;
      for (let i = 0; i < 256; i++) h.add(i, i, r.widths[i]!);
    } catch (e) {
      unresolved.add(`내장 글꼴 ${face} 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  h.end();
  return {
    subtype,
    objectNumber: null,
    wmode: 0,
    type3Matrix: null,
    unresolved: [...unresolved],
    h,
    v: null,
    cmap: null,
    ...(gids ? { gids } : {}),
  };
}

/** pdf_load_type3_font 의 폭 부분 */
function buildType3(dict: mupdf.PDFObject): FontParts {
  if (!has(dict.get('Encoding'))) throw new LoadFailure('Type3 /Encoding 없음');
  const widths = dict.get('Widths');
  const charprocs = dict.get('CharProcs');
  // 위 두 검사는 MuPDF 에서 FirstChar/LastChar 읽은 뒤에 나오지만 어느 쪽이든 로드 실패다
  if (!has(widths)) throw new LoadFailure('Type3 /Widths 없음');
  if (!has(charprocs)) throw new LoadFailure('Type3 /CharProcs 없음');

  // pdf_dict_get_matrix: 배열이 아니면 항등, 배열이면 6칸을 실수로 읽는다(모자란 칸 0)
  const fm = dict.get('FontMatrix');
  const m: Matrix = fm.isArray()
    ? ([0, 1, 2, 3, 4, 5].map((i) => f32(arrReal(fm, i))) as Matrix)
    : [1, 0, 0, 1, 0, 0];

  const h = new HmtxTable(0);
  let first = toInt(dict.get('FirstChar'));
  let last = toInt(dict.get('LastChar'));
  if (first < 0 || last > 255 || first > last) first = last = 0;
  for (let i = first; i <= last; i++) {
    // float w = a * w * 1000 (모두 float32), pdf_add_hmtx(int) 로 절단
    const w = f32(f32(m[0] * f32(arrReal(widths, i - first))) * 1000);
    h.add(i, i, Math.trunc(w));
  }
  h.end();
  return {
    subtype: 'Type3',
    objectNumber: null,
    wmode: 0,
    type3Matrix: m,
    unresolved: [],
    h,
    v: null,
    cmap: null,
  };
}

/** pdf_load_type0_font + load_cid_font */
function buildType0(dict: mupdf.PDFObject): FontParts {
  const dfonts = dict.get('DescendantFonts');
  if (!has(dfonts)) throw new LoadFailure('Type0 /DescendantFonts 없음');
  const dfont = dfonts.get(0);
  const dsub = nameOf(dfont.get('Subtype'));
  if (dsub !== 'CIDFontType0' && dsub !== 'CIDFontType2')
    throw new LoadFailure(`알 수 없는 CID 폰트 종류: ${dsub}`);

  const encoding = dict.get('Encoding');
  let cmap: CMapSpec | null;
  if (encoding.isName()) {
    cmap = namedCMap(encoding.asName());
    if (!cmap) throw new LoadFailure(`MuPDF 가 읽지 못하는 CMap: ${encoding.asName()}`);
  } else if (encoding.isIndirect() && encoding.isStream()) {
    cmap = loadEmbeddedCMap(encoding);
  } else {
    throw new LoadFailure('Type0 /Encoding 이 이름도 CMap 스트림도 아님');
  }
  if (!has(dfont.get('FontDescriptor'))) throw new LoadFailure('CID 폰트 /FontDescriptor 없음');

  const unresolved = new Set<string>(cmap.unresolved);
  const dwObj = dfont.get('DW');
  const dw = dwObj.isNumber() ? toInt(dwObj) : 1000;
  const h = new HmtxTable(dw);
  const w = dfont.get('W');
  if (has(w)) {
    const n = w.length;
    for (let i = 0; i < n;) {
      const c0 = arrInt(w, i);
      const obj = w.get(i + 1);
      if (obj.isArray()) {
        const m = obj.length;
        for (let k = 0; k < m; k++) h.add(c0 + k, c0 + k, arrInt(obj, k));
        i += 2;
      } else {
        const c1 = toInt(obj);
        h.add(c0, c1, arrInt(w, i + 2));
        i += 3;
      }
    }
  }
  h.end();
  if (h.hasAmbiguousTies())
    unresolved.add('/W: 같은 시작 CID 에 폭이 다른 항목(MuPDF 정렬 순서 불확정)');

  let v: VmtxTable | null = null;
  const wmode = cmap.wmode;
  const w2 = dfont.get('W2');
  if (wmode === 1) {
    let dw2y = 880;
    let dw2w = -1000;
    const dw2 = dfont.get('DW2');
    if (has(dw2)) {
      dw2y = arrInt(dw2, 0);
      dw2w = arrInt(dw2, 1);
    }
    v = new VmtxTable(dw2y, dw2w);
    if (has(w2)) {
      const n = w2.length;
      for (let i = 0; i < n;) {
        const c0 = arrInt(w2, i);
        const obj = w2.get(i + 1);
        if (obj.isArray()) {
          const m = obj.length;
          for (let k = 0; k * 3 < m; k++) {
            v.add(
              c0 + k,
              c0 + k,
              arrInt(obj, k * 3 + 1),
              arrInt(obj, k * 3 + 2),
              arrInt(obj, k * 3),
            );
          }
          i += 2;
        } else {
          const c1 = toInt(obj);
          v.add(c0, c1, arrInt(w2, i + 3), arrInt(w2, i + 4), arrInt(w2, i + 2));
          i += 5;
        }
      }
    }
    v.end();
  }

  // 사전 정의 CMap 의 CID 는 자리표시자다. 폭이 CID 와 무관하게 균일하면(W 없음 또는 모든 폭이 DW) 폭은 정확하다.
  if (cmap.placeholder) {
    const uniformH = h.entries.every((e) => e.w === dw);
    const uniformV = wmode === 0 || (v !== null && v.entries.length === 0);
    if (!uniformH) unresolved.add('사전 정의 CMap 의 CID 를 몰라 /W 폭 조회가 부정확');
    else if (!uniformV) unresolved.add('사전 정의 CMap 의 CID 를 몰라 /W2 조회가 부정확');
    // 균일하면 CID 조회 결과와 무관하게 같은 폭이므로 CMap 사유(CID 매핑표 없음)는 폭에 영향이 없다
    if (uniformH && uniformV) {
      for (const r of [...unresolved]) if (r.includes('CID 매핑표 없음')) unresolved.delete(r);
    }
  }
  return {
    subtype: 'Type0',
    objectNumber: null,
    wmode,
    type3Matrix: null,
    unresolved: [...unresolved],
    h,
    v,
    cmap,
  };
}

const SIMPLE_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType']);

/** pdf_load_font 의 분기. 로드 실패(LoadFailure)는 호출자가 hail-mary 로 바꾼다 */
function buildFromDict(dict: mupdf.PDFObject): FontParts {
  const subtype = nameOf(dict.get('Subtype'));
  if (subtype === 'Type0') return buildType0(dict);
  if (SIMPLE_SUBTYPES.has(subtype)) return buildSimple(dict, subtype);
  if (subtype === 'Type3') return buildType3(dict);
  if (has(dict.get('CharProcs'))) return buildType3(dict);
  if (has(dict.get('DescendantFonts'))) return buildType0(dict);
  return buildSimple(dict, null);
}

/**
 * 문서 단위 폰트 캐시. 간접 객체 번호로 구분하고, 직접(해석된) 객체면 객체 자신으로 구분한다.
 * 직접 객체는 래퍼가 달라도 같은 pdf_obj 면 wasm 포인터가 같으므로 포인터를 키로 쓰고, 래퍼를 붙잡아 포인터 재사용을 막는다.
 */
export class FontCache {
  private readonly byNumber = new Map<number, PdfFont>();
  private readonly byPointer = new Map<number, { obj: mupdf.PDFObject; font: PdfFont }>();
  private hailMary: PdfFont | null = null;

  constructor(readonly doc: mupdf.PDFDocument) {}

  /** fontObj = 해석된 /Font 리소스 사전. null 이면 MuPDF "hail mary" 폰트(Tf 리소스가 없을 때) */
  load(fontObj: mupdf.PDFObject | null): PdfFont {
    if (fontObj === null || fontObj.isNull()) return this.hail();
    const num = fontObj.isIndirect() ? fontObj.asIndirect() : null;
    const cached =
      num !== null ? this.byNumber.get(num) : this.byPointer.get(fontObj.pointer)?.font;
    if (cached) return cached;

    let font: PdfFont;
    try {
      const parts = buildFromDict(fontObj);
      parts.objectNumber = num;
      font = makeFont(parts);
    } catch (e) {
      const reason =
        e instanceof LoadFailure
          ? e.message
          : `폰트 해석 예외: ${e instanceof Error ? e.message : String(e)}`;
      const parts = buildSimple(null, null);
      parts.objectNumber = num;
      parts.fallbackReason = reason;
      if (!(e instanceof LoadFailure)) parts.unresolved.push(reason);
      font = makeFont(parts);
    }
    if (num !== null) this.byNumber.set(num, font);
    else this.byPointer.set(fontObj.pointer, { obj: fontObj, font });
    return font;
  }

  private hail(): PdfFont {
    this.hailMary ??= makeFont(buildSimple(null, null));
    return this.hailMary;
  }
}
