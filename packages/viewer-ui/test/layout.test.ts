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
  it('축 정렬 quad 는 배율을 곱한 위치·크기, 회전 0', () => {
    const box = quadToCssBox(rectQuad(10, 20, 30, 12), 2);
    expect(box).toEqual({ left: 20, top: 40, width: 60, height: 24, rotation: 0 });
  });

  it('페이지 경계 원점을 뺀다', () => {
    const box = quadToCssBox(rectQuad(110, 220, 10, 10), 1, [100, 200]);
    expect([box.left, box.top]).toEqual([10, 20]);
  });

  it('90도 시계 방향 회전 quad: 길이는 회전 전 크기, rotation 90', () => {
    // 가로 10 × 세로 4 상자를 시계 방향 90도 돌린 모양: u 는 아래(0,10), v 는 왼쪽(-4,0)
    const quad = [50, 10, 50, 20, 46, 10, 46, 20] as const;
    const box = quadToCssBox([...quad], 1);
    expect(box.rotation).toBe(90);
    expect(box.width).toBeCloseTo(10);
    expect(box.height).toBeCloseTo(4);
    expect([box.left, box.top]).toEqual([50, 10]);
  });

  it('180도 회전(위아래 뒤집힌 글자)', () => {
    const box = quadToCssBox([30, 30, 20, 30, 30, 20, 20, 20], 1);
    expect(box.rotation).toBe(180);
    expect(box.width).toBeCloseTo(10);
    expect(box.height).toBeCloseTo(10);
  });

  it('소수는 셋째 자리로 반올림한다', () => {
    const box = quadToCssBox(rectQuad(1 / 3, 2 / 3, 1, 1), 1);
    expect(box.left).toBe(0.333);
    expect(box.top).toBe(0.667);
  });
});

describe('cssBoxStyle', () => {
  it('회전이 없으면 transform 을 넣지 않는다', () => {
    const style = cssBoxStyle({ left: 1, top: 2, width: 3, height: 4, rotation: 0 });
    expect(style).toEqual({ left: '1px', top: '2px', width: '3px', height: '4px' });
  });

  it('회전과 추가 변환을 합친다', () => {
    const style = cssBoxStyle({ left: 1, top: 2, width: 3, height: 4, rotation: 30 }, 'scaleX(2)');
    expect(style.transform).toBe('rotate(30deg) scaleX(2)');
  });
});

describe('pageLayout · 배율', () => {
  it('오버레이 크기 = 비트맵 ÷ devicePixelRatio', () => {
    const layout = pageLayout({
      bounds: [0, 0, 600, 800],
      cssScale: 1.5,
      devicePixelRatio: 2,
      bitmap: { width: 1800, height: 2400 },
    });
    expect([layout.cssWidth, layout.cssHeight]).toEqual([900, 1200]);
    expect(renderScale(1.5, 2)).toBe(3);
  });

  it('dpr 이 0 이하이면 1 로 본다', () => {
    expect(renderScale(1.25, 0)).toBe(1.25);
    const layout = pageLayout({
      bounds: [0, 0, 100, 100],
      cssScale: 1,
      devicePixelRatio: 0,
      bitmap: { width: 100, height: 100 },
    });
    expect(layout.devicePixelRatio).toBe(1);
  });

  it('fitWidthScale: M0 규칙(여백 32, 하한 320, 최대 1.5)', () => {
    expect(fitWidthScale({ availableWidth: 1000, pageWidthPt: 600 })).toBe(1.5); // 968/600 > 1.5
    expect(fitWidthScale({ availableWidth: 500, pageWidthPt: 600 })).toBeCloseTo(468 / 600);
    expect(fitWidthScale({ availableWidth: 100, pageWidthPt: 600 })).toBeCloseTo(320 / 600);
    expect(fitWidthScale({ availableWidth: 500, pageWidthPt: 0 })).toBe(1);
  });

  it('cssToPage / pageToCss 는 서로 역변환', () => {
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

  it('cachedMeasure 는 같은 인자를 한 번만 측정한다', () => {
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

  it('줄·글자 순서 = 읽기 순서, 위치는 quad × 배율', () => {
    const lines = layoutTextLayer(model, order, layout);
    expect(lines.map((l) => l.chars.map((c) => c.text).join(''))).toEqual(['AB', 'C']);
    const [a, b] = lines[0]!.chars;
    expect(a!.style.left).toBe('40px'); // x 20 × 2
    expect(a!.style.top).toBe('40px');
    expect(b!.style.left).toBe('60px'); // x 30 × 2
    expect(a!.style.fontSize).toBe('24px'); // size 12 × 2
    expect(a!.style.lineHeight).toBe('28px'); // 높이 14 × 2
    expect(a!.style.transform).toBeUndefined();
    expect(lines[0]!.chars.map((c) => c.item)).toEqual([0, 1]);
    expect(lines[1]!.chars[0]!.item).toBe(2);
  });

  it('측정 함수가 있으면 quad 폭에 맞춰 scaleX', () => {
    // quad 폭 20px, 자연 폭 10px → scaleX(2)
    const lines = layoutTextLayer(model, order, layout, () => 10);
    expect(lines[0]!.chars[0]!.style.transform).toBe('scaleX(2)');
  });

  it('자연 폭과 같으면 transform 을 넣지 않는다', () => {
    const lines = layoutTextLayer(model, order, layout, () => 20);
    expect(lines[0]!.chars[0]!.style.transform).toBeUndefined();
  });

  it('측정값이 0 이면 scaleX 를 넣지 않는다', () => {
    const lines = layoutTextLayer(model, order, layout, () => 0);
    expect(lines[0]!.chars[0]!.style.transform).toBeUndefined();
  });

  it('회전 quad 는 rotate 와 scaleX 를 함께 쓴다', () => {
    const rotated = makePageModel(['A']);
    rotated.chars[0]!.quad = [50, 10, 50, 20, 46, 10, 46, 20];
    const lines = layoutTextLayer(rotated, buildReadingOrder(rotated), layout, () => 10);
    // 폭 10pt × 2 = 20px, 자연 폭 10px
    expect(lines[0]!.chars[0]!.style.transform).toBe('rotate(90deg) scaleX(2)');
  });
});

describe('quadFrame', () => {
  it('축 정렬 quad: 원점 ul, u=(1,0), v=(0,1), 길이 폭·높이', () => {
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

  it('폭 0 이면 높이 축에 수직으로, 둘 다 0 이면 기본 축', () => {
    const noWidth = quadFrame([5, 5, 5, 5, 5, 15, 5, 15]);
    expect([noWidth.ux, noWidth.uy, noWidth.lu]).toEqual([1, 0, 0]);
    const point = quadFrame([5, 5, 5, 5, 5, 5, 5, 5]);
    expect([point.ux, point.uy, point.vx, point.vy]).toEqual([1, 0, 0, 1]);
  });
});
