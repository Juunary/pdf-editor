import * as mupdf from 'mupdf';
import type { PaintColor, RGB } from '@pdf-editor/shared-types';

/**
 * Converts the (color space, components) given by the Device callback into the original color space value and an sRGB approximation.
 *
 * The sRGB approximation is computed directly only for DeviceGray and DeviceRGB; for the rest (CMYK, ICC, Cal, Lab, Separation, DeviceN,
 * Indexed) a 1x1 pixmap is created in that color space and MuPDF's DeviceRGB conversion is used. It is the same conversion as the renderer,
 * so it matches the color seen on screen (server measurement: identical to CMYK, Separation and Indexed render results; Lab within ±1).
 */
export class ColorConverter {
  #cache = new Map<string, PaintColor>();
  /** Number of times conversion failed and rgb was left null (cache hits excluded). */
  failures = 0;

  /** The caller destroys `cs`. */
  paint(cs: mupdf.ColorSpace, values: readonly number[]): PaintColor {
    const space = cs.getName();
    const key = `${space}|${values.join(',')}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const type = cs.getType();
    const color: PaintColor = {
      space,
      // The callback value for Indexed is index ÷ 255. Convert it back to the original color space value (the index).
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
        // 8-bit pixmap encoding: Lab is L 0–100 -> 0–255, a and b −128..127 -> 0–255, everything else 0–1 -> 0–255.
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
