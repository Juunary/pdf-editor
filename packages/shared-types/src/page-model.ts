/**
 * Extraction model (PLAN.md 3.4 "what is drawn where"). Built by core.
 *
 * Sequence number (seq) rules — SourceMap matching keys (docs/m1-contract.md section 3):
 * - Counted in the order Device callbacks arrive when `runPageContents` (excluding annotations) runs with the identity matrix.
 * - glyphSeq: 1 per displayed glyph. Counted at the first text callback to reach the Device (fillText, strokeText, clipText,
 *   clipStrokeText, ignoreText). fill→stroke (Tr 2, 6; consecutive with the same pointer) counts once, and the ET resend of
 *   Tr 4–7 clips is not counted. Auxiliary glyphs with gid -1 (ToUnicode 1 code → several code points) are not counted and are attached to the text of the
 *   preceding glyph. The resend detection key is bit-identical (font, gid, trm, ctm). Detection rules: docs/m1-contract.md 3.1.
 * - paintSeq: 1 per non-text drawing callback (fillPath, strokePath, clipPath, clipStrokePath, fillShade,
 *   fillImage, fillImageMask, clipImageMask). Fill+stroke (B, etc.) is 2 callbacks = 2 numbers.
 *   The BBox clipPath of a Form `Do` also counts 1. Callbacks between beginMask and endMask are not counted (contract section 3 detail table).
 */
import type { Matrix, Point, Quad, RGB, Rect } from './geometry.js';

export interface FontInfo {
  /** PageModel.fonts index. */
  id: number;
  /** MuPDF `Font.getName()` (including the subset tag, e.g. "ABCDEF+NotoSansKR"). */
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

/** Text render mode. Whether it clips is kept separately in CharInfo.clip. */
export type TextRender = 'fill' | 'stroke' | 'fill-stroke' | 'invisible';

export interface CharInfo {
  /** Glyph number in content execution order (0-based, rules above). SourceMap matching key. */
  glyphSeq: number;
  /**
   * Unicode. Ligatures and ToUnicode multi-mappings may yield several code points (the result of attaching gid -1 auxiliary glyphs).
   * U+FFFD if there is no mapping.
   */
  text: string;
  /** Font glyph ID (Device showGlyph). A gid -1 auxiliary glyph does not become a separate CharInfo. */
  gid: number;
  /** PageModel.fonts index. */
  fontId: number;
  /** Font size in page space (pt). */
  size: number;
  /** Baseline origin, page space. */
  origin: Point;
  /**
   * Character rectangle, page space. A structured-text value; if absent, core approximates it from the font size.
   * For a character with attached auxiliary glyphs, the union rectangle of the corresponding structured-text characters.
   */
  quad: Quad;
  /** Fill color (stroke color if stroke-only). null if it is a pattern color or unknown. */
  color: RGB | null;
  /** Tr 7 and resent glyphs under a disabled /OC are invisible; pattern-color text is fill (contract 3.1 notation table). */
  render: TextRender;
  /** Whether it is clip text (Tr 4–7). Core's classification follows the contract 3.1 notation table. */
  clip: boolean;
  /** 0 horizontal, 1 vertical. */
  wmode: 0 | 1;
  /** PageModel.lines index. -1 for characters absent from the structured text (e.g. some hidden text). */
  line: number;
}

/** Lines of the structured text. Array order = reading order (per MuPDF). */
export interface LineInfo {
  bbox: Rect;
  wmode: 0 | 1;
  /** Unit vector of the line direction. */
  dir: Point;
  /** PageModel.blocks index. */
  block: number;
  /** Characters of this line (PageModel.chars indices), in line order. */
  chars: number[];
  /**
   * Synthetic space positions. A value k means one space is inserted after `chars[k]` (0-based, ascending, no duplicates).
   * Contains only spaces without a Device glyph, such as spaces the structured text creates from TJ gaps (actual space glyphs are
   * in chars). Independent of glyphSeq and used only to assemble reading text (docs/m1-contract.md section 4).
   */
  spaceAfter: number[];
}

export interface BlockInfo {
  bbox: Rect;
  /** PageModel.lines index. */
  lines: number[];
}

/** Keeps both the original color space value and its sRGB approximation (M4 must write back in the original color space). */
export interface PaintColor {
  /** MuPDF color space name (e.g. "DeviceRGB", "DeviceCMYK", "ICCBased(...)", as obtained by core). */
  space: string;
  values: number[];
  rgb: RGB | null;
}

export type PathSegment =
  | { type: 'M'; p: Point }
  | { type: 'L'; p: Point }
  | { type: 'C'; p1: Point; p2: Point; p3: Point }
  | { type: 'Z' };

export interface PathInfo {
  paintSeq: number;
  op: 'fill' | 'stroke' | 'clip' | 'clip-stroke';
  evenOdd: boolean;
  /** Page-space bounds (including line width). */
  bbox: Rect;
  /** Path coordinates → page space. */
  ctm: Matrix;
  /** null if it is a clip. */
  color: PaintColor | null;
  alpha: number;
  /** Stroke kinds only. In path-space units. */
  lineWidth: number | null;
  /** Only when `ExtractRequest.includePathSegments` is set, in path-space coordinates. Otherwise null. */
  segments: PathSegment[] | null;
}

export interface ImageInfo {
  paintSeq: number;
  op: 'image' | 'image-mask' | 'clip-image-mask';
  /** Page-space bounds. */
  bbox: Rect;
  /** Unit square → page space. */
  ctm: Matrix;
  /** Pixel size. */
  width: number;
  height: number;
  alpha: number;
}

export interface ShadeInfo {
  paintSeq: number;
  /** Page-space bounds. */
  bbox: Rect;
  alpha: number;
}

export interface PageModel {
  pageIndex: number;
  /** `Page.getBounds()`, page space. */
  bounds: Rect;
  /** User space → page space (`PDFPage.getTransform()`). */
  userToPage: Matrix;
  /** /Rotate with inheritance applied (0, 90, 180, 270). */
  rotation: number;
  fonts: FontInfo[];
  /** Ascending glyphSeq. */
  chars: CharInfo[];
  lines: LineInfo[];
  blocks: BlockInfo[];
  /** Ascending paintSeq (within each array). */
  paths: PathInfo[];
  images: ImageInfo[];
  shades: ShadeInfo[];
  /** Total counted glyphs (normally equals chars.length). */
  glyphCount: number;
  /** Total counted drawing callbacks (normally equals the sum of the paths + images + shades lengths). */
  paintCount: number;
  /** Warnings during extraction (MuPDF warnings, use of approximations, etc.). */
  warnings: string[];
  extractMs: number;
}

export interface ExtractRequest {
  pageIndex: number;
  /** Whether to include path segments (can grow large for charts, so false by default). */
  includePathSegments?: boolean;
}
