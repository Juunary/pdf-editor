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

describe('rectangle helpers', () => {
  it('union, margin, intersection', () => {
    expect(unionRect([0, 0, 10, 10], [5, -5, 20, 8])).toEqual([0, -5, 20, 10]);
    expect(inflateRect([1, 2, 3, 4], 2)).toEqual([-1, 0, 5, 6]);
    expect(intersectRect([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([5, 5, 10, 10]);
    expect(intersectRect([0, 0, 10, 10], [10, 0, 20, 10])).toBeNull();
  });
});

describe('coreWarnings', () => {
  const originalBox: [number, number, number, number] = [100, 100, 300, 140];
  const areaLimit: [number, number, number, number] = [0, 0, 612, 792];

  it('no warning when the placed box is within the area limit', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 150]),
      areaLimit,
      layout: layout([{ id: 0, bbox: originalBox }]),
      paragraphId: 0,
      originalBox,
    });
    expect(w).toEqual([]);
  });

  it('reports the part outside the limit as overflow-clipped (0.5pt tolerance)', () => {
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

  it('a neighbor that already overlapped the original paragraph is not an overlap caused by widening the area', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 150], [100, 100, 300, 150]),
      areaLimit,
      layout: layout([
        { id: 0, bbox: originalBox },
        { id: 1, bbox: [100, 130, 300, 170] }, // already overlaps the original bbox (100–140)
      ]),
      paragraphId: 0,
      originalBox,
    });
    expect(w).toEqual([]);
  });

  it('when the written area overlaps other paragraphs, tables or shapes: area-overlaps-content, excluding shapes that cover the original paragraph', () => {
    const w = coreWarnings({
      summary: summary([100, 100, 300, 200], [100, 100, 300, 200]),
      areaLimit,
      layout: layout(
        [
          { id: 0, bbox: originalBox },
          { id: 1, bbox: [100, 150, 300, 190] }, // overlap
          { id: 2, bbox: [100, 300, 300, 340] }, // far away
        ],
        {
          figures: [
            { id: 0, bbox: [0, 0, 612, 792], kind: 'image', images: [], paths: [], labels: [] },
          ], // page background: excluded because it covers the original paragraph bbox
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
              paths: [],
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
  it('font and core kinds are replaced with the new result based on the current characters, and the rest keep the plan-stage warnings', () => {
    const merged = mergeWarnings(
      [warning('link-overlap'), warning('font-fallback'), warning('overflow-clipped')],
      [warning('glyph-missing', 5)],
      [],
    );
    expect(merged.map((w) => w.kind)).toEqual(['link-overlap', 'glyph-missing']);
  });

  it('merges the same kind into one and collects the areas', () => {
    const merged = mergeWarnings(
      [],
      [warning('font-fallback', 1), warning('font-fallback', 2)],
      [warning('area-overlaps-content')],
    );
    expect(merged.map((w) => w.kind)).toEqual(['font-fallback', 'area-overlaps-content']);
    expect(merged[0]!.rects).toHaveLength(2);
  });
});
