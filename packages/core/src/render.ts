import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface RgbaRegion extends RgbaImage {
  /** Area actually rendered (page space). It is aligned to the pixel grid (integer device coordinates), so it may be wider than the requested clip. */
  clip: Rect;
}

/**
 * Renders the page with an opaque white background as RGBA. `scale` 1 = 72dpi.
 * Fills the alpha pixmap with 255 before drawing so it can be used directly as ImageData without premultiplied alpha conversion.
 */
export function renderPageRgba(page: mupdf.Page, scale: number): RgbaImage {
  const bbox = mupdf.Rect.transform(page.getBounds(), mupdf.Matrix.scale(scale, scale));
  return renderDeviceRect(page, scale, [
    Math.floor(bbox[0]),
    Math.floor(bbox[1]),
    Math.ceil(bbox[2]),
    Math.ceil(bbox[3]),
  ]);
}

/**
 * Renders only the `clip` area in page space (M3 edit preview, docs/m3-contract.md D7). Device coordinates use the same transform (`scale`) as a full-page render,
 * so the area's pixels equal the pixels at the same position in a full-page render, and the viewer only has to draw it over at the `clip * scale` position.
 * The area is cut at the page bounds and widened to outer integer device coordinates. `RangeError` if it does not overlap the page bounds.
 */
export function renderPageRegionRgba(page: mupdf.Page, scale: number, clip: Rect): RgbaRegion {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pageDevice = mupdf.Rect.transform(page.getBounds(), matrix);
  const want = mupdf.Rect.transform(clip, matrix);
  const rect: mupdf.Rect = [
    Math.floor(Math.max(want[0], pageDevice[0])),
    Math.floor(Math.max(want[1], pageDevice[1])),
    Math.ceil(Math.min(want[2], pageDevice[2])),
    Math.ceil(Math.min(want[3], pageDevice[3])),
  ];
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) {
    throw new RangeError(`clip 이 쪽 영역과 겹치지 않음: [${clip.join(', ')}]`);
  }
  const image = renderDeviceRect(page, scale, rect);
  return {
    ...image,
    clip: [rect[0] / scale, rect[1] / scale, rect[2] / scale, rect[3] / scale],
  };
}

/** Renders the integer device coordinate rectangle `rect` with the `scale` transform. */
function renderDeviceRect(page: mupdf.Page, scale: number, rect: mupdf.Rect): RgbaImage {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, rect, true);
  try {
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(matrix, pixmap);
    try {
      page.run(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const src = pixmap.getPixels();
    const rgba = new Uint8ClampedArray(width * height * 4);
    if (stride === width * 4) {
      rgba.set(src.subarray(0, rgba.length));
    } else {
      for (let y = 0; y < height; y++) {
        rgba.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
      }
    }
    return { width, height, rgba };
  } finally {
    pixmap.destroy();
  }
}
