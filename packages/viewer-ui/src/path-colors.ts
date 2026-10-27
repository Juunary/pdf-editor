/** Conversion between the color picker (`<input type="color">`) value and sRGB 0–1 (contract D3: the color the user picks is sRGB). */
import type { PaintColor, RGB } from '@pdf-editor/shared-types';

const hex2 = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

export function rgbToHex(rgb: RGB): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** "#rrggbb" → sRGB. null if the format differs. */
export function hexToRgb(hex: string): RGB | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** Picker initial value: sRGB approximation of the color (black if none). */
export function pickerValue(color: PaintColor | null | undefined): string {
  return color?.rgb ? rgbToHex(color.rgb) : '#000000';
}
