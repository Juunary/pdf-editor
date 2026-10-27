/**
 * Source link info (PLAN.md 3.4 "change only that part of the source"). Built by the pdf-ops content stream interpreter.
 * Also the matching result with the PageModel (PageLinkage). The sequence number rules are the same as in the page-model.ts header.
 */
import type { ByteRange, Matrix, Point } from './geometry.js';

/** A single content stream. */
export interface ContentStreamRef {
  /** Stream indirect object number. */
  objectNumber: number;
  /** Index in the page /Contents array (0 for a single stream). null for a Form XObject stream. */
  contentsIndex: number | null;
}

export interface ContentStreamInfo extends ContentStreamRef {
  /** Length after decoding (byte). ByteRange is relative to these bytes. */
  decodedLength: number;
  /** List of /Filter names (empty array if none). */
  filters: string[];
}

/** One step of a Form XObject usage path (one Do). */
export interface FormStep {
  /** Resource name of the Do operand. */
  resourceName: string;
  /** Which Do this is within the stream containing it (0-based). */
  doOrdinal: number;
  /** Object number of the target Form XObject. */
  objectNumber: number;
  /** The stream containing the Do. */
  stream: ContentStreamRef;
  /** Byte range of the Do's name operand (relative to that stream). */
  nameRange: ByteRange;
  /** CTM at the time of Do execution (before entering Form space, in user space). */
  ctm: Matrix;
}

export type SourceOpKind =
  | 'text-show' // Tj TJ ' "
  | 'text-state' // Tc Tw Tz TL Tf Tr Ts Td TD Tm T*
  | 'text-object' // BT ET
  | 'path-construct' // m l c v y h re
  | 'path-paint' // S s f F f* B B* b b* n
  | 'clip' // W W*
  | 'xobject' // Do
  | 'inline-image' // BI … EI
  | 'shading' // sh
  | 'graphics-state' // q Q cm w J j M d ri i gs
  | 'color' // CS cs SC SCN sc scn G g RG rg K k
  | 'marked-content' // BMC BDC EMC MP DP
  | 'compat' // BX EX
  | 'type3' // d0 d1
  | 'other';

/** Edit limit reasons (docs/m0-dod-xobject-redact-save.md 1.6 L1–L7 + font and text reasons). */
export const EDIT_LIMIT_REASONS = [
  'unmatched', // failed to match the PageModel
  'tokenizer-error', // L6 tokenization failure
  'spans-stream-boundary', // L6 operation straddles a /Contents stream boundary
  'form-inherits-resources', // L1 Form has no /Resources of its own
  'tagged-content', // L2 /StructParents and MCID (tagged PDF)
  'form-bbox-overflow', // L3 new text exceeds the Form BBox (decided at edit time)
  'outside-page-content', // L4 inside annotation appearances, patterns, Type3 glyphs or SMask
  'form-depth-exceeded', // L5 Form recursion depth exceeded or cycle
  'optional-content', // L7 optional content (warning)
  'type3-font', // Type3 font text
  'font-encoding-unresolved', // character code → Unicode/glyph mapping hard to recover (PLAN.md 3.3)
  'clip-text', // Tr 4–7
  'invisible-text', // Tr 3
  'inline-image', // BI … EI
] as const;

export type EditLimitReason = (typeof EDIT_LIMIT_REASONS)[number];

export interface SourceGlyph {
  /** Character code (per font encoding, 1–4 byte value). */
  code: number;
  /** Byte range of this code within the string token (the hex digit range for a hex string). */
  byteRange: ByteRange;
  /** Baseline origin, page space (after applying userToPage). Used for match verification. */
  origin: Point;
  /** glyphSeq. null for glyphs that never reach the Device or are not counted under contract section 3 rules (e.g. shown parts under a disabled /OC). */
  seq: number | null;
}

export interface TextShowInfo {
  /** Tf resource name. */
  fontResource: string;
  /** Font object number. null for a direct object. */
  fontObjectNumber: number | null;
  /** /Subtype (Type0, Type1, MMType1, TrueType, Type3). null if unknown. */
  fontSubtype: string | null;
  fontSize: number;
  /** Text matrix Tm right before the operator executes. */
  tm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  /** Tz/100. */
  horizontalScale: number;
  leading: number;
  rise: number;
  /** Tr 0–7. */
  renderMode: number;
  glyphs: SourceGlyph[];
  /** Text line matrix Tlm right before the operator executes (for M3 BT splitting; filled by the pdf-ops interpreter). */
  tlm?: Matrix;
}

/** Summary of the graphics state at operation execution time (for writing M3 edit blocks; filled by the pdf-ops interpreter). */
export interface SourceOpState {
  /** id of the effective fill color operator (cs, sc, scn, g, rg, k). null for the default. */
  fillColorOps: number[];
  /** id of the effective stroke color operator (M4). */
  strokeColorOps?: number[];
  /** id of the effective line width w operator (M4). */
  lineWidthOps?: number[];
  /** ids of effective gs operators (outer → inner). */
  extGStateOps: number[];
  /** Intersection of the active clips computed as rectangles (page space). null if any clip is non-rectangular. The page bounds if there is no clip. */
  clipRect: [number, number, number, number] | null;
}

/** Open marked content (outer → inner). */
export interface OpenMarkedContent {
  /** BMC/BDC operation id. */
  opId: number;
  tag: string;
  mcid: number | null;
  /** The properties contain /ActualText. */
  actualText: boolean;
  /** That BMC/BDC was opened inside BT. */
  insideText: boolean;
}

export interface SourceOp {
  /** SourceMap.ops index. */
  id: number;
  /** Operator keyword ("BI" for inline images). */
  op: string;
  kind: SourceOpKind;
  /** Stream where the operator starts. */
  stream: ContentStreamRef;
  /** From the start of the first operand to the end of the operator (relative to that stream's decoded bytes). */
  range: ByteRange;
  /** If inside a Form XObject, the Do path from the page to this stream. An empty array for page content. */
  formPath: FormStep[];
  /** CTM at execution time: this stream's content space → user space (including the Form /Matrix). */
  ctm: Matrix;
  /** Number of active clips regardless of q nesting (W n accumulated). */
  clipDepth: number;
  /** MCIDs of open marked content (outer → inner). For the tagging policy (PLAN.md 1.4). */
  mcids: number[];
  /** Whether inside optional content (/OC). */
  optionalContent: boolean;
  /** Only when kind = text-show. */
  text?: TextShowInfo;
  /**
   * [min, max + 1) of this operation's glyph seq. It may not be contiguous because of numbers assigned at ET time (Tr 7, etc.), so
   * use text.glyphs[].seq for per-character values. Omitted if no glyph received a number.
   */
  glyphSeq?: [number, number];
  /**
   * paintSeqs produced by path-paint, inline-image, xobject (image, Form BBox clip) and shading.
   * The numbers of cell content on the direct-execution path of a tiling pattern are included in that pattern's paint operation (contract section 3 detail table).
   */
  paintSeq?: number[];
  /** Limit reasons when editing this operation. An empty array if none. */
  limits: EditLimitReason[];
  /** M3: summary of the graphics state at execution time (filled by the pdf-ops interpreter). */
  state?: SourceOpState;
  /** M3: open marked content (details of mcids, filled by the pdf-ops interpreter). */
  markedContent?: OpenMarkedContent[];
  /** M4: ids of the construction operators (m, l, c, re, etc.) that make up a paint or clip operation. */
  pathOps?: number[];
  /** M4: byte ranges of numeric and name operands. */
  operandRanges?: ByteRange[];
}

export interface SourceMapError {
  stream: ContentStreamRef;
  /** Decoded byte offset. */
  offset: number;
  message: string;
}

export interface SourceMap {
  pageIndex: number;
  /** User space → page space (`PDFPage.getTransform()`). */
  userToPage: Matrix;
  /** Streams executed by this page (in page /Contents order, then Form streams in order of first appearance). */
  streams: ContentStreamInfo[];
  /** Execution order. Operations inside a Form XObject are expanded right after their Do operation. */
  ops: SourceOp[];
  /** Total glyphSeq counted by the interpreter. Must equal PageModel.glyphCount. */
  glyphCount: number;
  /** Total paintSeq counted by the interpreter. Must equal PageModel.paintCount. */
  paintCount: number;
  errors: SourceMapError[];
  buildMs: number;
}

export interface LinkStats {
  chars: number;
  matchedChars: number;
  paints: number;
  matchedPaints: number;
  /** Maximum origin error of matched characters (pt, page space). */
  maxOriginError: number;
  /** Difference in totals between PageModel and SourceMap (model − map). 0 is normal. */
  glyphCountDelta: number;
  paintCountDelta: number;
}

/** PageModel ↔ SourceMap matching result. Array indices match the same-named arrays in PageModel. */
export interface PageLinkage {
  pageIndex: number;
  /** chars[i] → SourceOp.id. -1 on failure. */
  charOp: number[];
  /** chars[i] → text.glyphs index of that operation. -1 on failure. */
  charGlyph: number[];
  /** paths[i] → SourceOp.id. -1 on failure. */
  pathOp: number[];
  imageOp: number[];
  shadeOp: number[];
  stats: LinkStats;
  linkMs: number;
}
