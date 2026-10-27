/**
 * Basic geometry types.
 *
 * Distinguishes two coordinate systems (docs/m1-contract.md section 2).
 * - Page space: MuPDF page coordinates. Origin at the top-left of the page bounds, y pointing down, unit pt.
 *   Values already reflect `/Rotate` and box offsets. `Page.getBounds()`, structured text,
 *   and Device callbacks run with the identity matrix give values in this space. All geometry in PageModel is in this space.
 * - User space: the PDF default user space. Origin at the bottom-left, y pointing up. The CTM and text matrices of content streams
 *   map into this space. The user space → page space transform is `PDFPage.getTransform()`.
 */

/** Rectangle [x0, y0, x1, y1]. The space follows the field description (default: page space). Unit pt. */
export type Rect = [number, number, number, number];

/** Point [x, y]. */
export type Point = [number, number];

/** The four corners of a rectangle [ulx, uly, urx, ury, llx, lly, lrx, lry]. MuPDF Quad order (ul, ur, ll, lr). */
export type Quad = [number, number, number, number, number, number, number, number];

/** Affine matrix [a, b, c, d, e, f]. Point (x, y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

/** sRGB 0–1. */
export type RGB = [number, number, number];

/** Byte range [start, end). Relative to decoded stream bytes. */
export type ByteRange = [number, number];
