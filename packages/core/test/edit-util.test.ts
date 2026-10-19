import { describe, expect, it } from 'vitest';
import type { EditWarning, PageLayout, ReflowSummary } from '@pdf-editor/shared-types';
import {
  coreWarnings,
  inflateRect,
  intersectRect,
  mergeWarnings,
  unionRect,
} from '../src/edit-util.js';

function summary(contentBox: [number, number, number, number], area = contentBox): ReflowSummary {
  return {
    lines: [],
    glyphs: [],
    contentBox,
    area,
    overflow: false,
    fontScale: 1,
    reflowMs: 0,
  };
}

function layout(
  paragraphs: Array<{ id: number; bbox: [number, number, number, number] }>,
  extra: Partial<PageLayout> = {},
): PageLayout {
  return {
    pageIndex: 0,
    bounds: [0, 0, 612, 792],
    columns: [],
    paragraphs: paragraphs.map((p) => ({ ...p }) as never),
    tables: [],
    figures: [],
    readingOrder: [],
    unassignedLines: [],
    warnings: [],
    reconMs: 0,
    ...extra,
  };
}

const warning = (kind: EditWarning['kind'], rect = 0): EditWarning => ({
  kind,
  message: kind,
  rects: [[rect, rect, rect + 1, rect + 1]],
});

describe('사각형 보조', () => {
  it('합집합·여백·교집합', () => {
    expect(unionRect([0, 0, 10, 10], [5, -5, 20, 8])).toEqual([0, -5, 20, 10]);
    expect(inflateRect([1, 2, 3, 4], 2)).toEqual([-1, 0, 5, 6]);
    expect(intersectRect([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([5, 5, 10, 10]);
    expect(intersectRect([0, 0, 10, 10], [10, 0, 20, 10])).toBeNull();
  });
});

describe('coreWarnings', () => {
  const originalBox: [number, number, number, number] = [100, 100, 300, 140];
  const areaLimit: [number, number, number, number] = [0, 0, 612, 792];

  it('배치 상자가 영역 상한 안이면 경고 없음', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 150]),
      areaLimit,
      layout: layout([{ id: 0, bbox: originalBox }]),
      paragraphId: 0,
      originalBox,
    });
    expect(w).toEqual([]);
  });

  it('상한 밖으로 나간 부분을 overflow-clipped 로 알린다(0.5pt 허용)', () => {
    const base = {
      areaLimit: [0, 0, 612, 792] as [number, number, number, number],
      layout: layout([{ id: 0, bbox: originalBox }]),
      paragraphId: 0,
      originalBox,
    };
    expect(coreWarnings({ ...base, summary: summary([100, 700, 300, 792.4]) })).toEqual([]);
    const w = coreWarnings({ ...base, summary: summary([100, 700, 300, 800]) });
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe('overflow-clipped');
    expect(w[0]!.rects).toEqual([[100, 792, 300, 800]]);
  });

  it('원 문단이 이미 겹쳐 있던 이웃은 영역을 넓혀서 생긴 겹침이 아니다', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 150], [100, 100, 300, 150]),
      areaLimit,
      layout: layout([
        { id: 0, bbox: originalBox },
        { id: 1, bbox: [100, 130, 300, 170] }, // 원 bbox(100–140)와 이미 겹침
      ]),
      paragraphId: 0,
      originalBox,
    });
    expect(w).toEqual([]);
  });

  it('쓴 영역이 다른 문단·표·도형과 겹치면 area-overlaps-content, 원 문단을 덮는 도형은 제외', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 200], [100, 100, 300, 200]),
      areaLimit,
      layout: layout(
        [
          { id: 0, bbox: originalBox },
          { id: 1, bbox: [100, 150, 300, 190] }, // 겹침
          { id: 2, bbox: [100, 300, 300, 340] }, // 멀리
        ],
        {
          figures: [
            { id: 0, bbox: [0, 0, 612, 792], kind: 'image', images: [], paths: [], labels: [] },
          ], // 쪽 배경: 원 문단 bbox 를 덮으므로 제외
          tables: [
            {
              id: 0,
              bbox: [250, 180, 400, 260],
              rows: 1,
              cols: 1,
              rowBounds: [],
              colBounds: [],
              cells: [],
              strategy: 'lines',
            },
          ],
        },
      ),
      paragraphId: 0,
      originalBox,
    });
    expect(w.map((x) => x.kind)).toEqual(['area-overlaps-content']);
    expect(w[0]!.rects).toEqual([
      [100, 150, 300, 190],
      [250, 180, 300, 200],
    ]);
  });
});

describe('mergeWarnings', () => {
  it('폰트·core 종류는 현재 글자 기준 새 결과로 바꾸고 나머지는 계획 단계 경고를 유지한다', () => {
    const merged = mergeWarnings(
      [warning('link-overlap'), warning('font-fallback'), warning('overflow-clipped')],
      [warning('glyph-missing', 5)],
      [],
    );
    expect(merged.map((w) => w.kind)).toEqual(['link-overlap', 'glyph-missing']);
  });

  it('같은 종류는 하나로 합치고 영역을 모은다', () => {
    const merged = mergeWarnings(
      [],
      [warning('font-fallback', 1), warning('font-fallback', 2)],
      [warning('area-overlaps-content')],
    );
    expect(merged.map((w) => w.kind)).toEqual(['font-fallback', 'area-overlaps-content']);
    expect(merged[0]!.rects).toHaveLength(2);
  });
});
