/**
 * Paragraph reflow (M3, docs/m3-contract.md 5.4, D5). It only does text shaping and line/glyph placement and does not serialize the PDF
 * (PLAN.md section 4). It depends on neither MuPDF nor the DOM. Font assignment (original/fallback) is decided and passed in by the pdf-ops FontManager.
 */
import type { ParagraphFormat, Rect, ReflowSummary } from '@pdf-editor/shared-types';
import { layout, OVERFLOW_TOLERANCE } from './layout.js';

export { KINSOKU_HEAD, KINSOKU_TAIL } from './text.js';
export { OPENTYPE_FEATURES_OFF } from './opentype.js';

/** Glyph(s) that write one cluster in the original font. Unit 1/1000 em. */
export interface EncodedGlyph {
  /** Character-code bytes for writing (per the font encoding / CMap). */
  code: Uint8Array;
  gid: number;
  /** PDF spec width (/Widths, /W; real number). */
  width: number;
}

/**
 * Font source. pdf-widths: the original font, laid out with PDF widths and no kerning.
 * opentype: the fallback font, shaped with harfbuzz with only kern enabled (contract D5). If an output gid is not in the cmap inverse, that cluster is
 * replaced with the cmap gid + hmtx width (every gid has a ToUnicode). The difference from pdfWidth (the /W that MuPDF addFont wrote) is corrected in the write step
 * with TJ.
 */
export type FaceSource =
  | {
      kind: 'pdf-widths';
      /** Glyph to write the cluster with this font. null if it cannot be written (FontManager must filter these out beforehand). */
      encode(cluster: string): EncodedGlyph[] | null;
    }
  | {
      kind: 'opentype';
      bytes: Uint8Array;
      /** PDF width of the gid (/W, 1/1000 em). */
      pdfWidth(gid: number): number;
    };

export interface FontFace {
  /** Same key for the same font (shaper cache / write-resource grouping). */
  key: string;
  kind: 'original' | 'fallback';
  /** PageModel FontInfo.id for the original font, null for a fallback. */
  fontId: number | null;
  /** 1/1000 em, positive above and negative below. */
  ascent: number;
  descent: number;
  source: FaceSource;
}

/** Text range [start, end) with a fixed font. runIndex is the TextRun index. */
export interface FontSegment {
  start: number;
  end: number;
  face: FontFace | null;
  /** Font size (pt). */
  size: number;
  runIndex: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  /** Letter spacing added per glyph (pt, RunStyle.charSpacing). 0 if absent. Spacing after the last glyph of a line is not included in the line width. */
  charSpacing?: number;
  /** Horizontal scale (RunStyle.horizontalScale, Tz/100). Multiplied into glyph advance and kerning. 1 if absent. */
  horizontalScale?: number;
}

export interface ReflowInput {
  /** String joining TextRun.text (NFC). Forced line break is "\n". */
  text: string;
  /** Covers text with no gaps. A null face means a range where neither the original nor the fallback has a glyph (glyph-missing, not written). */
  segments: FontSegment[];
  format: ParagraphFormat;
  /** Region upper limit (A7-4). */
  areaLimit: Rect;
}

/** Glyph for writing. The position is the baseline origin in page space (the write step computes TJ adjustments from position differences). */
export interface WritableGlyph {
  offset: number;
  length: number;
  faceKey: string;
  code: Uint8Array;
  gid: number;
  x: number;
  y: number;
  /** Font size (pt). */
  size: number;
  /** PDF width (1/1000 em). The viewer places the next glyph using this value. */
  pdfWidth: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  runIndex: number;
  /** Horizontal scale (FontSegment.horizontalScale). Omitted if 1. The write step uses it for `Tz` and TJ units. */
  horizontalScale?: number;
}

export interface ReflowResult {
  summary: ReflowSummary;
  /** Line order; within a line, left to right. Includes the glyph for trailing whitespace on a line (word separation on extraction, contract 5.4). There is no glyph-missing. */
  lines: WritableGlyph[][];
}

/** Same input gives the same result (contract 5.4 determinism, excluding summary.reflowMs). Rules are in docs/m3-reflow.md. */
export function layoutParagraph(input: ReflowInput): ReflowResult {
  return layout(input);
}

/**
 * Whether the layout box runs past the region upper limit and gets clipped (decides the overflow-clipped warning for an overflow blocked by the limit, contract 5.4). The tolerance is 0.5pt, the same as the overflow check.
 */
export function isOverflowClipped(summary: ReflowSummary, areaLimit: Rect): boolean {
  const [x0, y0, x1, y1] = summary.contentBox;
  const t = OVERFLOW_TOLERANCE;
  return (
    x0 < areaLimit[0] - t || y0 < areaLimit[1] - t || x1 > areaLimit[2] + t || y1 > areaLimit[3] + t
  );
}
