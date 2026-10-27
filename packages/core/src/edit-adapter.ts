/**
 * Edit adapter: internal boundary of the pdf-ops and reflow edit functions that the core edit session calls (docs/m3-core.md section 3).
 * The default implementation calls the signatures fixed in the contract commit as is. Until S1 (pdf-ops) and S2 (reflow) are merged, those functions
 * throw an "M3 not implemented" exception, so core unit tests run with a fake adapter injected via `PdfSessionOptions.editAdapter`.
 */
import * as mupdf from 'mupdf';
import {
  FontManager,
  type FallbackFontSource,
  listEditBlocks,
  pathEditWarnings,
  planPageEditability,
  planParagraphEdit,
  planPathEdit,
  planPathEditability,
  prepareParagraphEdit,
  preparePathEdit,
  recordEditMetadata,
  releaseEdit,
  writeEditBlock,
  writePathEdit,
} from '@pdf-editor/pdf-ops';
import { layoutParagraph } from '@pdf-editor/reflow';
import type { EditWarning, Rect } from '@pdf-editor/shared-types';

export type {
  EditBlockRef,
  ParagraphEditContext,
  PreparedEdit,
  PreparedPathEdit,
  WriteResult,
} from '@pdf-editor/pdf-ops';

/**
 * Result of a path write. Adds to the pdf-ops signature (`{ bbox, writeMs }`) an optional field carrying warnings determined during the write (`color-space-changed`, `path-clipped`,
 * `table-rule-removed`; contract 4.2). The default adapter fills it from pdf-ops `pathEditWarnings`.
 * If the field is present (even as an empty array), the core approximate warnings (`pathCoreWarnings`) are not used; they are approximated only when it is absent.
 */
export type PathWriteResult = ReturnType<typeof writePathEdit> & { warnings?: EditWarning[] };

export interface EditAdapter {
  /** One per document. `fallback` is the fallback font bytes that core awaited in advance, plus the object embedded just before the journal is turned on (null before that). */
  createFonts(doc: mupdf.PDFDocument, fallback: FallbackFontSource): FontManager;
  planPageEditability: typeof planPageEditability;
  planParagraphEdit: typeof planParagraphEdit;
  prepareParagraphEdit: typeof prepareParagraphEdit;
  /** M4 path classification, planning, preparation and writing (docs/m4-contract.md 4.2–4.3). */
  planPathEditability: typeof planPathEditability;
  planPathEdit: typeof planPathEdit;
  preparePathEdit: typeof preparePathEdit;
  writePathEdit: (...args: Parameters<typeof writePathEdit>) => PathWriteResult;
  writeEditBlock: typeof writeEditBlock;
  listEditBlocks: typeof listEditBlocks;
  recordEditMetadata: typeof recordEditMetadata;
  /** Discards the pdf-ops draft state of one draft (editId) or of the whole document (R-L3). Does not change document content. */
  releaseEdit: typeof releaseEdit;
  layoutParagraph: typeof layoutParagraph;
  /**
   * Estimates the area (page space) of an edit block absent from the session log (a file made by another session). null if unknown.
   * The default implementation maps the block Form's /BBox (contract D3: areaLimit converted to user space) through the page transform.
   */
  blockBounds(doc: mupdf.PDFDocument, pageIndex: number, objectNumber: number): Rect | null;
}

/** Maps a block Form's /BBox through the page transform (user space -> page space). */
function formBoundsInPage(
  doc: mupdf.PDFDocument,
  pageIndex: number,
  objectNumber: number,
): Rect | null {
  const form = doc.newIndirect(objectNumber).resolve();
  const bbox = form.get('BBox');
  if (!bbox.isArray() || bbox.length < 4) return null;
  const values = [0, 1, 2, 3].map((i) => bbox.get(i).asNumber());
  if (values.some((v) => !Number.isFinite(v))) return null;
  const page = doc.loadPage(pageIndex);
  try {
    const [x0, y0, x1, y1] = mupdf.Rect.transform(
      [
        Math.min(values[0]!, values[2]!),
        Math.min(values[1]!, values[3]!),
        Math.max(values[0]!, values[2]!),
        Math.max(values[1]!, values[3]!),
      ],
      page.getTransform(),
    );
    return [x0, y0, x1, y1];
  } finally {
    page.destroy();
  }
}

export const defaultEditAdapter: EditAdapter = {
  createFonts: (doc, fallback) => new FontManager(doc, fallback),
  planPageEditability,
  planParagraphEdit,
  prepareParagraphEdit,
  planPathEditability,
  planPathEdit,
  preparePathEdit,
  // pdf-ops reports write warnings separately as `pathEditWarnings` (docs/m4-pdf-ops.md section 6 #4). Attach them to the return value here.
  writePathEdit: (ctx, prepared, edit) => ({
    ...writePathEdit(ctx, prepared, edit),
    warnings: pathEditWarnings(ctx, prepared),
  }),
  writeEditBlock,
  listEditBlocks,
  recordEditMetadata,
  releaseEdit,
  layoutParagraph,
  blockBounds: formBoundsInPage,
};
