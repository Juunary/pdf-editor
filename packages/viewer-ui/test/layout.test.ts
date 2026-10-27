import { describe, expect, it } from 'vitest';
import {
  cachedMeasure,
  cssBoxStyle,
  cssToPage,
  fitWidthScale,
  pageLayout,
  pageToCss,
  quadBounds,
  quadFrame,
  quadToCssBox,
  renderScale,
} from '../src/layout.js';
import { layoutTextLayer } from '../src/text-layout.js';
import { buildReadingOrder } from '../src/reading-order.js';
import { makePageModel, rectQuad } from './fixtures.js';

describe('quadToCssBox', () => {
  it('an axis-aligned quad gives the position and size multiplied by the scale, rotation 0', () => {
    const box = quadToCssBox(rectQuad(10, 20, 30, 12), 2);
    expect(box).toEqual({ left: 20, top: 40, width: 60, height: 24, rotation: 0 });
  });

  it('subtracts the page boundary origin', () => {
    const box = quadToCssBox(rectQuad(110, 220, 10, 10), 1, [100, 200]);
    expect([box.left, box.top]).toEqual([10, 20]);
  });

  it('90-degree clockwise rotated quad: length is the pre-rotation size, rotation 90', () => {
    // A 10 wide × 4 tall box rotated 90 degrees clockwise: u points down (0,10), v points left (-4,0)
    const quad = [50, 10, 50, 20, 46, 10, 46, 20] as const;
    const box = quadToCssBox([...quad], 1);
    expect(box.rotation).toBe(90);
    expect(box.width).toBeCloseTo(10);
    expect(box.height).toBeCloseTo(4);
    expect([box.left, box.top]).toEqual([50, 10]);
  });

  it('180-degree rotation (upside-down characters)', () => {
    const box = quadToCssBox([30, 30, 20, 30, 30, 20, 20, 20], 1);
    expect(box.rotation).toBe(180);
    expect(box.width).toBeCloseTo(10);
    expect(box.height).toBeCloseTo(10);
  });

  it('decimals are rounded to the third place', () => {
    const box = quadToCssBox(rectQuad(1 / 3, 2 / 3, 1, 1), 1);
    expect(box.left).toBe(0.333);
    expect(box.top).toBe(0.667);
  });
});

describe('cssBoxStyle', () => {
  it('no transform is added when there is no rotation', () => {
    const style = cssBoxStyle({ left: 1, top: 2, width: 3, height: 4, rotation: 0 });
    expect(style).toEqual({ left: '1px', top: '2px', width: '3px', height: '4px' });
  });

  it('combines rotation with an additional transform', () => {
    const style = cssBoxStyle({ left: 1, top: 2, width: 3, height: 4, rotation: 30 }, 'scaleX(2)');
    expect(style.transform).toBe('rotate(30deg) scaleX(2)');
  });
});

describe('pageLayout · scale', () => {
  it('overlay size = bitmap ÷ devicePixelRatio', () => {
    const layout = pageLayout({
      bounds: [0, 0, 600, 800],
      cssScale: 1.5,
      devicePixelRatio: 2,
      bitmap: { width: 1800, height: 2400 },
    });
    expect([layout.cssWidth, layout.cssHeight]).toEqual([900, 1200]);
    expect(renderScale(1.5, 2)).toBe(3);
  });

  it('a dpr of 0 or less is treated as 1', () => {
    expect(renderScale(1.25, 0)).toBe(1.25);
    const layout = pageLayout({
      bounds: [0, 0, 100, 100],
      cssScale: 1,
      devicePixelRatio: 0,
      bitmap: { width: 100, height: 100 },
    });
    expect(layout.devicePixelRatio).toBe(1);
  });

  it('fitWidthScale: M0 rule (margin 32, lower limit 320, maximum 1.5)', () => {
    expect(fitWidthScale({ availableWidth: 1000, pageWidthPt: 600 })).toBe(1.5); // 968/600 > 1.5
    expect(fitWidthScale({ availableWidth: 500, pageWidthPt: 600 })).toBeCloseTo(468 / 600);
    expect(fitWidthScale({ availableWidth: 100, pageWidthPt: 600 })).toBeCloseTo(320 / 600);
    expect(fitWidthScale({ availableWidth: 500, pageWidthPt: 0 })).toBe(1);
  });

  it('cssToPage / pageToCss are inverses of each other', () => {
    const layout = pageLayout({
      bounds: [10, 20, 610, 820],
      cssScale: 1.5,
      devicePixelRatio: 1,
      bitmap: { width: 900, height: 1200 },
    });
    const p = cssToPage(150, 300, layout);
    expect(p).toEqual([110, 220]);
    expect(pageToCss(p, layout)).toEqual([150, 300]);
  });

  it('quadBounds', () => {
    expect(quadBounds([5, 1, 9, 3, 4, 7, 8, 9])).toEqual([4, 1, 9, 9]);
  });

  it('cachedMeasure measures the same arguments only once', () => {
    let calls = 0;
    const m = cachedMeasure((t, px) => {
      calls++;
      return t.length * px;
    });
    expect(m('ab', 10)).toBe(20);
    expect(m('ab', 10)).toBe(20);
    expect(m('ab', 12)).toBe(24);
    expect(calls).toBe(2);
  });
});

describe('layoutTextLayer', () => {
  const model = makePageModel(['AB', 'C']);
  const order = buildReadingOrder(model);
  const layout = pageLayout({
    bounds: model.bounds,
    cssScale: 2,
    devicePixelRatio: 1,
    bitmap: { width: 1200, height: 1600 },
  });

  it('line and character order = reading order, position is quad × scale', () => {
    const lines = layoutTextLayer(model, order, layout);
    expect(lines.map((l) => l.chars.map((c) => c.text).join(''))).toEqual(['AB', 'C']);
    const [a, b] = lines[0]!.chars;
    expect(a!.style.left).toBe('40px'); // x 20 × 2
    expect(a!.style.top).toBe('40px');
    expect(b!.style.left).toBe('60px'); // x 30 × 2
    expect(a!.style.fontSize).toBe('24px'); // size 12 × 2
    expect(a!.style.lineHeight).toBe('28px'); // height 14 × 2
    expect(a!.style.transform).toBeUndefined();
    expect(lines[0]!.chars.map((c) => c.item)).toEqual([0, 1]);
    expect(lines[1]!.chars[0]!.item).toBe(2);
  });

  it('if a measure function exists, scaleX is fitted to the quad width', () => {
    // quad width 20px, natural width 10px → scaleX(2)
    const lines = layoutTextLayer(model, order, layout, () => 10);
    expect(lines[0]!.chars[0]!.style.transform).toBe('scaleX(2)');
  });

  it('no transform is added when equal to the natural width', () => {
    const lines = layoutTextLayer(model, order, layout, () => 20);
    expect(lines[0]!.chars[0]!.style.transform).toBeUndefined();
  });

  it('no scaleX is added when the measured value is 0', () => {
    const lines = layoutTextLayer(model, order, layout, () => 0);
    expect(lines[0]!.chars[0]!.style.transform).toBeUndefined();
  });

  it('a synthetic space is placed at the right end of the character, and null for a character that is not displayed', () => {
    const m = makePageModel([{ text: 'AB', spaceAfter: [0] }]);
    const lines = layoutTextLayer(m, buildReadingOrder(m), layout);
    const [a, b] = lines[0]!.chars;
    expect(a!.space).toEqual({ left: '60px', top: '40px', fontSize: '24px', lineHeight: '28px' });
    expect(b!.space).toBeNull();
  });

  it('the synthetic space of a rotated character is placed at the end in the rotation direction', () => {
    const m = makePageModel([{ text: 'AB', spaceAfter: [0] }]);
    m.chars[0]!.quad = [50, 10, 50, 20, 46, 10, 46, 20]; // 90 degrees clockwise, width 10pt
    const lines = layoutTextLayer(m, buildReadingOrder(m), layout);
    expect(lines[0]!.chars[0]!.space).toMatchObject({
      left: '100px',
      top: '40px', // 20 + width 20px
      transform: 'rotate(90deg)',
    });
  });

  it('a rotated quad uses rotate and scaleX together', () => {
    const rotated = makePageModel(['A']);
    rotated.chars[0]!.quad = [50, 10, 50, 20, 46, 10, 46, 20];
    const lines = layoutTextLayer(rotated, buildReadingOrder(rotated), layout, () => 10);
    // width 10pt × 2 = 20px, natural width 10px
    expect(lines[0]!.chars[0]!.style.transform).toBe('rotate(90deg) scaleX(2)');
  });
});

describe('quadFrame', () => {
  it('axis-aligned quad: origin ul, u=(1,0), v=(0,1), length is width/height', () => {
    expect(quadFrame(rectQuad(10, 20, 30, 12))).toEqual({
      ox: 10,
      oy: 20,
      ux: 1,
      uy: 0,
      vx: 0,
      vy: 1,
      lu: 30,
      lv: 12,
    });
  });

  it('with width 0, perpendicular to the height axis; with both 0, the default axis', () => {
    const noWidth = quadFrame([5, 5, 5, 5, 5, 15, 5, 15]);
    expect([noWidth.ux, noWidth.uy, noWidth.lu]).toEqual([1, 0, 0]);
    const point = quadFrame([5, 5, 5, 5, 5, 5, 5, 5]);
    expect([point.ux, point.uy, point.vx, point.vy]).toEqual([1, 0, 0, 1]);
  });
});
