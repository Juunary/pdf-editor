/** 색 선택기(`<input type="color">`) 값과 sRGB 0–1 사이의 변환(계약 D3: 사용자가 고른 색은 sRGB). */
import type { PaintColor, RGB } from '@pdf-editor/shared-types';

const hex2 = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

export function rgbToHex(rgb: RGB): string {
  return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}

/** "#rrggbb" → sRGB. 형식이 다르면 null. */
export function hexToRgb(hex: string): RGB | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255];
}

/** 선택기 초기값: 색의 sRGB 근사(없으면 검정). */
export function pickerValue(color: PaintColor | null | undefined): string {
  return color?.rgb ? rgbToHex(color.rgb) : '#000000';
}
