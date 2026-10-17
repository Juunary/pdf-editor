import * as mupdf from 'mupdf';

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * 페이지를 불투명 흰 배경 RGBA 로 렌더한다. `scale` 1 = 72dpi.
 * 알파 픽스맵을 255 로 채운 뒤 그려 premultiplied 알파 변환 없이 ImageData 로 바로 쓸 수 있게 한다.
 */
export function renderPageRgba(page: mupdf.Page, scale: number): RgbaImage {
  const matrix = mupdf.Matrix.scale(scale, scale);
  const bbox = mupdf.Rect.transform(page.getBounds(), matrix);
  const rect: mupdf.Rect = [
    Math.floor(bbox[0]),
    Math.floor(bbox[1]),
    Math.ceil(bbox[2]),
    Math.ceil(bbox[3]),
  ];
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
