import { describe, expect, it } from 'vitest';
import { hexToRgb, pickerValue, rgbToHex } from '../src/path-colors.js';

describe('color conversion', () => {
  it('round-trips', () => {
    expect(rgbToHex([1, 0.5, 0])).toBe('#ff8000');
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(rgbToHex(hexToRgb('#12ab9f')!)).toBe('#12ab9f');
  });
  it('an invalid value is null, and no color means black', () => {
    expect(hexToRgb('red')).toBeNull();
    expect(pickerValue(null)).toBe('#000000');
    expect(pickerValue({ space: 'DeviceRGB', values: [0, 0, 1], rgb: [0, 0, 1] })).toBe('#0000ff');
  });
});
