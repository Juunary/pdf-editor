/**
 * Source linkage generation and PageModel matching (PLAN.md 3.4, docs/m1-contract.md).
 *
 * The signatures of the two functions were fixed in the M1 contract commit. Only the main session changes signatures.
 * Implementation: content-interp.ts (interpreter, model at delivery time), link.ts (matching).
 */
import type * as mupdf from 'mupdf';
import type { PageLinkage, PageModel, SourceMap } from '@pdf-editor/shared-types';
import { buildSourceMapImpl, GLYPH_SEQ_POLICY } from './content-interp.js';
import { link } from './link.js';

export interface SourceMapOptions {
  /** Upper bound on Form XObject recursion depth (default 8). Exceeding it yields form-depth-exceeded (L5). */
  maxFormDepth?: number;
}

export interface LinkOptions {
  /** Origin tolerance accepted as a match (pt, page space, default 1). */
  originTolerance?: number;
}

/** Interprets the page content (including Form XObject recursion) in execution order and builds the source linkage. */
export function buildSourceMap(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  options: SourceMapOptions = {},
): SourceMap {
  return buildSourceMapImpl(doc, pageIndex, options.maxFormDepth ?? 8, GLYPH_SEQ_POLICY);
}

/**
 * Links PageModel characters and shapes to SourceMap operations using glyphSeq, paintSeq and origin.
 * Operations with an unpaired sequence number get `unmatched` added to map.ops[].limits.
 */
export function linkPage(model: PageModel, map: SourceMap, options: LinkOptions = {}): PageLinkage {
  return link(model, map, { originTolerance: options.originTolerance ?? 1, window: 64 });
}
