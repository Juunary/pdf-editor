import { describe, expect, it } from 'vitest';
import type { LayoutParagraph, PageLayout, ParagraphRole } from '@pdf-editor/shared-types';
import {
  kendallTau,
  scoreLayout,
  summarizeScores,
  type PageLabel,
  type PageScore,
} from '../src/accuracy.js';
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

describe('역할 채점', () => {
  const lbl = (role: ParagraphRole, lines: number[]): PageLabel['items'][number] => ({
    type: 'paragraph',
    role,
    lines,
  });

  it('역할이 모두 같으면 대각선만 채운다', () => {
    const s = scoreLayout(
      label([lbl('heading', [0]), lbl('body', [1, 2]), lbl('caption', [3])]),
      layoutOf([para(0, [0], 'heading'), para(1, [1, 2]), para(2, [3], 'caption')]),
    );
    expect(s.roles).toEqual({
      heading: { heading: 1 },
      body: { body: 1 },
      caption: { caption: 1 },
    });
    expect(s.roleMisses).toEqual([]);
  });

  it('역할이 다르면 혼동표 칸과 roleMisses 에 남는다', () => {
    const s = scoreLayout(
      label([lbl('caption', [0]), lbl('footnote', [1]), lbl('list-item', [2, 3])]),
      layoutOf([para(0, [0], 'body'), para(1, [1], 'list-item'), para(2, [2, 3], 'list-item')]),
    );
    expect(s.roles).toEqual({
      caption: { body: 1 },
      footnote: { 'list-item': 1 },
      'list-item': { 'list-item': 1 },
    });
    expect(s.roleMisses).toEqual(['caption[0] → body P0[0]', 'footnote[1] → list-item P1[1]']);
    // 문단 경계 지표는 역할과 무관하다.
    expect(s.paragraphs).toEqual({ tp: 3, fp: 0, fn: 0 });
  });

  it('경계가 틀려도 줄 Jaccard 0.5 이상이면 짝지어 역할을 비교한다', () => {
    // 라벨 [1,2,3] 을 예측이 [1,2] + [3] 으로 갈랐다: [1,2] 는 J=2/3 로 짝, [3] 은 짝 없음.
    const s = scoreLayout(
      label([lbl('heading', [1, 2, 3])]),
      layoutOf([para(0, [1, 2], 'heading'), para(1, [3], 'body')]),
    );
    expect(s.roles).toEqual({ heading: { heading: 1 }, none: { body: 1 } });
  });

  it('짝 하한 미만이면 짝 없음: 라벨은 예측 열 none, 예측은 라벨 행 none', () => {
    // 라벨 [1,2,3,4] vs 예측 [1],[2],[3],[4]: 각 J=1/4 < 0.5.
    const s = scoreLayout(
      label([lbl('list-item', [1, 2, 3, 4])]),
      layoutOf([1, 2, 3, 4].map((l, k) => para(k, [l], 'list-item'))),
    );
    expect(s.roles).toEqual({ 'list-item': { none: 1 }, none: { 'list-item': 4 } });
  });

  it('일대일 짝: Jaccard 가 큰 쪽이 먼저 짝을 가져간다', () => {
    // 예측 [1,2,3] 은 라벨 [1,2,3](J=1)과 짝이고, 라벨 [4] 와 예측 [4]도 짝이다.
    const s = scoreLayout(
      label([lbl('body', [1, 2, 3]), lbl('footnote', [4])]),
      layoutOf([para(0, [1, 2, 3]), para(1, [4], 'footnote')]),
    );
    expect(s.roles).toEqual({ body: { body: 1 }, footnote: { footnote: 1 } });
  });

  it('표·도형 안 예측 문단과 짝이면 container 열, 짝 없는 표·도형 문단은 세지 않는다', () => {
    const inTable = { ...para(0, [1]), table: 0 };
    const inFigure = { ...para(1, [9]), figure: 0 };
    const s = scoreLayout(
      label([lbl('caption', [1])]),
      layoutOf([inTable, inFigure, para(2, [5], 'body')]),
    );
    // 예측 P2([5])는 라벨 문단 줄이 없어 세지 않는다. P1([9])은 짝도 라벨 줄도 없다.
    expect(s.roles).toEqual({ caption: { container: 1 } });
    expect(s.roleMisses).toEqual(['caption[1] → container P0[1]']);
  });

  it('ignoreLines 는 짝짓기에서 뺀다', () => {
    const s = scoreLayout(
      label([lbl('footnote', [1, 2])], [3]),
      layoutOf([para(0, [1, 2, 3], 'footnote'), para(1, [3], 'body')]),
    );
    expect(s.roles).toEqual({ footnote: { footnote: 1 } });
  });

  it('합산: 역할별 정밀도·재현율·F1 과 짝 비율', () => {
    const z = { tp: 0, fp: 0, fn: 0 };
    const page = (roles: PageScore['roles']): PageScore => ({
      paragraphs: z,
      pairs: z,
      tau: null,
      tauBaseline: null,
      tauExcluded: 0,
      tables: z,
      tableShape: { exact: 0, matched: 0 },
      cellLines: { correct: 0, total: 0 },
      figures: z,
      margin: z,
      roles,
      roleMisses: [],
      misses: [],
    });
    const s = summarizeScores([
      page({ caption: { caption: 2, body: 1 }, body: { body: 5, none: 1 }, none: { caption: 1 } }),
      page({ caption: { none: 1 }, footnote: { body: 2 } }),
    ]);
    // caption: 라벨 4(일치 2), 예측 3(일치 2).
    expect(s.roles.caption).toEqual({
      support: 4,
      predicted: 3,
      tp: 2,
      precision: 2 / 3,
      recall: 0.5,
      f1: 4 / 7,
    });
    // body: 라벨 6(일치 5), 예측 5 + 1 + 2 = 8.
    expect(s.roles.body).toMatchObject({ support: 6, predicted: 8, tp: 5 });
    expect(s.roles.footnote).toMatchObject({
      support: 2,
      predicted: 0,
      tp: 0,
      precision: null,
      recall: 0,
    });
    expect(s.roles.heading).toMatchObject({
      support: 0,
      predicted: 0,
      precision: null,
      recall: null,
      f1: null,
    });
    // 라벨 문단 3 + 6 + 1 + 2 = 12, 짝 없음 2(caption 1, body 1)를 빼면 짝 10, 그중 역할 일치 7.
    expect(s.rolePairs).toEqual({ labeled: 12, paired: 10, match: 7 });
    expect(s.roleMatrix.none).toEqual({ caption: 1 });
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
      tauBaseline: 1,
      tauExcluded: 0,
      tables: z,
      tableShape: { exact: 0, matched: 0 },
      cellLines: { correct: 0, total: 0 },
      figures: z,
      margin: z,
      roles: {},
      roleMisses: [],
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

describe('scoreLayout 경계 사례', () => {
  it('매칭되지 않은 예측 표·도형은 fp, 라벨 셀은 매칭이 없어도 total 에 든다', () => {
    const l = label([
      {
        type: 'table',
        bbox: [0, 0, 100, 100],
        rows: 1,
        cols: 2,
        lines: [0, 1],
        cells: [
          { row: 0, col: 0, lines: [0] },
          { row: 0, col: 1, lines: [1] },
        ],
      },
    ]);
    const layout = layoutOf([], {
      tables: [
        {
          id: 0,
          bbox: [300, 300, 400, 400],
          rows: 1,
          cols: 1,
          rowBounds: [300, 400],
          colBounds: [300, 400],
          cells: [],
          strategy: 'text',
        },
      ],
      figures: [
        { id: 0, bbox: [0, 500, 100, 600], kind: 'image', images: [0], paths: [], labels: [] },
      ],
      readingOrder: [
        { kind: 'table', id: 0 },
        { kind: 'figure', id: 0 },
      ],
    });
    const s = scoreLayout(l, layout);
    expect(s.tables).toEqual({ tp: 0, fp: 1, fn: 1 });
    expect(s.figures).toEqual({ tp: 0, fp: 1, fn: 0 });
    expect(s.cellLines).toEqual({ correct: 0, total: 2 });
  });

  it('예측에서 빠진 라벨 줄은 문단 불일치이고 τ 에서 뺀 항목으로 센다', () => {
    const s = scoreLayout(
      label([
        { type: 'paragraph', role: 'body', lines: [0, 1] },
        { type: 'paragraph', role: 'body', lines: [2] },
      ]),
      layoutOf([para(0, [0, 1])]),
    );
    expect(s.paragraphs).toEqual({ tp: 1, fp: 0, fn: 1 });
    expect(s.tauExcluded).toBe(1);
    expect(s.tau).toBeNull();
    expect(s.tauBaseline).toBe(1);
  });
});
