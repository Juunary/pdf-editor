/**
 * V6 (contract 6.1): checks that harfbuzzjs 1.6.2 (kern only) reads the bundled Noto Sans KR subset, that glyph advances equal the /W of MuPDF addFont
 * (allowing 1/1000 em rounding differences), and that output gids round-trip through ToUnicode. Results are in docs/m3-reflow.md section 3.
 */
import * as mupdf from 'mupdf';
import { beforeAll, describe, expect, it } from 'vitest';
import { layoutParagraph, type WritableGlyph } from '../src/index.js';
import { cmapPreimage, hmtxAdvance } from '../src/opentype.js';
import { classifyCluster, isDefaultIgnorable } from '../src/text.js';
import { format, notoBytes, notoFace, seg } from './helpers.js';

const bytes = notoBytes();

/** /W array -> cid -> width. */
function parseW(w: mupdf.PDFObject): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < w.length;) {
    const first = w.get(i).asNumber();
    const next = w.get(i + 1);
    if (next.isArray()) {
      for (let k = 0; k < next.length; k++) out.set(first + k, next.get(k).asNumber());
      i += 2;
    } else {
      const width = w.get(i + 2).asNumber();
      for (let c = first; c <= next.asNumber(); c++) out.set(c, width);
      i += 3;
    }
  }
  return out;
}

/** ToUnicode CMap (bfchar, bfrange) -> cid -> string. */
function parseToUnicode(cmap: string): Map<number, string> {
  const out = new Map<number, string>();
  const hex = (h: string) => parseInt(h, 16);
  const utf16 = (h: string) => {
    const units: number[] = [];
    for (let i = 0; i < h.length; i += 4) units.push(hex(h.slice(i, i + 4)));
    return String.fromCharCode(...units);
  };
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of (block[1] ?? '').matchAll(re)) {
      const lo = hex(m[1] ?? '0');
      const hi = hex(m[2] ?? '0');
      if (m[3] !== undefined) {
        const base = utf16(m[3]).codePointAt(0) ?? 0;
        for (let c = lo; c <= hi; c++) out.set(c, String.fromCodePoint(base + c - lo));
      } else {
        [...(m[4] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].forEach((it, k) =>
          out.set(lo + k, utf16(it[1] ?? '')),
        );
      }
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      out.set(hex(m[1] ?? '0'), utf16(m[2] ?? ''));
    }
  }
  return out;
}

const hmtx = (gid: number) => hmtxAdvance('fallback', bytes, gid);

let doc: mupdf.PDFDocument;
let fontRef: mupdf.PDFObject;
let widths: Map<number, number>;
let toUnicode: Map<number, string>;
let preimage: Map<number, number[]>;
/** Many-to-one cmap gids (ToUnicode returns only one code point). 0 since contract amendment 2. */
let conflicts: Map<number, number[]>;

beforeAll(() => {
  doc = new mupdf.PDFDocument();
  fontRef = doc.addFont(new mupdf.Font('NotoSansKR', bytes));
  const desc = fontRef.get('DescendantFonts').get(0);
  widths = parseW(desc.get('W'));
  toUnicode = parseToUnicode(fontRef.get('ToUnicode').readStream().asString());
  preimage = cmapPreimage('fallback', bytes);
  conflicts = new Map([...preimage].filter(([, cps]) => cps.length > 1));
});

/** Fallback font that uses /W as pdfWidth (same conditions as the write path). */
const face = () => notoFace((gid) => widths.get(gid) ?? 1000);

function layoutAll(text: string): WritableGlyph[] {
  return layoutParagraph({
    text,
    segments: [seg(face(), 0, text.length)],
    format: format({ area: [0, 0, 500, 100_000] }),
    areaLimit: [0, 0, 500, 100_000],
  }).lines.flat();
}

describe('V6 fallback font /W and ToUnicode', () => {
  it('MuPDF addFont is Identity-H CIDFontType2 (no CIDToGIDMap = Identity)', () => {
    const desc = fontRef.get('DescendantFonts').get(0);
    expect(fontRef.get('Encoding').asName()).toBe('Identity-H');
    expect(desc.get('Subtype').asName()).toBe('CIDFontType2');
    const map = desc.get('CIDToGIDMap');
    expect(map.isNull() || map.asName() === 'Identity').toBe(true);
  });

  it('/W of every glyph = harfbuzz hmtx advance (1/1000 em rounding allowed)', () => {
    expect(widths.size).toBe(16_966);
    let maxDiff = 0;
    for (let gid = 0; gid < 16_966; gid++) {
      const w = widths.get(gid);
      expect(w).toBeDefined();
      maxDiff = Math.max(maxDiff, Math.abs((w ?? 0) - hmtx(gid)));
    }
    expect(maxDiff).toBeLessThanOrEqual(1);
    // Measured (2026-10-19): difference 0.
    expect(maxDiff).toBe(0);
  });

  it('cmap is one-to-one and every cmap gid round-trips exactly through ToUnicode (contract amendment 2)', () => {
    expect(preimage.size).toBe(16_567);
    expect(conflicts.size).toBe(0);
    for (const [gid, cps] of preimage) {
      expect(toUnicode.get(gid)).toBe(String.fromCodePoint(cps[0] ?? 0));
    }
    // Characters that broke in the subset before amendment 2 (space -> U+00A0, hyphen -> U+2011, compatibility jamo -> half-width, unified Han -> compatibility Han).
    for (const ch of [' ', '-', 'ㄱ', 'ㅎ', '不', '串', '\u3000', '–', '～']) {
      expect(toUnicode.get(gidOfCp(ch.codePointAt(0) ?? 0))).toBe(ch);
    }
    // Excluded code points are not in the cmap (if input, glyph-missing; U+00A0 becomes a space in input normalization).
    for (const cp of [0x00a0, 0x00ad, 0x2011, 0x2003, 0x2012, 0x301c, 0xff40, 0xf967, 0xffa1]) {
      expect(gidOfCp(cp)).toBe(-1);
    }
  });

  it('layout output: every gid has a ToUnicode and round-trips exactly to its own cluster', () => {
    // Lay out every NFC-stable cmap character split one per forced line break (so they do not form clusters with neighboring characters).
    const chars = [...preimage.values()]
      .flat()
      .sort((a, b) => a - b)
      .map((cp) => String.fromCodePoint(cp))
      .filter((ch) => ch.normalize('NFC') === ch && classifyCluster(ch).cls !== 'BK');
    const text = chars.join('\n');
    const glyphs = layoutAll(text);
    const written = new Set(glyphs.map((g) => text.slice(g.offset, g.offset + g.length)));
    const mismatched: string[] = [];
    for (const g of glyphs) {
      const t = toUnicode.get(g.gid);
      expect(t).toBeDefined();
      const cluster = text.slice(g.offset, g.offset + g.length);
      if (t !== cluster) mismatched.push(cluster);
    }
    expect(mismatched).toEqual([]);
    // The only characters not written are default-ignorable characters (not written with the fallback font).
    const unwritten = chars.filter((ch) => !written.has(ch));
    expect(unwritten.every((ch) => isDefaultIgnorable(ch.codePointAt(0) ?? 0))).toBe(true);
    expect(glyphs.length).toBe(chars.length - unwritten.length);
  });

  it('MuPDF extraction round-trip (sample sentence): extracted text excluding whitespace-like characters = input', () => {
    const text = '한글 PDF 편집기 漢字 不可 ㄱㄴ “quote” — dash € ™ office fi To-day 2026';
    const glyphs = layoutAll(text);
    const H = 200;
    const ops = glyphs.map((g) => {
      const hex = [...g.code].map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${g.size} 0 0 ${g.size} ${g.x.toFixed(4)} ${(H - g.y).toFixed(4)} Tm <${hex}> Tj`;
    });
    const resources = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put('F1', fontRef);
    resources.put('Font', fonts);
    const page = doc.addPage([0, 0, 600, H], 0, resources, `BT /F1 1 Tf ${ops.join(' ')} ET`);
    doc.insertPage(-1, page);
    const out = doc
      .loadPage(doc.countPages() - 1)
      .toStructuredText('preserve-whitespace')
      .asText();
    const strip = (s: string) => s.replace(/\s+/g, '');
    expect(strip(out)).toBe(strip(text));
    // The space glyph is extracted as U+0020 (U+00A0 before amendment 2).
    expect(out).toContain(' ');
    expect(out).not.toContain('\u00A0');
  });
});

/** cmap code point -> gid. */
function gidOfCp(cp: number): number {
  for (const [gid, cps] of preimage) if (cps.includes(cp)) return gid;
  return -1;
}
