import { describe, expect, it } from 'vitest';
import { hexToRgb, pickerValue, rgbToHex } from '../src/path-colors.js';

describe('색 변환', () => {
  it('왕복한다', () => {
    expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(rgbToHex(hexToRgb('#12ab9f')!)).toBe('#12ab9f');
  });
  it('잘못된 값은 null, 색이 없으면 검정', () => {
    expect(hexToRgb('red')).toBeNull();
    expect(pickerValue(null)).toBe('#000000');
    expect(pickerValue({ space: 'DeviceRGB', values: [0, 0, 1], rgb: [0, 0, 1] })).toBe('#0000ff');
  });
});
