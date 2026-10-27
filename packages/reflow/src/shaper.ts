/**
 * Shaper interface (contract D5). Takes consecutive clusters written with one font and returns the glyph and advance for each cluster.
 * Units are 1/1000 em (before multiplying by the font size).
 */
import type { EncodedGlyph, FontFace } from './index.js';
import { shapeOpenType } from './opentype.js';

export interface ShapedGlyph {
  gid: number;
  /** Code bytes for writing. For the original font, the font-encoding/CMap code; for a fallback font, a 2-byte gid (Identity-H). */
  code: Uint8Array;
  /** Layout advance (including kerning). */
  advance: number;
  /** Horizontal offset of the glyph origin (GPOS). */
  xOffset: number;
  /** PDF spec width (/Widths, /W). The write step corrects the difference from advance with TJ numbers. */
  pdfWidth: number;
}

export interface ShapedCluster {
  /** At least 1. */
  glyphs: ShapedGlyph[];
  /** Sum of cluster advances (including kerning). */
  advance: number;
  /** Kerning share of advance with the next cluster. Subtracted for the last cluster on a line. */
  kernAfter: number;
}

/** null for a cluster that cannot be written (the font has no glyph; not laid out, same as glyph-missing). */
export type ShapeResult = (ShapedCluster | null)[];

/** Shapes the list of consecutive clusters [start, end) of text. Within the same font and the same line-break range. */
export interface Shaper {
  shape(text: string, clusters: readonly (readonly [number, number])[]): ShapeResult;
}

/** Shaper for the font source. */
export function shaperFor(face: FontFace): Shaper {
  const source = face.source;
  if (source.kind === 'pdf-widths') return pdfWidthsShaper(source.encode);
  return {
    shape: (text, clusters) =>
      shapeOpenType(face.key, source.bytes, source.pdfWidth, text, clusters),
  };
}

/** Original font: place with the PDF spec width of the encode result and do not kern (contract D5). */
function pdfWidthsShaper(encode: (cluster: string) => EncodedGlyph[] | null): Shaper {
  return {
    shape(text, clusters) {
      return clusters.map(([s, e]) => {
        const encoded = encode(text.slice(s, e));
        if (encoded === null || encoded.length === 0) return null;
        let advance = 0;
        const glyphs = encoded.map((g) => {
          advance += g.width;
          return { gid: g.gid, code: g.code, advance: g.width, xOffset: 0, pdfWidth: g.width };
        });
        return { glyphs, advance, kernAfter: 0 };
      });
    },
  };
}
