import * as mupdf from 'mupdf';
import type { Rect } from '@pdf-editor/shared-types';

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface RgbaRegion extends RgbaImage {
  /** 실제로 렌더한 영역(페이지 공간). 픽셀 격자(정수 장치 좌표)에 맞춘 값이라 요청한 clip 보다 넓을 수 있다. */
  clip: Rect;
}

/**
 * 페이지를 불투명 흰 배경 RGBA 로 렌더한다. `scale` 1 = 72dpi.
 * 알파 픽스맵을 255 로 채운 뒤 그려 premultiplied 알파 변환 없이 ImageData 로 바로 쓸 수 있게 한다.
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
 * 페이지 공간의 `clip` 영역만 렌더한다(M3 편집 미리보기, docs/m3-contract.md D7). 장치 좌표는 쪽 전체 렌더와
 * 같은 변환(`scale`)을 쓰므로 영역의 픽셀은 쪽 전체 렌더의 같은 위치 픽셀과 같고, 뷰어는 `clip * scale` 위치에
 * 덧그리면 된다. 영역을 쪽 경계로 자르고 바깥 정수 장치 좌표로 넓힌다. 쪽 경계와 겹치지 않으면 `RangeError`.
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

/** 정수 장치 좌표 사각형 `rect` 를 `scale` 변환으로 렌더한다. */
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
