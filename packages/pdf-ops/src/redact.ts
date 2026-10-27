import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

/** Arguments of `applyRedaction(black_boxes, image_method, line_art_method, text_method)`. */
export interface RedactionOptions {
  blackBoxes: boolean;
  imageMethod: number;
  lineArtMethod: number;
  textMethod: number;
}

/**
 * Redaction options for text replacement (PLAN.md 3.1): remove text, keep line art and images, no black boxes.
 * MuPDF defaults (black_boxes=true, remove image pixels, remove covered line art) do not fit the replacement use case.
 */
export const TEXT_REPLACE_REDACTION: Readonly<RedactionOptions> = Object.freeze({
  blackBoxes: false,
  imageMethod: mupdf.PDFPage.REDACT_IMAGE_NONE,
  lineArtMethod: mupdf.PDFPage.REDACT_LINE_ART_NONE,
  textMethod: mupdf.PDFPage.REDACT_TEXT_REMOVE,
});

export interface RedactionResult {
  appliedRects: Rect[];
  /** Number of Redact annotations already on the page before applying. This function does not apply them. */
  preexistingRedactAnnots: number;
}

export function countRedactAnnots(page: mupdf.PDFPage): number {
  return page.getAnnotations().filter((a) => a.getType() === 'Redact').length;
}

/**
 * Removes text inside the regions. `rects` are in MuPDF page coordinates (origin at top left).
 *
 * Page-level `applyRedactions()` also applies Redact annotations that were already in the document,
 * so only the newly created annotations are applied via the per-annotation `applyRedaction()`.
 */
export function redactRegions(
  page: mupdf.PDFPage,
  rects: readonly Rect[],
  options: Readonly<RedactionOptions> = TEXT_REPLACE_REDACTION,
): RedactionResult {
  const preexistingRedactAnnots = countRedactAnnots(page);
  for (const rect of rects) {
    const annot = page.createAnnotation('Redact');
    annot.setRect(rect);
    annot.applyRedaction(
      Number(options.blackBoxes),
      options.imageMethod,
      options.lineArtMethod,
      options.textMethod,
    );
  }
  return { appliedRects: rects.map((r) => [...r] as Rect), preexistingRedactAnnots };
}
