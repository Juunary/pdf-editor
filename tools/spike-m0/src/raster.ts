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
  /** 글리프 좌표 공간 → PDF 사용자 공간(Form 공간에 배치한 글리프). 기본 단위 행렬 */
  matrix?: mupdf.Matrix;
}

/**
 * 페이지를 RGB 로 렌더한다. overlay 가 있으면 같은 장치에 fz Text 로 글리프를 직접 그린다.
 * overlay 는 PDF 를 거치지 않고 폰트 파일에서 바로 그린 "참조 렌더" 를 만드는 데 쓴다.
 */
export function renderPage(
  page: mupdf.Page,
  scale: number,
  overlay?: TextOverlay | readonly TextOverlay[],
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
    page.run(device, mupdf.Matrix.identity);
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
  /** 채널 값이 하나라도 다른 픽셀 수 */
  differing: number;
  /** 차이 픽셀의 외접 사각형(픽셀 좌표) */
  bbox: [number, number, number, number] | null;
}

/** `exclude`(픽셀 좌표) 안의 픽셀은 세지 않는다. */
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

/** 렌더 결과에서 흰색이 아닌 픽셀 수(참조 텍스트 잉크량 비교용). */
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
