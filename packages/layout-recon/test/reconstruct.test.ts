import { describe, expect, it } from 'vitest';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';
import { reconstructPage } from '../src/reconstruct.js';
import { validateLayout as layoutViolations } from '../src/validate.js';
import { buildModel, gridPaths, type LineSpec, type ModelSpec } from './helpers/model-builder.js';

/** 계약 2.1 불변식(helpers/invariants). */
function checkInvariants(model: PageModel, layout: PageLayout): void {
  expect(layoutViolations(model, layout)).toEqual([]);
}

/** 폭 w 의 열에 글자 수 n 짜리 줄들을 채운다(크기 10, 글자 폭 5). */
function column(
  x: number,
  y0: number,
  texts: string[],
  pitch = 12,
  extra: Partial<LineSpec> = {},
): LineSpec[] {
  return texts.map((text, i) => ({ x, y: y0 + i * pitch, text, ...extra }));
}

const FULL = 'x'.repeat(60); // 300pt
const words = (n: number, w = 'word'): string => Array.from({ length: n }, () => w).join(' ');

describe('reconstructPage', () => {
  it('한 열: 제목·들여쓰기 문단·줄 간격·정렬', () => {
    const lines: LineSpec[] = [
      { x: 72, y: 100, text: 'Introduction', size: 14, bold: true },
      { x: 87, y: 130, text: words(11) + ' an' }, // 첫 줄 들여쓰기
      ...column(72, 142, [words(12), words(12), 'short end.']),
      { x: 87, y: 178, text: words(11) + ' an' },
      ...column(72, 190, [words(12), 'done here.']),
    ];
    const model = buildModel({ lines });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const flow = layout.paragraphs;
    expect(flow.map((p) => p.lines)).toEqual([[0], [1, 2, 3, 4], [5, 6, 7]]);
    expect(flow[0]!.role).toBe('heading');
    expect(flow[1]!.role).toBe('body');
    expect(flow[1]!.firstLineIndent).toBe(15);
    expect(flow[1]!.lineHeight).toBe(12);
    expect(flow[1]!.align).toBe('justify');
    expect(flow[1]!.text.startsWith('word word')).toBe(true);
    expect(flow[1]!.text).not.toContain('\n');
  });

  it('두 열 + 여러 열에 걸친 제목: 읽기 순서와 열 넘김 연결', () => {
    const left = column(50, 150, [words(9), words(9), words(9), words(9) + ' and']);
    const right = column(320, 150, ['continued ' + words(7), words(9), 'final line.']);
    const model = buildModel({
      lines: [
        { x: 150, y: 100, text: 'A Wide Title Over Both Columns', size: 18, bold: true },
        ...left,
        ...right,
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const order = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.lines);
    expect(order).toEqual([[0], [1, 2, 3, 4], [5, 6, 7]]);
    const [title, a, b] = layout.readingOrder.map((r) => layout.paragraphs[r.id]!);
    expect(title!.role).toBe('heading');
    expect(a!.column).not.toBe(b!.column);
    expect(a!.continuesTo).toBe(b!.id);
    expect(layout.columns.length).toBeGreaterThanOrEqual(2);
  });

  it('머리·꼬리: 위 띠의 러닝헤드, 아래 띠의 쪽 번호', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 40, text: 'Journal of Tests', size: 8 },
        { x: 500, y: 40, text: 'Vol. 3', size: 8 },
        ...column(72, 120, [FULL, FULL, 'end.']),
        { x: 300, y: 760, text: '12', size: 9 },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const roles = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.role);
    expect(roles).toEqual(['header', 'header', 'body', 'footer']);
  });

  it('글머리 목록: 내어쓰기 이어짐과 항목 경계', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: '• ' + words(11) },
        { x: 82, y: 112, text: words(5) },
        { x: 72, y: 124, text: '• ' + words(4) },
        { x: 72, y: 136, text: '• last item' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([[0, 1], [2], [3]]);
    expect(layout.paragraphs.every((p) => p.role === 'list-item')).toBe(true);
  });

  it('들쭉날쭉한 항목 목록: 영역 앞쪽 줄도 열 폭 기준으로 줄 끝을 판정한다(W4-4)', () => {
    // 달력형 목록: 날짜(굵게) / 행사명(굵게) / 담당자(굵게) / 장소. 영역 맨 앞 줄의 국소 창이 가장자리에서
    // 잘려 긴 줄(6·8번)을 담지 못하면 오른쪽 끝이 낮게 잡혀, 행사명 줄을 "끝까지 찬 줄" 로 보고 담당자
    // 줄을 잇던 결함이 있었다.
    const b = { bold: true };
    const lines: LineSpec[] = [
      { x: 54, y: 100, text: 'May 14-16, 2024', ...b },
      { x: 54, y: 112, text: 'CERES Science Team Meeting', ...b },
      { x: 54, y: 124, text: 'POC: norman.g.loeb@nasa.gov', ...b },
      { x: 54, y: 136, text: 'Hampton, VA' },
      { x: 54, y: 156.6, text: 'June 3-6, 2024', ...b },
      { x: 54, y: 168.6, text: 'OMI-TROPOMI Science Team', ...b },
      { x: 54, y: 180.6, text: 'Pyeongchang-gun, Gangwon-do, South Korea' },
      { x: 54, y: 201.2, text: 'April 14-19, 2024', ...b },
      { x: 54, y: 213.2, text: 'European Geosciences Union (EGU) General Assembly', ...b },
      { x: 54, y: 225.2, text: 'Vienna, Austria' },
    ];
    const model = buildModel({ lines });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual(lines.map((_, i) => [i]));
  });

  it('위첨자 조각과 목차 쪽 번호를 같은 줄로 합친다', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: words(10) },
        { x: 72 + 49 * 5, y: 96, text: '[1]', size: 6 },
        { x: 72, y: 112, text: words(6) + ' end.' },
        { x: 72, y: 150, text: '1.1' },
        { x: 100, y: 150, text: 'Methods . . . . . . . . . .' },
        { x: 400, y: 150, text: '12' },
        { x: 72, y: 165, text: '1.2' },
        { x: 100, y: 165, text: 'Results . . . . . . . . . .' },
        { x: 400, y: 165, text: '15' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    const ps = layout.paragraphs.map((p) => p.lines.slice().sort((a, b) => a - b));
    expect(ps).toContainEqual([0, 1, 2]);
    expect(ps).toContainEqual([3, 4, 5]);
    expect(ps).toContainEqual([6, 7, 8]);
  });

  it('도형: 이미지 위 라벨은 도형 라벨, 아래 캡션은 caption 문단', () => {
    const model = buildModel({
      lines: [
        ...column(72, 100, [FULL, 'end.']),
        { x: 150, y: 250, text: 'axis', size: 7 },
        { x: 72, y: 420, text: 'Figure 1. A test figure.' },
      ],
      images: [[100, 150, 400, 400]],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.figures).toHaveLength(1);
    const fig = layout.figures[0]!;
    expect(fig.labels.map((p) => layout.paragraphs[p]!.lines)).toEqual([[2]]);
    const caption = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(caption.role).toBe('caption');
    const kinds = layout.readingOrder.map((r) => r.kind);
    expect(kinds).toEqual(['paragraph', 'figure', 'paragraph']);
  });

  it('모양 구간: 굵은 단어가 끼면 구간 3개', () => {
    const model = buildModel({
      lines: [
        { x: 72, y: 100, text: 'plain ' },
        { x: 102, y: 100, text: 'bold', bold: true },
        { x: 122, y: 100, text: ' tail end.' },
      ],
    });
    const layout = reconstructPage(model);
    checkInvariants(model, layout);
    expect(layout.paragraphs).toHaveLength(1);
    const runs = layout.paragraphs[0]!.styleRuns;
    expect(runs.map((r) => r.bold)).toEqual([false, true, false]);
  });

  it('빈 쪽', () => {
    const model = buildModel({});
    const layout = reconstructPage(model);
    expect(layout.paragraphs).toEqual([]);
    expect(layout.readingOrder).toEqual([]);
  });
});

describe('이웃 쪽 반복 머리·꼬리', () => {
  it('이웃 쪽 같은 자리의 러닝헤드·쪽 번호는 여백 띠·간격 조건 없이도 머리·꼬리', () => {
    // 러닝헤드가 본문과 가깝고(간격 작음) 쪽 번호가 9% 띠 밖(쪽 높이 89%)에 있다.
    const page = (n: number) =>
      buildModel({
        lines: [
          { x: 72, y: 84, text: 'A Running Head Title' },
          ...column(72, 98, [FULL, FULL, 'end.']),
          { x: 300, y: 712, text: `Page ${n}` },
        ],
      });
    const model = page(6);
    const alone = reconstructPage(model);
    expect(alone.paragraphs.filter((p) => p.role === 'header' || p.role === 'footer')).toHaveLength(
      0,
    );
    const layout = reconstructPage(model, { neighbors: [page(5), page(7)] });
    checkInvariants(model, layout);
    const roles = layout.readingOrder.map((r) => layout.paragraphs[r.id]!.role);
    expect(roles[0]).toBe('header');
    expect(roles.at(-1)).toBe('footer');
  });
});

describe('fixedGroups(편집 블록 한 문단, docs/m3-integration.md 9.6)', () => {
  // 편집 블록 줄: 강제 줄바꿈 뒤 짧은 줄 + 양쪽 정렬 줄의 넓은 단어 간격(한 줄이 조각 둘).
  const blockLines = (): LineSpec[] => [
    { x: 72, y: 100, text: 'Short line one.' },
    { x: 72, y: 112, text: 'Short line two.' },
    { x: 72, y: 124, text: words(5) },
    { x: 222, y: 124, text: words(5) }, // 같은 행, 앞 조각과 50pt 간격
    { x: 72, y: 136, text: 'last line.' },
  ];

  it('나뉘던 블록 줄이 문단 하나가 된다(줄 위→아래, 같은 행 조각 포함)', () => {
    const model = buildModel({ lines: blockLines() });
    const plain = reconstructPage(model);
    checkInvariants(model, plain);
    expect(plain.paragraphs.length).toBeGreaterThan(1);
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2, 3, 4]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs).toHaveLength(1);
    const p = layout.paragraphs[0]!;
    expect(p.lines).toEqual([0, 1, 2, 3, 4]);
    expect(p.role).toBe('body');
    expect(p.column).toBe(0);
    expect(p.lineHeight).toBe(12);
    expect(p.bbox[0]).toBe(72);
    expect(p.text.startsWith('Short line one. Short line two.')).toBe(true);
    expect(layout.readingOrder).toEqual([{ kind: 'paragraph', id: 0 }]);
  });

  it('주어진 줄 순서와 무관하게 위→아래', () => {
    const model = buildModel({ lines: blockLines() });
    const layout = reconstructPage(model, { fixedGroups: [[4, 2, 0, 3, 1]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([[0, 1, 2, 3, 4]]);
  });

  it('이웃 문단 줄과 합쳐지던 블록이 떨어진다', () => {
    // 블록(줄 0–2)과 바로 아래 이웃 문단(줄 3–5)이 같은 줄 간격·같은 모양이라 M2 는 한 문단으로 본다.
    const model = buildModel({
      lines: column(72, 100, [words(12), words(12), words(12), words(12), words(12), 'end.']),
    });
    const plain = reconstructPage(model);
    expect(plain.paragraphs.map((p) => p.lines)).toEqual([[0, 1, 2, 3, 4, 5]]);
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2]] });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
    expect(layout.readingOrder.map((r) => r.id)).toEqual([0, 1]);
  });

  it('이웃 문단과 겹쳐도(넓힌 영역) 블록 하나·이웃 하나', () => {
    // 블록 마지막 줄이 이웃 첫 줄과 같은 높이 근처(겹침)에 있다.
    const model = buildModel({
      lines: [
        ...column(72, 100, [words(12), words(12), words(12)]),
        ...column(72, 128, [words(12), words(12), 'end.']),
      ],
    });
    const layout = reconstructPage(model, { fixedGroups: [[0, 1, 2]] });
    checkInvariants(model, layout);
    const sorted = layout.paragraphs.map((p) => p.lines).sort((a, b) => a[0]! - b[0]!);
    expect(sorted).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('두 열: 블록은 왼쪽 열 자리의 읽기 순서·열을 받는다', () => {
    const left = column(50, 150, [words(9), words(9), 'end.', 'Edited one.', 'Edited two.']);
    const right = column(320, 150, [words(9), words(9), 'final line.']);
    const model = buildModel({ lines: [...left, ...right] });
    const layout = reconstructPage(model, { fixedGroups: [[3, 4]] });
    checkInvariants(model, layout);
    const block = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(block.lines).toEqual([3, 4]);
    const first = layout.paragraphs.find((p) => p.lines.includes(0))!;
    const rightP = layout.paragraphs.find((p) => p.lines.includes(5))!;
    expect(block.column).toBe(first.column);
    expect(rightP.column).not.toBe(block.column);
    const order = layout.readingOrder.map((r) => r.id);
    expect(order.indexOf(first.id)).toBeLessThan(order.indexOf(block.id));
    expect(order.indexOf(block.id)).toBeLessThan(order.indexOf(rightP.id));
  });

  it('잘못된 번호·빈 묶음·겹친 묶음은 무시(앞 묶음 우선), 묶음 둘은 문단 둘', () => {
    const model = buildModel({ lines: blockLines() });
    const layout = reconstructPage(model, {
      fixedGroups: [[], [0, 1, 99, -1], [1, 2, 3, 4]],
    });
    checkInvariants(model, layout);
    expect(layout.paragraphs.map((p) => p.lines)).toEqual([
      [0, 1],
      [2, 3, 4],
    ]);
  });

  it('힌트가 없거나 빈 배열이면 M2 결과와 같다', () => {
    const model = buildModel({ lines: blockLines() });
    const strip = (l: PageLayout) => ({ ...l, reconMs: 0 });
    expect(strip(reconstructPage(model, { fixedGroups: [] }))).toEqual(
      strip(reconstructPage(model)),
    );
  });
});

describe('fixedGroups 셀 편집 블록(M4 4.1·V4)', () => {
  /** 표 하나의 모양(행·열 수, 전략)과 셀별 문단 수. */
  const shape = (l: PageLayout) =>
    l.tables.map((t) => ({
      strategy: t.strategy,
      rows: t.rows,
      cols: t.cols,
      paragraphs: t.cells.map((c) => c.paragraphs.length),
    }));
  /** (행, 열) 셀의 문단. */
  const cellParas = (l: PageLayout, row: number, col: number) => {
    const c = l.tables[0]!.cells.find((x) => x.row === row && x.col === col)!;
    return c.paragraphs.map((id) => l.paragraphs[id]!);
  };

  // 괘선 3×3 표(행 높이 30). 편집 뒤 셀 (1,1) 은 두 줄 블록이다.
  const xs = [100, 200, 300, 400];
  const ys = [100, 130, 160, 190];
  const gridSpec = (edited: boolean): ModelSpec => {
    const lines: LineSpec[] = [];
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        if (edited && r === 1 && c === 1) continue;
        lines.push({ x: xs[c]! + 5, y: ys[r]! + 14, text: `R${r}C${c}` });
      }
    if (edited) {
      lines.push({ x: 205, y: 142, text: 'Edited' }, { x: 205, y: 154, text: 'cell' });
    }
    return { lines, paths: gridPaths(xs, ys) };
  };

  it('괘선 표: 셀 블록 커밋 뒤 표 감지 유지, 그 셀 문단 = 블록 하나(table 설정)', () => {
    const before = reconstructPage(buildModel(gridSpec(false)));
    const model = buildModel(gridSpec(true));
    const block = [8, 9];
    const layout = reconstructPage(model, { fixedGroups: [block] });
    checkInvariants(model, layout);
    expect(shape(layout)).toEqual(shape(before));
    const [p, ...rest] = cellParas(layout, 1, 1);
    expect(rest).toEqual([]);
    expect(p!.lines).toEqual(block);
    expect(p!.table).toBe(0);
    expect(p!.column).toBe(-1);
    expect(p!.text).toBe('Edited cell');
    // 표 안 문단은 최상위 읽기 순서에 없다.
    expect(layout.readingOrder).toEqual([{ kind: 'table', id: 0 }]);
  });

  it('괘선 표: 블록 묶음 없이도 같은 결과면 힌트가 셀 문단을 바꾸지 않는다(한 줄 셀)', () => {
    const model = buildModel(gridSpec(false));
    const plain = reconstructPage(model);
    const hinted = reconstructPage(model, { fixedGroups: [[4]] });
    checkInvariants(model, hinted);
    expect(shape(hinted)).toEqual(shape(plain));
    expect(cellParas(hinted, 1, 1).map((p) => p.lines)).toEqual([[4]]);
  });

  // 정렬 전략 3행 표(머리 + 3행, 오른쪽 정렬 숫자 2열).
  const right = (r: number, y: number, text: string): LineSpec => ({
    x: r - Array.from(text).length * 5,
    y,
    text,
  });
  const alignedSpec = (cash: string): ModelSpec => ({
    lines: [
      right(400, 100, '2025'),
      right(500, 100, '2024'),
      { x: 82, y: 114, text: 'Cash and equivalents' },
      right(400, 114, cash),
      right(500, 114, '1,100'),
      { x: 82, y: 128, text: 'Receivables' },
      right(400, 128, '567'),
      right(500, 128, '45,600'),
      { x: 82, y: 142, text: 'Inventory' },
      right(400, 142, '89'),
      right(500, 142, '12'),
    ],
  });

  it('정렬 전략 3행 표: 숫자 셀 블록 커밋 뒤 표 감지 유지', () => {
    const before = reconstructPage(buildModel(alignedSpec('1,234')));
    expect(shape(before)).toEqual([
      { strategy: 'text', rows: 4, cols: 3, paragraphs: expect.any(Array) },
    ]);
    const model = buildModel(alignedSpec('12,345'));
    const layout = reconstructPage(model, { fixedGroups: [[3]] });
    checkInvariants(model, layout);
    expect(shape(layout)).toEqual(shape(before));
    const [p, ...rest] = cellParas(layout, 1, 1);
    expect(rest).toEqual([]);
    expect(p!.lines).toEqual([3]);
    expect(p!.table).toBe(0);
    expect(p!.text).toBe('12,345');
  });

  it('여러 셀에 걸친 묶음은 흐름 문단, 표 감지는 그 줄을 뺀 결과와 같다', () => {
    const model = buildModel(gridSpec(false));
    const layout = reconstructPage(model, { fixedGroups: [[3, 4]] });
    checkInvariants(model, layout);
    const block = layout.paragraphs.find((p) => p.lines.includes(3))!;
    expect(block.lines).toEqual([3, 4]);
    expect(block.table).toBeNull();
    for (const t of layout.tables)
      for (const c of t.cells) expect(c.lines.some((li) => li === 3 || li === 4)).toBe(false);
  });
});
