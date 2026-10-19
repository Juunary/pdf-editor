import { describe, expect, it } from 'vitest';
import type { LayoutParagraph, PageLayout, ParagraphRole } from '@pdf-editor/shared-types';
import { kendallTau, scoreLayout, summarizeScores, type PageLabel } from '../src/accuracy.js';
import { xyCut } from '../src/xycut.js';

function para(id: number, lines: number[], role: ParagraphRole = 'body'): LayoutParagraph {
  return {
    id,
    bbox: [0, 0, 1, 1],
    lines,
    chars: [],
    text: '',
    role,
    column: 0,
    table: null,
    figure: null,
    lineHeight: null,
    firstLineIndent: 0,
    align: 'unknown',
    styleRuns: [],
    continuesTo: null,
  };
}

function layoutOf(paragraphs: LayoutParagraph[], extra: Partial<PageLayout> = {}): PageLayout {
  return {
    pageIndex: 0,
    bounds: [0, 0, 612, 792],
    columns: [],
    paragraphs,
    tables: [],
    figures: [],
    readingOrder: paragraphs.map((p) => ({ kind: 'paragraph' as const, id: p.id })),
    unassignedLines: [],
    warnings: [],
    reconMs: 0,
    ...extra,
  };
}

const label = (items: PageLabel['items'], ignoreLines: number[] = []): PageLabel => ({
  doc: 'd',
  pageIndex: 0,
  split: 'dev',
  extract: { lineCount: 0, linesSha256: '' },
  status: 'reviewed',
  items,
  ignoreLines,
});

describe('scoreLayout', () => {
  const items: PageLabel['items'] = [
    { type: 'paragraph', role: 'header', lines: [0] },
    { type: 'paragraph', role: 'body', lines: [1, 2, 3] },
    { type: 'paragraph', role: 'body', lines: [4, 5] },
    { type: 'paragraph', role: 'footer', lines: [6] },
  ];

  it('완전 일치', () => {
    const s = scoreLayout(
      label(items),
      layoutOf([
        para(0, [0], 'header'),
        para(1, [1, 2, 3]),
        para(2, [4, 5]),
        para(3, [6], 'footer'),
      ]),
    );
    expect(s.paragraphs).toEqual({ tp: 4, fp: 0, fn: 0 });
    expect(s.pairs).toEqual({ tp: 4, fp: 0, fn: 0 });
    expect(s.tau).toBe(1);
    expect(s.margin).toEqual({ tp: 2, fp: 0, fn: 0 });
    expect(s.misses).toEqual([]);
  });

  it('문단 하나가 둘로 갈라지면 fp 2·fn 1, 줄 쌍 부분 점수', () => {
    const s = scoreLayout(
      label(items),
      layoutOf([
        para(0, [0], 'header'),
        para(1, [1]),
        para(2, [2, 3]),
        para(3, [4, 5]),
        para(4, [6], 'footer'),
      ]),
    );
    expect(s.paragraphs).toEqual({ tp: 3, fp: 2, fn: 1 });
    expect(s.pairs).toEqual({ tp: 2, fp: 0, fn: 2 });
    expect(s.misses).toHaveLength(1);
  });

  it('본문 순서가 뒤집히면 τ = −1(머리·꼬리 제외)', () => {
    const l = layoutOf([
      para(0, [0], 'header'),
      para(1, [4, 5]),
      para(2, [1, 2, 3]),
      para(3, [6], 'footer'),
    ]);
    expect(scoreLayout(label(items), l).tau).toBe(-1);
  });

  it('ignoreLines 는 비교에서 뺀다', () => {
    const s = scoreLayout(
      label([{ type: 'paragraph', role: 'body', lines: [1, 2] }], [3]),
      layoutOf([para(0, [1, 2, 3])]),
    );
    expect(s.paragraphs).toEqual({ tp: 1, fp: 0, fn: 0 });
  });

  it('표: IoU 0.5 이상 매칭, 행·열 수, 셀 줄', () => {
    const l = label([
      {
        type: 'table',
        bbox: [100, 100, 300, 200],
        rows: 2,
        cols: 2,
        lines: [0, 1],
        cells: [
          { row: 0, col: 0, lines: [0] },
          { row: 1, col: 1, lines: [1] },
        ],
      },
    ]);
    const cell = (row: number, col: number, lines: number[]) => ({
      row,
      col,
      rowSpan: 1,
      colSpan: 1,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
      lines,
      paragraphs: [],
    });
    const layout = layoutOf([], {
      tables: [
        {
          id: 0,
          bbox: [105, 100, 300, 210],
          rows: 2,
          cols: 2,
          rowBounds: [100, 150, 210],
          colBounds: [105, 200, 300],
          cells: [cell(0, 0, [0]), cell(1, 0, [1])],
          strategy: 'lines',
        },
      ],
      readingOrder: [{ kind: 'table', id: 0 }],
    });
    const s = scoreLayout(l, layout);
    expect(s.tables).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(s.tableShape).toEqual({ exact: 1, matched: 1 });
    expect(s.cellLines).toEqual({ correct: 1, total: 2 });
  });
});

describe('kendallTau·summarizeScores', () => {
  it('순위 일치율', () => {
    expect(kendallTau([1, 2, 3, 4])).toBe(1);
    expect(kendallTau([4, 3, 2, 1])).toBe(-1);
    expect(kendallTau([1, 3, 2])).toBeCloseTo(1 / 3);
    expect(kendallTau([1, 1])).toBeNull();
  });

  it('합산은 쪽 평균이 아니라 개수 합', () => {
    const z = { tp: 0, fp: 0, fn: 0 };
    const base = {
      pairs: z,
      tau: 1,
      tables: z,
      tableShape: { exact: 0, matched: 0 },
      cellLines: { correct: 0, total: 0 },
      figures: z,
      margin: z,
      misses: [],
    };
    const s = summarizeScores([
      { ...base, paragraphs: { tp: 9, fp: 1, fn: 1 } },
      { ...base, paragraphs: { tp: 0, fp: 1, fn: 1 }, tau: 0 },
    ]);
    expect(s.paragraphF1).toBeCloseTo(18 / 22);
    expect(s.tauMean).toBe(0.5);
    expect(s.tableP).toBeNull();
  });
});

describe('xyCut', () => {
  it('세로 빈 띠 우선: 두 열 + 위 제목', () => {
    const r = xyCut([
      { bbox: [50, 50, 550, 70] },
      { bbox: [50, 100, 290, 400] },
      { bbox: [320, 100, 550, 500] },
      { bbox: [50, 420, 290, 500] },
    ]);
    expect(r.order).toEqual([0, 1, 3, 2]);
    expect(r.group[0]).toBe(-1);
    expect(r.group[1]).toBe(r.group[3]);
    expect(r.group[1]).not.toBe(r.group[2]);
  });
});
