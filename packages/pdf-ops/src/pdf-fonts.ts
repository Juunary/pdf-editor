/**
 * Reproduces PDF font code splitting, CIDs and glyph widths the same as MuPDF 1.28 (to match the glyph origins of the Device callback).
 * MuPDF's internal font loader is not exposed to JS, so the branches of pdf-font.c / pdf-cmap.c / pdf-type3.c / pdf-metrics.c are
 * ported as they are. Integer truncation and rounding are kept the same as in C (float32 via Math.fround).
 *
 * Exact: when the width table is in the font dictionary (/Widths, /W, Type3), Identity and embedded CMaps, the standard 14 fonts (no /Widths, name resolvable),
 *       code splitting of predefined CMaps.
 * Approximate (reason recorded in unresolved): CID mapping of predefined CMaps (no table, when /W is not uniform), glyph widths of embedded font files,
 *       glyph names outside the AGL table, Symbol and ZapfDingbats + /Encoding.
 *
 * Differences found by measuring on 1.28.1 WASM against the C source and the requirement excerpts:
 * - pdf_to_int(real) = floor(f + 0.5) (not (int)(f + 0.5) for negatives)
 * - Standard 14 alias matching does not strip the "ABCDEF+" subset prefix
 * - If Type3 /FontMatrix is not an array (or absent) it is the identity matrix (not the spec default 0.001). If it is an array, missing entries are 0
 * - Embedded CMap: if there is no codespace but there are mapping ranges, 2-byte <0000>-<FFFF> is added, and the dictionary /WMode overrides the body WMode
 * - Font load failures (Type3 missing required keys, Type0 with unknown CMap name or no FontDescriptor, etc.) are replaced by hail-mary (Times-Roman, 1 byte)
 *
 * Two sets of widths are kept. `advance` is the MuPDF reproduction (pdf_to_int integer widths, for matching), and `advanceSpec` is the spec width (pdf_to_real real widths,
 * for editing). For fonts with fractional /Widths or /W, computing edit operations (TJ number adjustments) with integer widths shifts the later characters in
 * viewers that draw per the spec (PDFium, Acrobat, pdf.js).
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
  /** Original code value: bytes, big-endian (MuPDF cpt) */
  code: number;
  /** Offset and length within the decoded string bytes */
  offset: number;
  length: number;
}

export interface PdfFont {
  /** /Subtype name (Type0, Type1, MMType1, TrueType, Type3). null if unknown */
  subtype: string | null;
  /** Indirect object number of the font dictionary. null for a direct object or hail-mary */
  objectNumber: number | null;
  wmode: 0 | 1;
  /** Type3 only: the /FontMatrix MuPDF uses (identity if absent, MuPDF behavior). null otherwise */
  type3Matrix: Matrix | null;
  /** Reasons the result may differ from MuPDF. Empty means exact */
  unresolved: string[];
  /** If MuPDF could not load this dictionary and substituted hail-mary, the reason */
  fallbackReason?: string;
  /** For diagnostics: per-code glyph index resolved on the built-in font path (non-embedded simple font without /Widths) (comparable with the Device callback gid) */
  glyphIds?: readonly number[];
  /** Splits string bytes into codes (pdf_decode_cmap) */
  decode(bytes: Uint8Array): DecodedCode[];
  /** Code → CID (pdf_lookup_cmap). If -1, MuPDF neither draws the glyph nor advances */
  cid(code: number): number;
  /** Horizontal advance w0, in 1/1000 text-space units = pdf_lookup_hmtx(cid).w (MuPDF integer width, for matching) */
  advance(cid: number): number;
  /**
   * Spec horizontal advance w0, in 1/1000 text-space units. Reads /Widths, /W, /DW and /MissingWidth as real numbers (for editing).
   * Reals in MuPDF objects are float32, so they can differ from the source decimal value at the 1e-5 level.
   */
  advanceSpec(cid: number): number;
  /** Vertical metrics = pdf_lookup_vmtx(cid): w = w1y, x/y = position vector (1/1000) */
  vertical(cid: number): { w: number; x: number; y: number };
}

// ---------------------------------------------------------------- C numeric rules

const f32 = Math.fround;
const int16 = (v: number): number => (v << 16) >> 16;
const uint16 = (v: number): number => v & 0xffff;

/** pdf_to_int: integer as is, real as (int)floorf(f + 0.5f), otherwise 0 (indirect references are resolved first) */
function toInt(o: mupdf.PDFObject): number {
  if (o.isInteger()) return o.asNumber();
  if (o.isReal()) return Math.floor(f32(f32(o.asNumber()) + 0.5));
  return 0;
}

/** pdf_to_real: 0 if not a number */
function toReal(o: mupdf.PDFObject): number {
  return o.isNumber() ? o.asNumber() : 0;
}

/** pdf_array_get_int / pdf_array_get_real: null object → 0 if not an array or out of range */
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

/**
 * pdf_hmtx table. Register → sort by lo ascending → binary search (on overlap, the entry hit first in the search). Default width if not found.
 * If real = true, widths are not truncated to integers (spec width table).
 */
class HmtxTable {
  readonly entries: HEntry[] = [];
  constructor(
    readonly dw: number,
    readonly real = false,
  ) {}
  add(lo: number, hi: number, w: number): void {
    // lo/hi are unsigned short, w is int (MuPDF table)
    this.entries.push({ lo: uint16(lo), hi: uint16(hi), w: this.real ? w : w | 0 });
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
  /** If entries with the same lo have different widths, the order can differ from MuPDF (unstable qsort) */
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
  /** dvmtx.x is not used (overwritten with hmtx.w / 2 on lookup) */
  constructor(
    readonly dy: number,
    readonly dw: number,
  ) {}
  add(lo: number, hi: number, x: number, y: number, w: number): void {
    // x, y, w are C short
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
    // v = dvmtx; v.x = h.w / 2 (C int division, short assignment)
    return { w: int16(this.dw), x: int16(Math.trunc(h.lookup(cid) / 2)), y: int16(this.dy) };
  }
}

// ---------------------------------------------------------------- CMap

const cs = (n: number, low: number, high: number): CodespaceRange => ({ n, low, high });

/** Code → CID. -1 = no mapping */
interface CMapSpec {
  codespaces: CodespaceRange[];
  wmode: 0 | 1;
  lookup(code: number): number;
  unresolved: string[];
  /** Whether it contains a placeholder mapping where the CID is the code itself (predefined CMap) */
  placeholder: boolean;
}

/** pdf_decode_cmap applied repeatedly over the whole byte sequence. If no codespace matches, code 0, length 1 */
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

/** Range map where the later range in definition order wins (same result as MuPDF's splay tree) */
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

/** Predefined CMap (by name). null = a name MuPDF cannot read */
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

/** Tokenizes the CMap body (PostScript subset). Hex strings as a big-endian integer and byte count */
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
      // Hex string: with an odd number of digits, the last nibble goes in the high bits (PDF rule)
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

/** pdf_parse_cmap: interprets only codespacerange, cidrange, cidchar, WMode and usecmap (bf* etc. are skipped) */
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
 * pdf_load_embedded_cmap. Observed MuPDF behavior:
 * - If the body has no codespace but has mapping ranges, 2-byte <0000>-<FFFF> is added.
 * - usecmap (body name, dictionary /UseCMap) is applied after parsing and inherits only when the codespace is empty. Ignored if the name cannot be read.
 * - A numeric /WMode in the dictionary overrides the body WMode.
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

// ---------------------------------------------------------------- Standard 14 fonts (pdf_load_builtin_font)

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
 * pdf_clean_font_name: the standard name if in the table (whitespace-insensitive comparison), otherwise null.
 * Unlike the source (skip_subset_prefix), measuring on 1.28.1 WASM shows the "ABCDEF+" prefix is not stripped ("ABCDEF+Arial" → no table match).
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

/** Flag classification of pdf_lookup_substitute_font + pdf_load_system_font */
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

/** ft_width: FT_Get_Advance * 1000 / upem (C int). advanceGlyph is a value divided in float32, so round down after correcting for the noise */
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
 * Widths per 256 codes of a built-in font face. Glyphs are found by name → Unicode (AGL) → font Unicode cmap,
 * and if not found fall back to the built-in encoding (StandardEncoding for text fonts, a measured table for Symbol and ZapfDingbats).
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
          // .notdef is filtered out by the name lookup (ft_name_index > 0 check) even if the font has it, so the built-in glyph remains
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

// ---------------------------------------------------------------- Font implementation

interface FontParts {
  subtype: string | null;
  objectNumber: number | null;
  wmode: 0 | 1;
  type3Matrix: Matrix | null;
  unresolved: string[];
  fallbackReason?: string;
  h: HmtxTable;
  /** Spec width table (real). */
  hSpec: HmtxTable;
  v: VmtxTable | null;
  /** null = 1-byte simple font */
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
    advanceSpec(cid) {
      return p.hSpec.lookup(cid);
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

/** Signal for when MuPDF fails to load and substitutes hail-mary */
class LoadFailure extends Error {}

/** pdf_load_simple_font. If dict = null, hail-mary (no BaseFont, no Widths) */
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

  // Font selection: standard name → that font; unknown name + no descriptor → Times-Roman; descriptor present → flag-based substitute font
  const clean = cleanFontName(basefont);
  const face = clean ?? (hasDescriptor ? substituteFace(basefont, flags) : 'Times-Roman');
  if (face === 'Symbol' || face === 'ZapfDingbats') flags |= FD_SYMBOLIC;
  const symbolic = (flags & FD_NONSYMBOLIC) !== 0 ? false : (flags & FD_SYMBOLIC) !== 0;

  const h = new HmtxTable(Math.trunc(missingWidth));
  const hSpec = new HmtxTable(missingWidth, true);
  let gids: number[] | undefined;
  const widths = get('Widths');
  if (has(widths)) {
    let first = toInt(get('FirstChar'));
    let last = toInt(get('LastChar'));
    if (first < 0 || last > 255 || first > last) first = last = 0;
    for (let i = 0; i < last - first + 1; i++) {
      h.add(i + first, i + first, arrInt(widths, i));
      hSpec.add(i + first, i + first, arrReal(widths, i));
    }
  } else if (embedded) {
    unresolved.add(
      '임베디드 폰트 + /Widths 없음: 폰트 파일 글리프 폭 해석 불가(MissingWidth 로 대체)',
    );
  } else {
    // Encoding
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
      for (let i = 0; i < 256; i++) {
        h.add(i, i, r.widths[i]!);
        hSpec.add(i, i, r.widths[i]!);
      }
    } catch (e) {
      unresolved.add(`내장 글꼴 ${face} 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  h.end();
  hSpec.end();
  return {
    subtype,
    objectNumber: null,
    wmode: 0,
    type3Matrix: null,
    unresolved: [...unresolved],
    h,
    hSpec,
    v: null,
    cmap: null,
    ...(gids ? { gids } : {}),
  };
}

/** Width part of pdf_load_type3_font */
function buildType3(dict: mupdf.PDFObject): FontParts {
  if (!has(dict.get('Encoding'))) throw new LoadFailure('Type3 /Encoding 없음');
  const widths = dict.get('Widths');
  const charprocs = dict.get('CharProcs');
  // The two checks above come after reading FirstChar/LastChar in MuPDF, but either way the load fails
  if (!has(widths)) throw new LoadFailure('Type3 /Widths 없음');
  if (!has(charprocs)) throw new LoadFailure('Type3 /CharProcs 없음');

  // pdf_dict_get_matrix: identity if not an array; if an array, reads 6 entries as reals (missing entries 0)
  const fm = dict.get('FontMatrix');
  const m: Matrix = fm.isArray()
    ? ([0, 1, 2, 3, 4, 5].map((i) => f32(arrReal(fm, i))) as Matrix)
    : [1, 0, 0, 1, 0, 0];

  const h = new HmtxTable(0);
  const hSpec = new HmtxTable(0, true);
  let first = toInt(dict.get('FirstChar'));
  let last = toInt(dict.get('LastChar'));
  if (first < 0 || last > 255 || first > last) first = last = 0;
  for (let i = first; i <= last; i++) {
    // float w = a * w * 1000 (all float32), truncated by pdf_add_hmtx(int)
    const w = f32(f32(m[0] * f32(arrReal(widths, i - first))) * 1000);
    h.add(i, i, Math.trunc(w));
    hSpec.add(i, i, m[0] * arrReal(widths, i - first) * 1000);
  }
  h.end();
  hSpec.end();
  return {
    subtype: 'Type3',
    objectNumber: null,
    wmode: 0,
    type3Matrix: m,
    unresolved: [],
    h,
    hSpec,
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
  const hSpec = new HmtxTable(dwObj.isNumber() ? toReal(dwObj) : 1000, true);
  const w = dfont.get('W');
  if (has(w)) {
    const n = w.length;
    for (let i = 0; i < n;) {
      const c0 = arrInt(w, i);
      const obj = w.get(i + 1);
      if (obj.isArray()) {
        const m = obj.length;
        for (let k = 0; k < m; k++) {
          h.add(c0 + k, c0 + k, arrInt(obj, k));
          hSpec.add(c0 + k, c0 + k, arrReal(obj, k));
        }
        i += 2;
      } else {
        const c1 = toInt(obj);
        h.add(c0, c1, arrInt(w, i + 2));
        hSpec.add(c0, c1, arrReal(w, i + 2));
        i += 3;
      }
    }
  }
  h.end();
  hSpec.end();
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

  // The CID of a predefined CMap is a placeholder. If widths are uniform regardless of CID (no W or all widths equal DW), the widths are exact.
  if (cmap.placeholder) {
    const uniformH = h.entries.every((e) => e.w === dw);
    const uniformV = wmode === 0 || (v !== null && v.entries.length === 0);
    if (!uniformH) unresolved.add('사전 정의 CMap 의 CID 를 몰라 /W 폭 조회가 부정확');
    else if (!uniformV) unresolved.add('사전 정의 CMap 의 CID 를 몰라 /W2 조회가 부정확');
    // If uniform, widths are the same regardless of the CID lookup result, so the CMap reason (no CID mapping table) does not affect widths
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
    hSpec,
    v,
    cmap,
  };
}

const SIMPLE_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType']);

/** Branch of pdf_load_font. The caller turns a load failure (LoadFailure) into hail-mary */
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
 * Document-level font cache. Keyed by indirect object number, and for a direct (resolved) object by the object itself.
 * For a direct object, if the pdf_obj is the same, the wasm pointer is the same even with different wrappers, so the pointer is used as the key and the wrapper is held to prevent pointer reuse.
 */
export class FontCache {
  private readonly byNumber = new Map<number, PdfFont>();
  private readonly byPointer = new Map<number, { obj: mupdf.PDFObject; font: PdfFont }>();
  private hailMary: PdfFont | null = null;

  constructor(readonly doc: mupdf.PDFDocument) {}

  /** fontObj = resolved /Font resource dictionary. If null, the MuPDF "hail mary" font (when there is no Tf resource) */
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
