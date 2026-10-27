/**
 * Font assignment (docs/m3-contract.md D4): per character (cluster), original font → fallback font → none (glyph-missing).
 *
 * Conditions for using the original font (all)
 * - (iv) Type1, MMType1, TrueType or Type0 (horizontal writing), loadable by MuPDF, with exact widths.
 * - (i) Character → code reverse mapping: ToUnicode (bfchar, bfrange) or the simple font Encoding (base encoding + Differences glyph names).
 *   With several candidates, the code used in the classification-time page state (SourceMap) is preferred (independent of session history, deterministic on reapply).
 *   Reverse-mapping keys are NFC; if absent, look up by base character + combining marks (NFD).
 * - (ii) For an embedded font, the glyph for that code is actually drawn (render probe: move the font to a temporary document and check the glyph id and ink).
 *   MuPDF/Word-style subsets only empty the outlines of unused glyphs, so the existence of a gid is not the criterion. Whitespace is excluded.
 * - (iii) Spec width > 0 (excluding combining marks).
 *
 * The fallback font (Noto Sans KR glyf subset, one-to-one cmap) is embedded by core once just before turning on the journal (outside the operation) (contract D4
 * amendment 1). FontManager does not embed it and only places the `FallbackFontSource.ref()` object by reference in the edit block Resources. Coverage is
 * determined by the font cmap, and widths, Ascent and Descent by the result of `addFont`ing the same bytes into a temporary document (/W, FontDescriptor). It is replaced
 * by a subset only inside a save operation.
 */
import * as mupdf from 'mupdf';
import type { EditWarning, SourceMap } from '@pdf-editor/shared-types';
import type { EncodedGlyph, FaceSource, FontFace, FontSegment } from '@pdf-editor/reflow';
import { fontFromBytes, subsetFontBytes } from './font-embed.js';
import {
  glyphNameToUnicode,
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  WIN_ANSI_ENCODING,
  type EncodingTable,
} from './glyph-names.js';
import { readStreamBytes, writeStreamBytes } from './mupdf-util.js';
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
const isMarkChar = (c: string) => /^\p{M}$/u.test(c);

/** Original font cluster classification: the glyph, and the combining marks left out when only the base character is used. */
interface Decision {
  glyphs: EncodedGlyph[];
  missing: string[];
}

interface CodeView {
  used: Set<number>;
  decided: Map<string, Decision | null>;
}

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

/** Reads bfchar and bfrange of a ToUnicode CMap into code → text. */
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
              // Spec: increment the last byte. In practice most generators increment the last UTF-16 unit, so that approach is used.
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

/** ToUnicode CMap body (2-byte codes, bfchar). */
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

// ---------------------------------------------------------------- Original font

function encodingTable(name: string): EncodingTable | null {
  if (name === 'StandardEncoding') return STANDARD_ENCODING;
  if (name === 'WinAnsiEncoding') return WIN_ANSI_ENCODING;
  if (name === 'MacRomanEncoding') return MAC_ROMAN_ENCODING;
  return null;
}

/** Glyph name → text. Table names, uniXXXX(…), uXXXX[XX]. */
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

/** Simple font Encoding → per-code text. null if unknown. */
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

/** Reverse-mapping and glyph classification cache for one original font. */
export class OriginalFont {
  readonly key: string;
  readonly pdf: PdfFont;
  readonly embedded: boolean;
  /** The reason if (iv) is not satisfied. */
  readonly unusable: string | null;
  readonly ascent: number;
  readonly descent: number;
  readonly face: FontFace;
  private readonly reverse = new Map<string, { code: number; bytes: Uint8Array }[]>();
  private readonly glyphOk = new Map<number, boolean>();
  /**
   * Candidate priority and classification per page state (SourceMap). The same SourceMap picks the same code regardless of session history
   * (reapply determinism, docs/m3-integration.md section 8 M3). Codes used on the page first built are not applied to another page or a later state.
   */
  private readonly views = new WeakMap<SourceMap, CodeView>();
  private readonly noMapView: CodeView = { used: new Set(), decided: new Map() };
  private view: CodeView = this.noMapView;
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
    // A whitespace glyph written as NBSP (MuPDF addFont ToUnicode) is also used as a space candidate.
    if (text === '\u00a0') this.addCodeFor(' ', code, bytes);
    this.addCodeFor(text, code, bytes);
  }

  private addCodeFor(text: string, code: number, bytes: Uint8Array): void {
    // Check that the code bytes match the font's code splitting (the ToUnicode codespace can differ from the font CMap).
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

  /**
   * Picks the page state to assign. With several candidates, the code used in this SourceMap (classification-time page state) is preferred. The same page
   * state gives the same result (the draft ctx and reapply ctx are both the pre-removal page state).
   */
  useMap(map: SourceMap | null, fontObjectNumber: number | null): void {
    if (!map || fontObjectNumber === null) {
      this.view = this.noMapView;
      return;
    }
    let v = this.views.get(map);
    if (!v) {
      v = { used: new Set(), decided: new Map() };
      for (const op of map.ops) {
        if (op.text?.fontObjectNumber !== fontObjectNumber) continue;
        for (const g of op.text.glyphs) v.used.add(g.code);
      }
      this.views.set(map, v);
    }
    this.view = v;
  }

  private candidates(text: string): { code: number; bytes: Uint8Array }[] {
    const list = this.reverse.get(text) ?? [];
    const used = this.view.used;
    return [...list].sort(
      (a, b) => Number(used.has(b.code)) - Number(used.has(a.code)) || a.code - b.code,
    );
  }

  /**
   * Ways to turn a cluster into codes (tried from the front). Reverse-mapping keys are NFC. If there is no NFC key or that glyph is absent, look up base character +
   * combining marks (NFD decomposition) separately. If the decomposition result is not combining marks, as with Hangul syllables, it is not decomposed.
   */
  private alternatives(t: string): string[][] {
    const nfc = t.normalize('NFC');
    const out: string[][] = [];
    if (this.reverse.has(nfc)) out.push([nfc]);
    const nfd = [...nfc.normalize('NFD')];
    if (nfd.length > 1 && nfd.slice(1).every(isMarkChar)) out.push(nfd);
    if (out.length === 0) out.push([...nfc]);
    return out;
  }

  private pick(p: string): EncodedGlyph | null {
    const ws = isWhitespaceCluster(p);
    const c = this.candidates(p).find(
      (e) => this.widthOk(e.code, p) && (ws || !this.embedded || this.glyphOk.get(e.code) === true),
    );
    if (!c) return null;
    const cid = this.pdf.cid(c.code);
    return { code: c.bytes, gid: cid, width: this.pdf.advanceSpec(cid) };
  }

  private widthOk(code: number, text: string): boolean {
    const cid = this.pdf.cid(code);
    if (cid < 0) return false;
    const w = this.pdf.advanceSpec(cid);
    if (w > 0) return true;
    const cp = text.codePointAt(0)!;
    return isCombining(cp);
  }

  /** Classifies clusters in advance (the needed glyphs in a single render probe). */
  prepare(texts: Iterable<string>): void {
    if (this.unusable !== null) return;
    const decided = this.view.decided;
    const pending = new Map<number, Uint8Array>();
    const plans: { text: string; alts: string[][] }[] = [];
    for (const t of new Set(texts)) {
      if (decided.has(t)) continue;
      const alts = this.alternatives(t);
      plans.push({ text: t, alts });
      if (!this.embedded || isWhitespaceCluster(t)) continue;
      for (const p of alts.flat()) {
        for (const c of this.candidates(p)) {
          if (!this.glyphOk.has(c.code) && this.widthOk(c.code, p)) pending.set(c.code, c.bytes);
        }
      }
    }
    if (pending.size > 0) this.probe([...pending.entries()]);
    for (const { text, alts } of plans) decided.set(text, this.decide(alts));
  }

  /**
   * If one way works entirely, that glyph. Otherwise, in a base character + combining mark decomposition where only the base character works, uses the base character and only the working
   * combining marks, and returns the remaining combining marks as missing (the base character is not dropped).
   */
  private decide(alts: string[][]): Decision | null {
    for (const parts of alts) {
      if (parts.length === 0) continue;
      const out: EncodedGlyph[] = [];
      for (const p of parts) {
        const g = this.pick(p);
        if (!g) break;
        out.push(g);
      }
      if (out.length === parts.length) return { glyphs: out, missing: [] };
    }
    const split = alts.find((a) => a.length > 1 && a.slice(1).every(isMarkChar));
    if (!split) return null;
    const base = this.pick(split[0]!);
    if (!base) return null;
    const glyphs = [base];
    const missing: string[] = [];
    for (const m of split.slice(1)) {
      const g = this.pick(m);
      if (g) glyphs.push(g);
      else missing.push(m);
    }
    return { glyphs, missing };
  }

  /** Original glyph of a cluster. Returns the base character glyph even when only some combining marks are missing (the missing ones are missingMarks). */
  encode(cluster: string): EncodedGlyph[] | null {
    if (cluster === '\n') return [];
    if (!this.view.decided.has(cluster)) this.prepare([cluster]);
    return this.view.decided.get(cluster)?.glyphs ?? null;
  }

  /** Combining marks that encode left out and returned (empty array if none). */
  missingMarks(cluster: string): string[] {
    if (cluster === '\n') return [];
    if (!this.view.decided.has(cluster)) this.prepare([cluster]);
    return this.view.decided.get(cluster)?.missing ?? [];
  }

  /**
   * Render probe: move the font dictionary into a temporary document, draw each code in one cell, then confirm the glyph id (0 = .notdef) with the Device and
   * the ink by rendering. Both must be present to be usable.
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
              // The trm origin is before CTM application (user space). Move it to device space (y down) to find the cell.
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

  /** For diagnostics and tests: classification of a code's glyph (probe result). undefined before classification. */
  glyphUsable(code: number): boolean | undefined {
    return this.glyphOk.get(code);
  }

  /** Releases the probe temporary document (R-L3). Safe to call repeatedly. If a probe is needed after release, the temporary document is recreated. */
  destroy(): void {
    this.probeFont?.destroy();
    this.probeFont = null;
    this.probeDoc?.destroy();
    this.probeDoc = null;
  }

  /** doc is for confirming the probe source (the original document). */
  get document(): mupdf.PDFDocument {
    return this.doc;
  }
}

// ---------------------------------------------------------------- Fallback font

/** Fallback font source (contract amendment 1, same shape as paragraph-edit.ts FallbackFontSource). */
export interface FallbackSource {
  bytes(): Uint8Array;
  ref(): mupdf.PDFObject | null;
}

/** Fallback font metrics (computed once from the bytes). */
interface FallbackMetrics {
  font: mupdf.Font;
  /** gid → /W width (1/1000 em, the value MuPDF addFont uses). */
  widths: PdfFont;
  face: FontFace;
}

/** One font state per document (body of FontManager). */
export class FontState {
  readonly cache: FontCache;
  private readonly originals = new Map<string, OriginalFont>();
  private metrics: FallbackMetrics | null | undefined;
  private disposed = false;
  /** Fallback gids used in edit blocks in this session (for the save subset). */
  readonly usedFallbackGids = new Set<number>();

  constructor(
    readonly doc: mupdf.PDFDocument,
    private readonly fallback: FallbackSource,
  ) {
    this.cache = new FontCache(doc);
  }

  original(style: ResolvedStyle, map: SourceMap | null): OriginalFont {
    this.assertLive();
    const ref = style.fontRef;
    const key = ref.isIndirect() ? `o:${ref.asIndirect()}` : `o:p${ref.resolve().pointer}`;
    let f = this.originals.get(key);
    if (!f) {
      f = new OriginalFont(this.doc, ref, this.cache.load(ref.resolve()), style.fontId);
      this.originals.set(key, f);
    }
    f.useMap(map, ref.isIndirect() ? ref.asIndirect() : null);
    return f;
  }

  originalByKey(key: string): OriginalFont | undefined {
    return this.originals.get(key);
  }

  /**
   * Fallback font metrics. calls addFont with the same bytes on a temporary document and reads /W, Ascent and Descent (the same
   * MuPDF function as core's embedFont, so the values are the same). null if the bytes cannot be obtained (no fallback).
   */
  private fallbackMetrics(): FallbackMetrics | null {
    this.assertLive();
    if (this.metrics !== undefined) return this.metrics;
    let bytes: Uint8Array;
    try {
      bytes = this.fallback.bytes();
    } catch {
      this.metrics = null;
      return null;
    }
    const font = fontFromBytes(FALLBACK_NAME, bytes);
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
      // PdfFont holds only the width table in JS, so the temporary document can be closed.
      tmp.destroy();
    }
    return this.metrics;
  }

  /**
   * Releases WASM resources (R-L3): the probe temporary document per original font, and the fallback `mupdf.Font`. Call once when closing the document or discarding the FontManager
   * (calling several times is fine). After release, assignment and fallback lookups throw. Document and edit block objects are not touched.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.originals.values()) f.destroy();
    this.originals.clear();
    this.metrics?.font.destroy();
    this.metrics = null;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('FontState 가 해제됨');
  }

  /** Fallback face (for assignment and layout). null if there is no fallback font. */
  fallbackFace(): FontFace | null {
    return this.fallbackMetrics()?.face ?? null;
  }

  /** Whether the fallback font has all code points of the cluster (font cmap). */
  fallbackHas(cluster: string): boolean {
    const f = this.fallbackMetrics()?.font;
    if (!f) return false;
    for (const ch of cluster) if (f.encodeCharacter(ch.codePointAt(0)!) <= 0) return false;
    return true;
  }

  /** Fallback font object placed in the document (for writing). null if core has not embedded it yet. */
  fallbackRef(): mupdf.PDFObject | null {
    return this.fallback.ref();
  }

  /**
   * Assignment (contract D4). The original if usable as the style source font (resolve) of runs[i], otherwise the fallback, and face null if neither.
   * A forced line break "\n" follows the font of the preceding span (no glyph).
   */
  assign(
    text: string,
    runs: readonly {
      text: string;
      style: {
        sourceChar: number;
        bold: boolean;
        italic: boolean;
        charSpacing?: number;
        horizontalScale?: number;
      };
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
      const charSpacing = run.style.charSpacing ?? 0;
      const horizontalScale = run.style.horizontalScale ?? 1;
      const cl = clusters(run.text);
      orig?.prepare(cl.map((c) => c.text).filter((t) => t !== '\n'));
      let prevFace: FontFace | null | undefined;
      for (const c of cl) {
        let face: FontFace | null;
        if (c.text === '\n') {
          face = prevFace ?? orig?.face ?? null;
        } else if (
          orig &&
          orig.unusable === null &&
          orig.encode(c.text) &&
          orig.missingMarks(c.text).length === 0
        ) {
          face = orig.face;
        } else if (this.fallbackHas(c.text)) {
          face = this.fallbackFace();
          if (face && !isWhitespaceCluster(c.text)) fallbackChars.add(c.text);
        } else if (orig && orig.unusable === null && orig.encode(c.text)) {
          // Only the combining marks are missing from both fonts: the base character is used from the original and only those combining marks are reported as missing.
          face = orig.face;
          for (const m of orig.missingMarks(c.text)) missingChars.add(m);
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
            ...(charSpacing !== 0 ? { charSpacing } : {}),
            ...(horizontalScale !== 1 ? { horizontalScale } : {}),
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
        count: fallbackChars.size,
        chars: [...fallbackChars].slice(0, 20).join(''),
        rects: [],
      });
    }
    if (missingChars.size > 0) {
      warnings.push({
        kind: 'glyph-missing',
        message: `원본·폴백 폰트 모두 글리프가 없어 쓰지 않는 글자: ${[...missingChars].slice(0, 20).join('')}`,
        count: missingChars.size,
        chars: [...missingChars].slice(0, 20).join(''),
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
   * Only inside a save operation (contract D9): replaces the fallback font with a subset keeping only the glyphs used in this session and changes the display to /Subset.
   * Discarding the operation reverts it.
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
    writeStreamBytes(file, sub);
    if (!file.get('Length1').isNull()) file.put('Length1', sub.byteLength);
    // ToUnicode and /W also keep only the used glyphs (the full-cmap ToUnicode is about 21 KB in the saved file).
    const tu = ref.resolve().get('ToUnicode');
    if (tu.isStream()) {
      const keep = parseToUnicode(readStreamBytes(tu)).filter((e) =>
        this.usedFallbackGids.has(e.code),
      );
      writeStreamBytes(tu, toUnicodeCMap(keep));
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
