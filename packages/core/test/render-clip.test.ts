import { describe, expect, it } from 'vitest';
import { PdfSession } from '../src/index.js';
import { buildPdf } from './pdf-fixtures.js';

const CONTENT = [
  '0.9 0.9 0.2 rg 20 20 120 60 re f',
  '0 0 1 rg 150.3 40.7 90.4 33.1 re f',
  'BT /F1 14 Tf 0 g 12.5 150.25 Td (Region render check) Tj ET',
  'BT /F2 12 Tf 12.5 120.5 Td <0001000200030004> Tj ET',
].join('\n');

function open(rotate: 0 | 90 | 180 | 270 = 0): PdfSession {
  const s = new PdfSession();
  s.open(buildPdf([{ content: CONTENT, rotate }]));
  return s;
}

/** 전체 렌더의 [x0,y0,x1,y1) 정수 장치 영역을 잘라 낸다. */
function crop(full: { width: number; rgba: Uint8ClampedArray }, rect: number[]): Uint8ClampedArray {
  const [x0, y0, x1, y1] = rect as [number, number, number, number];
  const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) {
    out.set(
      full.rgba.subarray((y * full.width + x0) * 4, (y * full.width + x1) * 4),
      (y - y0) * (x1 - x0) * 4,
    );
  }
  return out;
}

describe('PdfSession.renderPage(clip)', () => {
  it.each([
    [0, 1],
    [0, 1.5],
    [0, 2],
    [90, 2],
    [270, 1.5],
  ] as const)('영역 픽셀 = 쪽 전체 렌더의 같은 위치 픽셀 (회전 %i, 배율 %f)', (rotate, scale) => {
    const s = open(rotate);
    const full = s.renderPage({ pageIndex: 0, scale });
    expect(full.clip).toBeNull();
    const region = s.renderPage({ pageIndex: 0, scale, clip: [10.2, 30.7, 120.4, 90.3] });
    expect(region.clip).not.toBeNull();
    const [cx0, cy0, cx1, cy1] = region.clip!;
    // 픽셀 격자: clip * scale 이 정수 장치 좌표.
    for (const v of [cx0 * scale, cy0 * scale, cx1 * scale, cy1 * scale]) {
      expect(Math.abs(v - Math.round(v))).toBeLessThan(1e-9);
    }
    expect([region.width, region.height]).toEqual([
      Math.round((cx1 - cx0) * scale),
      Math.round((cy1 - cy0) * scale),
    ]);
    expect(region.rgba.length).toBe(region.width * region.height * 4);
    const rect = [cx0 * scale, cy0 * scale, cx1 * scale, cy1 * scale].map(Math.round);
    expect(Array.from(region.rgba)).toEqual(Array.from(crop(full, rect)));
    s.close();
  });

  it('요청 영역을 포함하도록 바깥 정수 좌표로 넓힌다', () => {
    const s = open();
    const clip: [number, number, number, number] = [10.2, 30.7, 120.4, 90.3];
    const region = s.renderPage({ pageIndex: 0, scale: 2, clip });
    const [x0, y0, x1, y1] = region.clip!;
    expect(x0).toBeLessThanOrEqual(clip[0]);
    expect(y0).toBeLessThanOrEqual(clip[1]);
    expect(x1).toBeGreaterThanOrEqual(clip[2]);
    expect(y1).toBeGreaterThanOrEqual(clip[3]);
    expect(x1 - x0).toBeLessThan(clip[2] - clip[0] + 1);
    s.close();
  });

  it('쪽 경계로 자르고, 쪽과 겹치지 않으면 RangeError', () => {
    const s = open();
    const region = s.renderPage({ pageIndex: 0, scale: 2, clip: [-50, -50, 40, 30] });
    expect(region.clip).toEqual([0, 0, 40, 30]);
    expect([region.width, region.height]).toEqual([80, 60]);
    expect(() => s.renderPage({ pageIndex: 0, scale: 2, clip: [400, 10, 500, 50] })).toThrow(
      RangeError,
    );
    s.close();
  });

  it('쪽 전체 크기 clip 은 쪽 전체 렌더와 같다', () => {
    const s = open();
    const full = s.renderPage({ pageIndex: 0, scale: 1.5 });
    const region = s.renderPage({ pageIndex: 0, scale: 1.5, clip: [0, 0, 300, 200] });
    expect(region.clip).toEqual([0, 0, 300, 200]);
    expect(Array.from(region.rgba)).toEqual(Array.from(full.rgba));
    s.close();
  });
});
