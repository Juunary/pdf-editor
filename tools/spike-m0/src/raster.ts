import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';
import type { PlacedGlyph } from './layout.js';

export interface Raster {
  width: number;
  height: number;
  /** RGB */
  pixels: Uint8ClampedArray;
}

export interface TextOverlay {
  font: mupdf.Font;
  fontSize: number;
  glyphs: PlacedGlyph[];
  /** Glyph coordinate space → PDF user space (glyphs placed in Form space). Default identity matrix */
  matrix?: mupdf.Matrix;
}

/**
 * Renders a page as RGB. If overlay is given, draws glyphs directly with fz Text on the same device.
 * overlay is used to build a "reference render" drawn straight from the font file without going through a PDF.
 * With `contentsOnly`, annotations and widgets are left out and only page content is drawn (for comparing against
 * the reference render in documents where an annotation appearance overlaps the new text).
 */
export function renderPage(
  page: mupdf.Page,
  scale: number,
  overlay?: TextOverlay | readonly TextOverlay[],
  options: { contentsOnly?: boolean } = {},
): Raster {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const b = mupdf.Rect.transform(page.getBounds(), matrix);
  const pix = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])],
    false,
  );
  try {
    pix.clear(255);
    const device = new mupdf.DrawDevice(matrix, pix);
    if (options.contentsOnly)
      (page as mupdf.PDFPage).runPageContents(device, mupdf.Matrix.identity);
    else page.run(device, mupdf.Matrix.identity);
    const overlays = overlay === undefined ? [] : Array.isArray(overlay) ? overlay : [overlay];
    for (const o of overlays as TextOverlay[]) {
      const text = new mupdf.Text();
      const m = o.matrix ?? mupdf.Matrix.identity;
      for (const g of o.glyphs) {
        text.showGlyph(
          o.font,
          mupdf.Matrix.concat([o.fontSize, 0, 0, o.fontSize, g.x, g.y], m),
          g.gid,
          g.unicode,
          0,
        );
      }
      const ctm = (page as mupdf.PDFPage).getTransform();
      device.fillText(text, ctm, mupdf.ColorSpace.DeviceRGB, [0, 0, 0], 1);
      text.destroy();
    }
    device.close();
    device.destroy();
    return { width: pix.getWidth(), height: pix.getHeight(), pixels: pix.getPixels().slice() };
  } finally {
    pix.destroy();
  }
}

export interface DiffResult {
  /** Number of pixels where any channel value differs */
  differing: number;
  /** Bounding rectangle of the differing pixels (pixel coordinates) */
  bbox: [number, number, number, number] | null;
}

/** Pixels inside `exclude` (pixel coordinates) are not counted. */
export function diffRasters(a: Raster, b: Raster, exclude?: Rect): DiffResult {
  if (a.width !== b.width || a.height !== b.height) throw new Error('크기 불일치');
  let differing = 0;
  let bbox: DiffResult['bbox'] = null;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (exclude && x >= exclude[0] && x < exclude[2] && y >= exclude[1] && y < exclude[3])
        continue;
      const i = (y * a.width + x) * 3;
      if (
        a.pixels[i] !== b.pixels[i] ||
        a.pixels[i + 1] !== b.pixels[i + 1] ||
        a.pixels[i + 2] !== b.pixels[i + 2]
      ) {
        differing++;
        bbox = bbox
          ? [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)]
          : [x, y, x, y];
      }
    }
  }
  return { differing, bbox };
}

/** Number of non-white pixels in a render result (for comparing the ink amount of the reference text). */
export function inkPixels(r: Raster, region?: Rect): number {
  let n = 0;
  const [x0, y0, x1, y1] = region ?? [0, 0, r.width, r.height];
  for (let y = Math.max(0, y0); y < Math.min(r.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(r.width, x1); x++) {
      const i = (y * r.width + x) * 3;
      if (r.pixels[i]! < 128 && r.pixels[i + 1]! < 128 && r.pixels[i + 2]! < 128) n++;
    }
  }
  return n;
}
