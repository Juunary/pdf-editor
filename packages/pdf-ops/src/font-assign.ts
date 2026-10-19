/**
 * 폰트 배정(docs/m3-contract.md D4): 글자(클러스터) 단위로 원본 폰트 → 폴백 폰트 → 없음(glyph-missing).
 *
 * 원본 폰트로 쓸 수 있는 조건(모두)
 * - (iv) Type1·MMType1·TrueType·Type0(가로쓰기), MuPDF 가 로드할 수 있고 폭이 정확함.
 * - (i) 문자 → 코드 역매핑: ToUnicode(bfchar·bfrange) 또는 단순 폰트 Encoding(기본 인코딩 + Differences 글리프 이름).
 *   후보가 여럿이면 이 쪽에서 쓰인 코드를 우선한다.
 * - (ii) 임베디드 폰트는 그 코드의 글리프가 실제로 그려진다(렌더 탐침: 임시 문서에 폰트를 옮겨 글리프 id 와 잉크를
 *   확인). MuPDF·Word 류 서브셋은 안 쓰는 글리프의 외곽선만 비우므로 gid 존재로 판정하지 않는다. 공백류는 제외.
 * - (iii) 명세 폭 > 0(결합 문자 제외).
 *
 * 폴백 폰트(Noto Sans KR glyf 서브셋, cmap 일대일)는 core 가 저널을 켜기 직전(작업 밖)에 한 번 넣는다(계약 D4
 * 수정 1). FontManager 는 넣지 않고 `FallbackFontSource.ref()` 객체만 편집 블록 Resources 에 참조로 둔다. 커버리지는
 * 폰트 cmap, 폭·Ascent·Descent 는 같은 바이트를 임시 문서에 `addFont` 한 결과(/W·FontDescriptor)로 정한다. 저장 작업
 * 안에서만 서브셋으로 바꾼다.
 */
import * as mupdf from 'mupdf';
import type { EditWarning, SourceMap } from '@pdf-editor/shared-types';
import type { EncodedGlyph, FaceSource, FontFace, FontSegment } from '@pdf-editor/reflow';
import { subsetFontBytes } from './font-embed.js';
import {
  glyphNameToUnicode,
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  WIN_ANSI_ENCODING,
  type EncodingTable,
} from './glyph-names.js';
import { readStreamBytes } from './mupdf-util.js';
import { FontCache, type PdfFont } from './pdf-fonts.js';
import type { ResolvedStyle } from './edit-style.js';

export const FALLBACK_NAME = 'NotoSansKR';
export const FALLBACK_KEY = 'fallback';

const SIMPLE = new Set(['Type1', 'MMType1', 'TrueType']);
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function clusters(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const s of segmenter.segment(text)) {
    out.push({ start: s.index, end: s.index + s.segment.length, text: s.segment });
  }
  return out;
}

export const isWhitespaceCluster = (c: string) => /^\s+$/u.test(c);
const isCombining = (cp: number) => /\p{M}/u.test(String.fromCodePoint(cp));

const hex = (b: Uint8Array) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- ToUnicode

interface ToUnicodeEntry {
  code: number;
  bytes: Uint8Array;
  text: string;
}

function utf16be(bytes: number[]): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i]! << 8) | bytes[i + 1]!);
  return String.fromCharCode(...units);
}

type CTok = { t: 'hex'; b: number[] } | { t: 'kw'; v: string } | { t: 'open' } | { t: 'close' };

function lexCMap(data: Uint8Array): CTok[] {
  const out: CTok[] = [];
  const n = data.length;
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
    const c = data[i]!;
    if (c <= 0x20) i++;
    else if (c === 0x25) while (i < n && data[i] !== 0x0a && data[i] !== 0x0d) i++;
    else if (c === 0x3c && data[i + 1] === 0x3c) i += 2;
    else if (c === 0x3e && data[i + 1] === 0x3e) i += 2;
    else if (c === 0x3c) {
      i++;
      const nib: number[] = [];
      while (i < n && data[i] !== 0x3e) {
        const h = hexv(data[i]!);
        if (h >= 0) nib.push(h);
        i++;
      }
      i++;
      if (nib.length % 2 === 1) nib.push(0);
      const b: number[] = [];
      for (let k = 0; k < nib.length; k += 2) b.push((nib[k]! << 4) | nib[k + 1]!);
      out.push({ t: 'hex', b });
    } else if (c === 0x5b) {
      out.push({ t: 'open' });
      i++;
    } else if (c === 0x5d) {
      out.push({ t: 'close' });
      i++;
    } else if (c === 0x28) {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        if (data[i] === 0x5c) i++;
        else if (data[i] === 0x28) depth++;
        else if (data[i] === 0x29) depth--;
        i++;
      }
    } else {
      let j = i;
      while (j < n && data[j]! > 0x20 && !'[]<>()/%{}'.includes(String.fromCharCode(data[j]!))) j++;
      if (j === i) j++;
      out.push({ t: 'kw', v: String.fromCharCode(...data.subarray(i, j)) });
      i = j;
    }
  }
  return out;
}

const codeOf = (b: number[]) => b.reduce((v, x) => ((v << 8) | x) >>> 0, 0);

/** ToUnicode CMap 의 bfchar·bfrange 를 코드 → 텍스트로 읽는다. */
export function parseToUnicode(data: Uint8Array): ToUnicodeEntry[] {
  const toks = lexCMap(data);
  const out: ToUnicodeEntry[] = [];
  const push = (src: number[], text: string) =>
    out.push({ code: codeOf(src), bytes: Uint8Array.from(src), text });
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t !== 'kw') continue;
    if (t.v === 'beginbfchar') {
      for (i++; i + 1 < toks.length; i += 2) {
        const a = toks[i]!;
        const b = toks[i + 1]!;
        if (a.t !== 'hex' || b.t !== 'hex') break;
        push(a.b, utf16be(b.b));
      }
      i--;
    } else if (t.v === 'beginbfrange') {
      for (i++; i + 2 < toks.length;) {
        const lo = toks[i]!;
        const hi = toks[i + 1]!;
        if (lo.t !== 'hex' || hi.t !== 'hex') break;
        const l = codeOf(lo.b);
        const h = codeOf(hi.b);
        const nbytes = lo.b.length;
        const third = toks[i + 2]!;
        const srcOf = (code: number) => {
          const b: number[] = [];
          for (let k = nbytes - 1; k >= 0; k--) b.unshift((code >>> (8 * (nbytes - 1 - k))) & 0xff);
          return b;
        };
        if (third.t === 'hex') {
          if (h >= l && h - l <= 0xffff) {
            const base = third.b;
            for (let code = l; code <= h; code++) {
              const dst = [...base];
              // 명세: 마지막 바이트를 늘린다. 실제로는 마지막 UTF-16 단위를 늘리는 생성기가 대부분이라 그 방식을 쓴다.
              const last = ((dst[dst.length - 2] ?? 0) << 8) | (dst[dst.length - 1] ?? 0);
              const v = last + (code - l);
              dst[dst.length - 2] = (v >> 8) & 0xff;
              dst[dst.length - 1] = v & 0xff;
              push(srcOf(code), utf16be(dst));
            }
          }
          i += 3;
        } else if (third.t === 'open') {
          let k = i + 3;
          let code = l;
          while (k < toks.length && toks[k]!.t === 'hex') {
            if (code <= h) push(srcOf(code), utf16be((toks[k] as { b: number[] }).b));
            code++;
            k++;
          }
          i = k + 1;
        } else break;
      }
      i--;
    }
  }
  return out;
}

/** ToUnicode CMap 본문(2바이트 코드, bfchar). */
export function toUnicodeCMap(entries: readonly ToUnicodeEntry[]): string {
  const hex4 = (n: number) => n.toString(16).padStart(4, '0');
  const utf16 = (t: string) =>
    Array.from({ length: t.length }, (_, i) => hex4(t.charCodeAt(i))).join('');
  const out = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo <</Registry(Adobe)/Ordering(UCS)/Supplement 0>> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    out.push(`${chunk.length} beginbfchar`);
    for (const e of chunk) out.push(`<${hex4(e.code)}> <${utf16(e.text)}>`);
    out.push('endbfchar');
  }
  out.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- 원본 폰트

function encodingTable(name: string): EncodingTable | null {
  if (name === 'StandardEncoding') return STANDARD_ENCODING;
  if (name === 'WinAnsiEncoding') return WIN_ANSI_ENCODING;
  if (name === 'MacRomanEncoding') return MAC_ROMAN_ENCODING;
  return null;
}

/** 글리프 이름 → 텍스트. 표 이름, uniXXXX(…), uXXXX[XX]. */
function nameToText(name: string): string | null {
  const u = glyphNameToUnicode(name);
  if (u !== null) return String.fromCodePoint(u);
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (uni) {
    const units: number[] = [];
    for (let i = 0; i < uni[1]!.length; i += 4) units.push(parseInt(uni[1]!.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  }
  const u2 = /^u([0-9A-F]{4,6})$/.exec(name);
  if (u2) return String.fromCodePoint(parseInt(u2[1]!, 16));
  return null;
}

/** 단순 폰트 Encoding → 코드별 텍스트. 알 수 없으면 null. */
function simpleEncodingTexts(dict: mupdf.PDFObject, symbolic: boolean): (string | null)[] | null {
  const names: (string | null)[] = new Array<string | null>(256).fill(null);
  const enc = dict.get('Encoding');
  let base: EncodingTable | null = null;
  if (enc.isName()) base = encodingTable(enc.asName());
  else if (enc.isDictionary()) {
    const b = enc.get('BaseEncoding');
    base = b.isName() ? encodingTable(b.asName()) : symbolic ? null : STANDARD_ENCODING;
  } else if (!symbolic) base = STANDARD_ENCODING;
  if (base) for (let i = 0; i < 256; i++) names[i] = base[i] ?? null;
  if (enc.isDictionary()) {
    const diff = enc.get('Differences');
    if (diff.isArray()) {
      let k = 0;
      for (let i = 0; i < diff.length; i++) {
        const item = diff.get(i);
        if (item.isNumber()) k = item.asNumber();
        else if (item.isName() && k >= 0 && k < 256) names[k++] = item.asName();
      }
    }
  }
  if (!base && !enc.isDictionary()) return null;
  return names.map((n) => (n ? nameToText(n) : null));
}

function descriptorOf(dict: mupdf.PDFObject): mupdf.PDFObject {
  const sub = dict.get('Subtype');
  if (sub.isName() && sub.asName() === 'Type0') {
    const d = dict.get('DescendantFonts');
    return d.isArray() && d.length > 0 ? d.get(0).get('FontDescriptor') : mupdf.PDFObject.Null;
  }
  return dict.get('FontDescriptor');
}

function isEmbedded(fd: mupdf.PDFObject): boolean {
  return !fd.isNull() && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.get(k).isStream());
}

/** 원본 폰트 1개의 역매핑·글리프 판정 캐시. */
export class OriginalFont {
  readonly key: string;
  readonly pdf: PdfFont;
  readonly embedded: boolean;
  /** (iv)를 만족하지 않으면 그 사유. */
  readonly unusable: string | null;
  readonly ascent: number;
  readonly descent: number;
  readonly face: FontFace;
  private readonly reverse = new Map<string, { code: number; bytes: Uint8Array }[]>();
  private readonly used = new Set<number>();
  private readonly glyphOk = new Map<number, boolean>();
  private readonly decided = new Map<string, EncodedGlyph[] | null>();
  private probeDoc: mupdf.PDFDocument | null = null;
  private probeFont: mupdf.PDFObject | null = null;

  constructor(
    private readonly doc: mupdf.PDFDocument,
    readonly ref: mupdf.PDFObject,
    pdf: PdfFont,
    fontId: number,
  ) {
    const dict = ref.resolve();
    this.pdf = pdf;
    this.key = ref.isIndirect() ? `o:${ref.asIndirect()}` : `o:p${dict.pointer}`;
    const fd = descriptorOf(dict);
    this.embedded = isEmbedded(fd);
    const ascent = fd.isNull() ? 0 : fd.get('Ascent').isNumber() ? fd.get('Ascent').asNumber() : 0;
    const descent = fd.isNull()
      ? 0
      : fd.get('Descent').isNumber()
        ? fd.get('Descent').asNumber()
        : 0;
    this.ascent = ascent > 0 ? ascent : 800;
    this.descent = descent < 0 ? descent : -200;
    this.unusable = this.usability(dict);
    if (this.unusable === null) this.buildReverse(dict, fd);
    const source: FaceSource = { kind: 'pdf-widths', encode: (c) => this.encode(c) };
    this.face = {
      key: this.key,
      kind: 'original',
      fontId,
      ascent: this.ascent,
      descent: this.descent,
      source,
    };
  }

  private usability(dict: mupdf.PDFObject): string | null {
    const st = this.pdf.subtype;
    if (st === 'Type3') return 'Type3 폰트';
    if (st !== 'Type0' && !(st && SIMPLE.has(st)))
      return `지원하지 않는 폰트 종류(${st ?? '알 수 없음'})`;
    if (this.pdf.fallbackReason !== undefined) return `MuPDF 대체 폰트(${this.pdf.fallbackReason})`;
    if (this.pdf.wmode === 1) return '세로쓰기 폰트';
    if (this.pdf.unresolved.length > 0) return `폭 불확실: ${this.pdf.unresolved.join('; ')}`;
    if (st === 'Type0') {
      const enc = dict.get('Encoding');
      if (enc.isName() && enc.asName() !== 'Identity-H' && dict.get('ToUnicode').isNull()) {
        return `역매핑할 수 없는 CMap(${enc.asName()})`;
      }
    }
    return null;
  }

  private addCode(text: string, code: number, bytes: Uint8Array): void {
    // NBSP 로 적힌 공백 글리프(MuPDF addFont ToUnicode)는 공백 후보로도 쓴다.
    if (text === '\u00a0') this.addCodeFor(' ', code, bytes);
    this.addCodeFor(text, code, bytes);
  }

  private addCodeFor(text: string, code: number, bytes: Uint8Array): void {
    // 코드 바이트가 폰트 코드 분할과 맞는지 확인한다(ToUnicode 코드스페이스가 폰트 CMap 과 다를 수 있다).
    const dec = this.pdf.decode(bytes);
    if (dec.length !== 1 || dec[0]!.code !== code) return;
    const list = this.reverse.get(text) ?? [];
    if (!list.some((e) => e.code === code)) list.push({ code, bytes });
    this.reverse.set(text, list);
  }

  private buildReverse(dict: mupdf.PDFObject, fd: mupdf.PDFObject): void {
    const tu = dict.get('ToUnicode');
    if (tu.isStream()) {
      for (const e of parseToUnicode(readStreamBytes(tu))) {
        if (e.text) this.addCode(e.text.normalize('NFC'), e.code, e.bytes);
      }
      return;
    }
    if (this.pdf.subtype === 'Type0') return;
    const flags = fd.isNull() ? 0 : fd.get('Flags').isNumber() ? fd.get('Flags').asNumber() : 0;
    const symbolic = (flags & (1 << 5)) === 0 && (flags & (1 << 2)) !== 0;
    const texts = simpleEncodingTexts(dict, symbolic);
    if (!texts) return;
    texts.forEach((t, code) => {
      if (t) this.addCode(t.normalize('NFC'), code, Uint8Array.of(code));
    });
  }

  /** 이 쪽에서 쓰인 코드(후보 우선순위). */
  noteUsedCodes(map: SourceMap, fontObjectNumber: number | null): void {
    if (fontObjectNumber === null) return;
    for (const op of map.ops) {
      if (op.text?.fontObjectNumber !== fontObjectNumber) continue;
      for (const g of op.text.glyphs) this.used.add(g.code);
    }
  }

  private candidates(text: string): { code: number; bytes: Uint8Array }[] {
    const list = this.reverse.get(text) ?? [];
    return [...list].sort(
      (a, b) => Number(this.used.has(b.code)) - Number(this.used.has(a.code)) || a.code - b.code,
    );
  }

  private widthOk(code: number, text: string): boolean {
    const cid = this.pdf.cid(code);
    if (cid < 0) return false;
    const w = this.pdf.advanceSpec(cid);
    if (w > 0) return true;
    const cp = text.codePointAt(0)!;
    return isCombining(cp);
  }

  /** 클러스터들을 미리 판정한다(필요한 글리프는 한 번의 렌더 탐침으로). */
  prepare(texts: Iterable<string>): void {
    if (this.unusable !== null) return;
    const pending = new Map<number, Uint8Array>();
    const plans: { text: string; parts: string[] }[] = [];
    for (const t of new Set(texts)) {
      if (this.decided.has(t)) continue;
      const parts = this.reverse.has(t) ? [t] : [...t];
      plans.push({ text: t, parts });
      if (!this.embedded || isWhitespaceCluster(t)) continue;
      for (const p of parts) {
        for (const c of this.candidates(p)) {
          if (!this.glyphOk.has(c.code) && this.widthOk(c.code, p)) pending.set(c.code, c.bytes);
        }
      }
    }
    if (pending.size > 0) this.probe([...pending.entries()]);
    for (const { text, parts } of plans) {
      const out: EncodedGlyph[] = [];
      let ok = parts.length > 0;
      for (const p of parts) {
        const ws = isWhitespaceCluster(p);
        const c = this.candidates(p).find(
          (e) =>
            this.widthOk(e.code, p) && (ws || !this.embedded || this.glyphOk.get(e.code) === true),
        );
        if (!c) {
          ok = false;
          break;
        }
        const cid = this.pdf.cid(c.code);
        out.push({ code: c.bytes, gid: cid, width: this.pdf.advanceSpec(cid) });
      }
      this.decided.set(text, ok ? out : null);
    }
  }

  encode(cluster: string): EncodedGlyph[] | null {
    if (cluster === '\n') return [];
    if (!this.decided.has(cluster)) this.prepare([cluster]);
    return this.decided.get(cluster) ?? null;
  }

  /**
   * 렌더 탐침: 임시 문서에 폰트 사전을 옮기고 코드마다 칸 하나에 그린 뒤, Device 로 글리프 id(0 = .notdef)를,
   * 렌더로 잉크를 확인한다. 둘 다 있어야 쓸 수 있다.
   */
  private probe(entries: [number, Uint8Array][]): void {
    if (!this.probeDoc) {
      this.probeDoc = new mupdf.PDFDocument();
      this.probeFont = this.probeDoc.graftObject(this.ref);
    }
    const tmp = this.probeDoc;
    const CELL = 40;
    const SIZE = 30;
    const cols = Math.ceil(Math.sqrt(entries.length));
    const rows = Math.ceil(entries.length / cols);
    const W = cols * CELL;
    const H = rows * CELL;
    const content = entries
      .map(([, b], i) => {
        const x = (i % cols) * CELL + 5;
        const y = H - (Math.floor(i / cols) * CELL + 30);
        return `BT /F ${SIZE} Tf 1 0 0 1 ${x} ${y} Tm <${hex(b)}> Tj ET`;
      })
      .join('\n');
    tmp.insertPage(-1, tmp.addPage([0, 0, W, H], 0, { Font: { F: this.probeFont } }, content));
    const index = tmp.countPages() - 1;
    const page = tmp.loadPage(index);
    const gids = new Array<number>(entries.length).fill(-1);
    try {
      const cellOf = (x: number, y: number) => {
        const col = Math.floor(x / CELL);
        const row = Math.floor(y / CELL);
        return row * cols + col;
      };
      const device = new mupdf.Device({
        fillText: (text, ctm, cs) => {
          text.walk({
            showGlyph: (_f, trm, gid) => {
              // trm 원점은 CTM 적용 전(사용자 공간)이다. 장치 공간(y 아래)으로 옮겨 칸을 찾는다.
              const x = trm[4] * ctm[0] + trm[5] * ctm[2] + ctm[4];
              const y = trm[4] * ctm[1] + trm[5] * ctm[3] + ctm[5];
              const k = cellOf(x, y - 10);
              if (k >= 0 && k < gids.length && gids[k] === -1) gids[k] = gid;
            },
          });
          text.destroy();
          cs.destroy();
        },
      });
      page.runPageContents(device, mupdf.Matrix.identity);
      device.close();
      device.destroy();
      const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, false);
      try {
        const pw = pix.getWidth();
        const ph = pix.getHeight();
        const px = pix.getPixels();
        entries.forEach(([code], k) => {
          const x0 = (k % cols) * CELL;
          const y0 = Math.floor(k / cols) * CELL;
          let ink = 0;
          for (let y = y0; y < Math.min(ph, y0 + CELL) && ink === 0; y++) {
            for (let x = x0; x < Math.min(pw, x0 + CELL); x++) {
              if (px[y * pw + x]! < 200) {
                ink++;
                break;
              }
            }
          }
          this.glyphOk.set(code, ink > 0 && gids[k]! > 0);
        });
      } finally {
        pix.destroy();
      }
    } finally {
      page.destroy();
      tmp.deletePage(index);
    }
  }

  /** 진단·테스트용: 코드의 글리프 판정(탐침 결과). 판정 전이면 undefined. */
  glyphUsable(code: number): boolean | undefined {
    return this.glyphOk.get(code);
  }

  destroy(): void {
    this.probeDoc?.destroy();
    this.probeDoc = null;
  }

  /** doc 은 탐침 출처(원본 문서) 확인용. */
  get document(): mupdf.PDFDocument {
    return this.doc;
  }
}

// ---------------------------------------------------------------- 폴백 폰트

/** 폴백 폰트 원천(계약 수정 1, paragraph-edit.ts FallbackFontSource 와 같은 모양). */
export interface FallbackSource {
  bytes(): Uint8Array;
  ref(): mupdf.PDFObject | null;
}

/** 폴백 폰트 지표(바이트에서 한 번 계산). */
interface FallbackMetrics {
  font: mupdf.Font;
  /** gid → /W 폭(1/1000 em, MuPDF addFont 가 쓰는 값). */
  widths: PdfFont;
  face: FontFace;
}

/** 문서당 하나의 폰트 상태(FontManager 본체). */
export class FontState {
  readonly cache: FontCache;
  private readonly originals = new Map<string, OriginalFont>();
  private metrics: FallbackMetrics | null | undefined;
  /** 이 세션에서 편집 블록에 쓴 폴백 gid(저장 서브셋용). */
  readonly usedFallbackGids = new Set<number>();

  constructor(
    readonly doc: mupdf.PDFDocument,
    private readonly fallback: FallbackSource,
  ) {
    this.cache = new FontCache(doc);
  }

  original(style: ResolvedStyle, map: SourceMap | null): OriginalFont {
    const ref = style.fontRef;
    const key = ref.isIndirect() ? `o:${ref.asIndirect()}` : `o:p${ref.resolve().pointer}`;
    let f = this.originals.get(key);
    if (!f) {
      f = new OriginalFont(this.doc, ref, this.cache.load(ref.resolve()), style.fontId);
      if (map) f.noteUsedCodes(map, ref.isIndirect() ? ref.asIndirect() : null);
      this.originals.set(key, f);
    }
    return f;
  }

  originalByKey(key: string): OriginalFont | undefined {
    return this.originals.get(key);
  }

  /**
   * 폴백 폰트 지표. 같은 바이트를 임시 문서에 addFont 해 /W·Ascent·Descent 를 읽는다(core 의 embedFont 와 같은
   * MuPDF 함수라 값이 같다). 바이트를 얻지 못하면 null(폴백 없음).
   */
  private fallbackMetrics(): FallbackMetrics | null {
    if (this.metrics !== undefined) return this.metrics;
    let bytes: Uint8Array;
    try {
      bytes = this.fallback.bytes();
    } catch {
      this.metrics = null;
      return null;
    }
    const font = new mupdf.Font(FALLBACK_NAME, bytes);
    const tmp = new mupdf.PDFDocument();
    try {
      const ref = tmp.addFont(font);
      const widths = new FontCache(tmp).load(ref.resolve());
      const fd = descriptorOf(ref.resolve());
      const asc = fd.get('Ascent').isNumber() ? fd.get('Ascent').asNumber() : 880;
      const desc = fd.get('Descent').isNumber() ? fd.get('Descent').asNumber() : -120;
      this.metrics = {
        font,
        widths,
        face: {
          key: FALLBACK_KEY,
          kind: 'fallback',
          fontId: null,
          ascent: asc,
          descent: desc,
          source: { kind: 'opentype', bytes, pdfWidth: (gid) => widths.advanceSpec(gid) },
        },
      };
    } finally {
      // PdfFont 는 폭 표만 JS 로 들고 있어 임시 문서를 닫아도 된다.
      tmp.destroy();
    }
    return this.metrics;
  }

  /** 폴백 face(배정·배치용). 폴백 폰트가 없으면 null. */
  fallbackFace(): FontFace | null {
    return this.fallbackMetrics()?.face ?? null;
  }

  /** 폴백 폰트가 클러스터의 모든 코드포인트를 갖는가(폰트 cmap). */
  fallbackHas(cluster: string): boolean {
    const f = this.fallbackMetrics()?.font;
    if (!f) return false;
    for (const ch of cluster) if (f.encodeCharacter(ch.codePointAt(0)!) <= 0) return false;
    return true;
  }

  /** 문서에 넣어 둔 폴백 폰트 객체(쓰기용). core 가 아직 넣지 않았으면 null. */
  fallbackRef(): mupdf.PDFObject | null {
    return this.fallback.ref();
  }

  /**
   * 배정(계약 D4). runs[i] 의 모양 원천 글꼴(resolve)로 쓸 수 있으면 원본, 아니면 폴백, 둘 다 없으면 face null.
   * 강제 줄바꿈 "\n" 은 앞 구간의 폰트를 따른다(글리프 없음).
   */
  assign(
    text: string,
    runs: readonly {
      text: string;
      style: { sourceChar: number; bold: boolean; italic: boolean };
    }[],
    resolve: (sourceChar: number) => ResolvedStyle | null,
    map: SourceMap | null,
  ): { segments: FontSegment[]; warnings: EditWarning[] } {
    const segments: FontSegment[] = [];
    const fallbackChars = new Set<string>();
    const missingChars = new Set<string>();
    let synthetic = false;
    let offset = 0;
    runs.forEach((run, runIndex) => {
      const style = resolve(run.style.sourceChar);
      const orig = style ? this.original(style, map) : null;
      const size = style?.size ?? 10;
      const cl = clusters(run.text);
      orig?.prepare(cl.map((c) => c.text).filter((t) => t !== '\n'));
      let prevFace: FontFace | null | undefined;
      for (const c of cl) {
        let face: FontFace | null;
        if (c.text === '\n') {
          face = prevFace ?? orig?.face ?? null;
        } else if (orig && orig.unusable === null && orig.encode(c.text)) {
          face = orig.face;
        } else if (this.fallbackHas(c.text)) {
          face = this.fallbackFace();
          if (face && !isWhitespaceCluster(c.text)) fallbackChars.add(c.text);
        } else face = null;
        if (face === null && c.text !== '\n') missingChars.add(c.text);
        prevFace = face;
        const isFallback = face?.kind === 'fallback';
        const sb = isFallback && run.style.bold;
        const si = isFallback && run.style.italic;
        if ((sb || si) && !isWhitespaceCluster(c.text)) synthetic = true;
        const last = segments.at(-1);
        const start = offset + c.start;
        const end = offset + c.end;
        if (
          last &&
          last.end === start &&
          last.runIndex === runIndex &&
          last.face?.key === face?.key &&
          (last.face === null) === (face === null) &&
          last.syntheticBold === sb &&
          last.syntheticItalic === si
        ) {
          last.end = end;
        } else {
          segments.push({
            start,
            end,
            face,
            size,
            runIndex,
            syntheticBold: sb,
            syntheticItalic: si,
          });
        }
      }
      offset += run.text.length;
    });
    if (offset !== text.length) {
      throw new Error(`assign: runs 텍스트 길이(${offset})와 text 길이(${text.length})가 다름`);
    }
    const warnings: EditWarning[] = [];
    if (fallbackChars.size > 0) {
      warnings.push({
        kind: 'font-fallback',
        message: `원본 폰트에 없는 글자 ${fallbackChars.size}종을 폴백 폰트로 씁니다: ${[...fallbackChars].slice(0, 20).join('')}`,
        rects: [],
      });
    }
    if (missingChars.size > 0) {
      warnings.push({
        kind: 'glyph-missing',
        message: `원본·폴백 폰트 모두 글리프가 없어 쓰지 않는 글자: ${[...missingChars].slice(0, 20).join('')}`,
        rects: [],
      });
    }
    if (synthetic) {
      warnings.push({
        kind: 'synthetic-style',
        message: '폴백 폰트로 쓴 굵게·기울임 구간은 합성(선 두께·기울기)으로 표시합니다.',
        rects: [],
      });
    }
    return { segments, warnings };
  }

  /**
   * 저장 작업(계약 D9) 안에서만: 폴백 폰트를 이 세션에서 쓴 글리프만 남긴 서브셋으로 바꾸고 표시를 /Subset 으로 바꾼다.
   * 작업을 버리면 되돌아간다.
   */
  finalizeForSave(): void {
    const ref = this.fallback.ref();
    let bytes: Uint8Array;
    try {
      bytes = this.fallback.bytes();
    } catch {
      return;
    }
    if (!ref || !ref.resolve().isDictionary()) return;
    const used = [...this.usedFallbackGids].filter((g) => g > 0).sort((a, b) => a - b);
    const desc = ref.resolve().get('DescendantFonts').get(0);
    const file = desc.get('FontDescriptor').get('FontFile2');
    if (!file.isStream()) return;
    const sub = subsetFontBytes(FALLBACK_NAME, bytes, used);
    file.writeStream(sub);
    if (!file.get('Length1').isNull()) file.put('Length1', sub.byteLength);
    // ToUnicode·/W 도 쓴 글리프만 남긴다(전체 cmap ToUnicode 가 저장 파일에 약 21 KB).
    const tu = ref.resolve().get('ToUnicode');
    if (tu.isStream()) {
      const keep = parseToUnicode(readStreamBytes(tu)).filter((e) =>
        this.usedFallbackGids.has(e.code),
      );
      tu.writeStream(toUnicodeCMap(keep));
    }
    const widths = new FontCache(this.doc).load(ref.resolve());
    const w = this.doc.newArray();
    for (const g of used) {
      const ws = this.doc.newArray();
      ws.push(widths.advanceSpec(g));
      w.push(g);
      w.push(ws);
    }
    desc.put('W', w);
  }
}
