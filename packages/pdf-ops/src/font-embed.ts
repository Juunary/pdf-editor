import * as mupdf from 'mupdf';
import { glyphHex } from './text-ops.js';

/**
 * Font formats that cannot be handled as a fallback font. A fallback font is TrueType (glyf) only (PLAN.md section 2, P1).
 * - cff-outlines: CFF-based OpenType ('OTTO') or bare CFF. MuPDF 1.28.1 embeds it as FontFile3, and rendering and subsetting fail.
 * - no-fontfile2: the result inserted into a temporary document has no FontFile2 (other formats).
 */
export class UnsupportedFontError extends Error {
  constructor(
    readonly code: 'cff-outlines' | 'no-fontfile2',
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedFontError';
  }
}

/** Outline format as seen from the sfnt header. 'OTTO' = CFF OpenType, 01 00 04 = bare CFF header. */
export function fontOutlineFormat(
  bytes: Uint8Array | ArrayBuffer,
): 'truetype' | 'cff' | 'collection' | 'unknown' {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4) return 'unknown';
  const tag = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
  if (tag === '\x00\x01\x00\x00' || tag === 'true') return 'truetype';
  if (tag === 'OTTO') return 'cff';
  if (tag === 'ttcf') return 'collection';
  if (b[0] === 1 && b[1] === 0 && b[2]! >= 4) return 'cff';
  return 'unknown';
}

export interface EmbeddedFont {
  font: mupdf.Font;
  /** Indirect reference to the Type0 font dictionary. */
  ref: mupdf.PDFObject;
}

/**
 * Adds a font as Type0 (Identity-H) with the font bytes actually embedded (PLAN.md 3.3).
 * `addCJKFont` does not embed the font bytes, so it is not used. A fallback font is TrueType (glyf) only
 * (CFF OpenType renders broken in MuPDF 1.28.1, PLAN.md section 2, P1). The path that embeds without a subset is used by the M0 comparison measurement
 * (tools/spike-m0) to reproduce the CFF failure, so it is not blocked.
 *
 * Subset: if `subsetGids` is given, embeds the bytes with only those glyphs kept (`subsetFontBytes`). `doc.subsetFonts()`
 * is not called on a document being edited. MuPDF 1.28.1 re-subsets all fonts in the document and rounds the original simple font's
 * `/Widths` to integers, which changes how unedited pages render (docs/m0-corpus-recheck.md C1, A7-1).
 */
/**
 * Creates a `mupdf.Font` from bytes. When given a Uint8Array, mupdf.js creates a temporary `mupdf.Buffer` wrapper and leaves its release to the GC
 * (FinalizationRegistry), so in synchronous loops and repeated short sessions byte copies (about 4 MB for the fallback font) stay in the WASM heap (R-L3).
 * Build the buffer directly and release it right after the font holds its reference.
 */
export function fontFromBytes(name: string, bytes: Uint8Array | ArrayBuffer): mupdf.Font {
  const buffer = new mupdf.Buffer(bytes);
  try {
    return new mupdf.Font(name, buffer);
  } finally {
    buffer.destroy();
  }
}

export function embedFont(
  doc: mupdf.PDFDocument,
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  options: { subsetGids?: Iterable<number> } = {},
): EmbeddedFont {
  const data = options.subsetGids ? subsetFontBytes(name, bytes, options.subsetGids) : bytes;
  const font = fontFromBytes(name, data);
  return { font, ref: doc.addFont(font) };
}

/**
 * Subsets only the fallback font (A7-1). Embeds the font as Type0 (Identity-H) in a separate temporary document, draws only `gids`, then runs
 * `subsetFonts()` on that temporary document and returns the shrunk FontFile2 bytes. The document being edited is not touched.
 * MuPDF's CID TrueType subsetting keeps glyph ids (it only empties unused glyphs). So the gids of Identity-H content computed with the original font
 * stay valid with the subset font as well (pinned by tests).
 * TrueType (glyf) only: a CFF-based font throws `UnsupportedFontError('cff-outlines')`; if the result has no FontFile2,
 * `UnsupportedFontError('no-fontfile2')`.
 */
export function subsetFontBytes(
  name: string,
  bytes: Uint8Array | ArrayBuffer,
  gids: Iterable<number>,
): Uint8Array {
  if (fontOutlineFormat(bytes) === 'cff') {
    throw new UnsupportedFontError(
      'cff-outlines',
      `CFF 기반 폰트는 폴백 폰트로 쓸 수 없음(TrueType glyf 전용): ${name}`,
    );
  }
  const unique = [...new Set(gids)].filter((g) => g > 0).sort((a, b) => a - b);
  const temp = new mupdf.PDFDocument();
  const font = fontFromBytes(name, bytes);
  try {
    const ref = temp.addFont(font);
    const shown = unique.length > 0 ? `<${glyphHex(unique)}> Tj` : '';
    temp.insertPage(
      -1,
      temp.addPage([0, 0, 100, 100], 0, { Font: { F: ref } }, `BT /F 10 Tf 0 0 Td ${shown} ET`),
    );
    temp.subsetFonts();
    const file = ref.get('DescendantFonts').get(0).get('FontDescriptor').get('FontFile2');
    if (!file.isStream()) {
      throw new UnsupportedFontError('no-fontfile2', `서브셋 실패: FontFile2 없음(${name})`);
    }
    const buffer = file.readStream();
    try {
      return buffer.asUint8Array().slice();
    } finally {
      buffer.destroy();
    }
  } finally {
    font.destroy();
    temp.destroy();
  }
}

/** Codepoint for which the font has no glyph (`encodeCharacter` = 0). Whitespace excluded. */
export function missingCodepoints(font: mupdf.Font, text: string): number[] {
  const missing = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (/\s/.test(ch)) continue;
    if (font.encodeCharacter(cp) === 0) missing.add(cp);
  }
  return [...missing];
}
