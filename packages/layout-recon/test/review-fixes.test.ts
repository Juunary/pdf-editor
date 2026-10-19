/** M2 리뷰 지적(H1·M1·M2·M3·L5·L8) 회귀 시험. */
import { describe, expect, it } from 'vitest';
import { lineFeatures } from '../src/features.js';
import { summarizePaths } from '../src/paths.js';
import { reconstructPage } from '../src/reconstruct.js';
import { detectTables } from '../src/tables.js';
import { validateLayout as layoutViolations } from '../src/validate.js';
import { buildModel, lineSegments } from './helpers/model-builder.js';

const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');

describe('M2 리뷰 회귀', () => {
  it('H1: 병합 첫 열 셀 다음의 들여쓴 행이 있어도 줄은 한 셀에만 들어간다', () => {
    const paths = [
      ...[100, 120, 160, 180].map((y) => ({
        op: 'stroke' as const,
        segments: lineSegments([50, y], [500, y]),
        lineWidth: 0.5,
      })),
      { op: 'stroke' as const, segments: lineSegments([200, 140], [500, 140]), lineWidth: 0.5 },
      ...[50, 200, 350, 500].map((x) => ({
        op: 'stroke' as const,
        segments: lineSegments([x, 100], [x, 180]),
        lineWidth: 0.5,
      })),
    ];
    const lines = [
      { x: 55, y: 114, text: 'Name' },
      { x: 205, y: 114, text: 'Alpha' },
      { x: 355, y: 114, text: 'Beta' },
      { x: 205, y: 134, text: '11' },
      { x: 355, y: 134, text: '22' },
      { x: 55, y: 144, text: 'Category label text' },
      { x: 62, y: 174, text: 'sub item' },
      { x: 205, y: 174, text: '33' },
      { x: 355, y: 174, text: '44' },
    ];
    const model = buildModel({ lines, paths });
    const tables = detectTables(
      model,
      lineFeatures(model).filter((f) => f.horizontal),
      summarizePaths(model),
    );
    const all = tables.flatMap((t) => t.cells.flatMap((c) => c.lines));
    expect(new Set(all).size).toBe(all.length);
    expect(layoutViolations(model, reconstructPage(model))).toEqual([]);
  });

  it('M1: 회전 줄만 있는 쪽은 머리(섹션 탭)로 보지 않는다', () => {
    const m = buildModel({
      lines: Array.from({ length: 10 }, (_, i) => ({ x: 100 + i * 14, y: 400, text: words(6) })),
    });
    for (const ln of m.lines) {
      ln.dir = [0, -1];
      const b = ln.bbox;
      ln.bbox = [b[0], b[1] - 100, b[0] + 12, b[1]];
    }
    const l = reconstructPage(m);
    expect(l.paragraphs.every((p) => p.role === 'other')).toBe(true);
    expect(layoutViolations(m, l)).toEqual([]);
  });

  it('M2: 도형·표가 없으면 "Figure 3 shows…" 로 시작하는 문단은 캡션이 아니다', () => {
    const lines = [
      { x: 72, y: 100, text: words(12) + ' end' },
      { x: 72, y: 112, text: words(12) + ' done.' },
      { x: 87, y: 136, text: 'Figure 3 shows that the ' + words(8) },
      { x: 72, y: 148, text: words(12) + ' ok' },
      { x: 72, y: 160, text: words(6) + ' fin.' },
    ];
    const l = reconstructPage(buildModel({ lines }));
    expect(l.paragraphs.some((p) => p.role === 'caption')).toBe(false);
  });

  it('M3: 본문 뒤에 깔린 이미지는 본문 줄을 라벨로 흡수하지 않는다', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      x: 72,
      y: 100 + i * 14,
      text: words(13),
    }));
    const model = buildModel({ lines, images: [[60, 230, 560, 380]] });
    const l = reconstructPage(model);
    expect(l.paragraphs.filter((p) => p.figure !== null)).toHaveLength(0);
    expect(layoutViolations(model, l)).toEqual([]);
  });

  it('L5: 글자가 모두 위 띠에 있으면 머리로 보지 않는다', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 40, text: 'Annual Report Title Here' },
        { x: 72, y: 55, text: 'second line of title' },
      ],
      images: [[72, 200, 540, 700]],
    });
    const l = reconstructPage(model);
    expect(l.paragraphs.some((p) => p.role === 'header')).toBe(false);
  });

  it('L8: 열린 ㄷ자 선 경로는 사각형 4변이 아니라 선분 3개', () => {
    const model = buildModel({
      paths: [
        {
          op: 'stroke',
          segments: [
            { type: 'M', p: [100, 100] },
            { type: 'L', p: [300, 100] },
            { type: 'L', p: [300, 200] },
            { type: 'L', p: [100, 200] },
          ],
        },
      ],
    });
    expect(summarizePaths(model).rules).toHaveLength(3);
  });
});

describe('성능(병적 입력)', () => {
  it('같은 색 채움 상자 8,000개·곡선 경로 20,000개 쪽도 1초 안에 복원한다', () => {
    const paths = [];
    for (let i = 0; i < 8000; i++) {
      const x = 20 + (i % 100) * 5.5;
      const y = 20 + Math.floor(i / 100) * 9;
      paths.push({
        op: 'fill' as const,
        segments: [
          { type: 'M' as const, p: [x, y] as [number, number] },
          { type: 'L' as const, p: [x + 5, y] as [number, number] },
          { type: 'L' as const, p: [x + 5, y + 8] as [number, number] },
          { type: 'L' as const, p: [x, y + 8] as [number, number] },
          { type: 'Z' as const },
        ],
        color: [0.8, 0.8, 0.8] as [number, number, number],
      });
    }
    for (let i = 0; i < 20000; i++) {
      const x = 300 + (i % 20) * 3;
      const y = 20 + Math.floor(i / 20) * 0.7;
      paths.push({
        op: 'stroke' as const,
        segments: [
          { type: 'M' as const, p: [x, y] as [number, number] },
          {
            type: 'C' as const,
            p1: [x + 1, y] as [number, number],
            p2: [x + 1, y + 1] as [number, number],
            p3: [x + 2, y + 1] as [number, number],
          },
        ],
      });
    }
    const model = buildModel({ paths, lines: [{ x: 72, y: 760, text: words(8) }] });
    const t0 = performance.now();
    reconstructPage(model);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
