import * as mupdf from 'mupdf';
import type { PaintColor, RGB } from '@pdf-editor/shared-types';

/**
 * Device 콜백이 주는 (색공간, 성분) 을 원래 색공간 값과 sRGB 근사로 바꾼다.
 *
 * sRGB 근사는 DeviceGray·DeviceRGB 만 직접 계산하고, 나머지(CMYK·ICC·Cal·Lab·Separation·DeviceN·
 * Indexed)는 1×1 픽스맵을 그 색공간으로 만든 뒤 MuPDF 의 DeviceRGB 변환을 쓴다. 렌더러와 같은 변환이라
 * 화면에 보이는 색과 일치한다(서버 실측: CMYK·Separation·Indexed 렌더 결과와 동일, Lab 은 ±1).
 */
export class ColorConverter {
  #cache = new Map<string, PaintColor>();
  /** 변환에 실패해 rgb 를 null 로 둔 횟수(캐시 적중 제외). */
  failures = 0;

  /** 호출자가 `cs` 를 destroy 한다. */
  paint(cs: mupdf.ColorSpace, values: readonly number[]): PaintColor {
    const space = cs.getName();
    const key = `${space}|${values.join(',')}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const type = cs.getType();
    const color: PaintColor = {
      space,
      // Indexed 의 콜백 값은 인덱스 ÷ 255 다. 원래 색공간 값(인덱스)으로 돌려 둔다.
      values: type === 'Indexed' ? values.map((v) => Math.round(v * 255)) : [...values],
      rgb: this.#toRgb(cs, space, type, values),
    };
    this.#cache.set(key, color);
    return color;
  }

  #toRgb(
    cs: mupdf.ColorSpace,
    space: string,
    type: mupdf.ColorSpaceType,
    values: readonly number[],
  ): RGB | null {
    if (space === 'DeviceGray' && values.length === 1) return [values[0]!, values[0]!, values[0]!];
    if (space === 'DeviceRGB' && values.length === 3) return [values[0]!, values[1]!, values[2]!];
    if (type === 'None' || values.length === 0) return null;
    let pixmap: mupdf.Pixmap | null = null;
    let converted: mupdf.Pixmap | null = null;
    try {
      pixmap = new mupdf.Pixmap(cs, [0, 0, 1, 1], false);
      const pixel = pixmap.getPixels();
      values.forEach((v, i) => {
        // 8비트 픽스맵 인코딩: Lab 은 L 0–100 → 0–255, a·b −128..127 → 0–255, 그 외 0–1 → 0–255.
        pixel[i] = type === 'Lab' ? (i === 0 ? (v / 100) * 255 : v + 128) : Math.round(v * 255);
      });
      converted = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
      const out = converted.getPixels();
      return [out[0]! / 255, out[1]! / 255, out[2]! / 255];
    } catch {
      this.failures++;
      return null;
    } finally {
      converted?.destroy();
      pixmap?.destroy();
    }
  }
}
