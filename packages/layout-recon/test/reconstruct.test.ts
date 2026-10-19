import { describe, expect, it } from 'vitest';
import type { PageLayout, PageModel } from '@pdf-editor/shared-types';
import { reconstructPage } from '../src/reconstruct.js';
import { validateLayout as layoutViolations } from '../src/validate.js';
import { buildModel, type LineSpec } from './helpers/model-builder.js';

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
