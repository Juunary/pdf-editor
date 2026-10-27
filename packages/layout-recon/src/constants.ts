/**
 * Reconstruction constants (docs/m2-contract.md section 3). Tuned only against the accuracy harness dev set.
 * Lengths are in pt, *Em is a multiple of the line font size, *Ratio is a ratio.
 */
export const C = {
  /** Fill rectangles at or below this thickness are treated as rules. */
  thinBoxMax: 2,
  /** Header/footer band: relative to page height. */
  marginBand: 0.09,
  /** Minimum gap between header/footer and body (multiple of body font size). */
  marginGapEm: 1.2,
  /** Maximum gap for merging line fragments in the same row (multiple of font size). */
  rowJoinGapEm: 1.3,
  /** Local statistics window for paragraph splitting within a region: number of lines before and after the target line. */
  localHalfWindow: 4,
  /** Same-row check: vertical overlap is at least this ratio of the shorter height. */
  sameRowOverlap: 0.5,
  /** Region stacking: x overlap is at least this ratio of the narrower width. */
  stackOverlap: 0.5,
  /** Region stacking: upper bound on vertical gap (multiple of font size). */
  stackGapEm: 2.5,
  /** Paragraph split: line spacing exceeds this multiple of the region's reference spacing. */
  paraPitchRatio: 1.15,
  /** Indent check (multiple of font size). */
  indentEm: 0.5,
  /** Short line: ends earlier than the region's right baseline by this ratio (relative to region width). */
  shortLineRatio: 0.12,
  /** Heading: relative to body size. */
  headingSizeRatio: 1.15,
  /** Ratio of font size change that splits a paragraph. */
  sizeChangeRatio: 0.12,
  /** Minimum width of a vertical empty band for XY-cut. */
  gutterMin: 4,
  /** Figure: minimum image area (relative to page area). */
  imageMinArea: 0.005,
  /** Figure: minimum vector cluster area (relative to page area). */
  vectorMinArea: 0.01,
  /** Figure: vector cluster joining distance. */
  vectorJoin: 8,
  /** Figure: an image covering at least this ratio of the characters is treated as a background or scan. */
  backgroundCharRatio: 0.5,
} as const;
