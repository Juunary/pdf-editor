/**
 * 표 셀 편집 대상(M4, docs/m4-contract.md 4.1·D1·D5). 문서를 읽지 않는 순수 계산이다.
 *
 * - 대상: 셀 하나 = 편집 단위(D1). 셀 안 문단 전부를 읽기 순서로 묶은 문단 하나로 다룬다.
 * - 줄 잇기: 셀 안 줄 사이(문단 안·문단 사이)는 자동 줄바꿈이면 공백, 아니면 "\n". 자동 줄바꿈 = 다음 줄 첫 단어가
 *   앞 줄 뒤 셀 안쪽 폭에 들어가지 않음. 문단 사이는 기준선 간격이 앞 문단 줄 간격과 같을(±10%) 때만 공백.
 *   계약의 "앞 줄이 셀 오른쪽 1em 안까지 참" 대신 이 판정을 쓴다: 오른쪽 정렬로 쌓은 숫자 줄이 공백으로 이어져 다시
 *   배치되면 위치가 바뀐다(코퍼스 실측, docs/m4-pdf-ops.md 계약 불일치 2).
 * - 셀 상자: 괘선 표는 레이아웃 셀 상자. 정렬 전략 표는 바깥 열·행을 이웃 간격 절반(없으면 1em)만큼, 표 상자가
 *   더 크면 표 상자까지 넓힌다(D5).
 * - 여백: 변마다 min(원 글자와 경계 간격, 2pt). 영역 상한(areaLimit) = (셀 상자 − 여백) ∪ 원 글자 상자(원 글자가
 *   셀 상자 밖으로 나온 셀에서 같은 텍스트가 초과가 되지 않게, docs/m4-pdf-ops.md 계약 불일치 3).
 * - 시작 영역: 세로는 글자 상자, 가로는 셀 상자 − 여백. 단 정렬한 쪽 변(왼쪽 정렬이면 왼쪽, 가운데면 양쪽 같은 값)은
 *   원 글자 간격을 그대로 써서 같은 텍스트 커밋에서 글자가 움직이지 않게 한다(계약 1.1 위치 보존 ≤ 0.5pt,
 *   docs/m4-pdf-ops.md 계약 불일치 1).
 * - 정렬: 괘선 표는 셀 안 좌·우 간격 비교(차 < 1pt 가운데, 오른쪽 간격이 작으면 오른쪽, 아니면 왼쪽). 정렬 전략 표는
 *   같은 열(병합 없는 셀) 글자 상자의 x0·x1·가운데 퍼짐이 가장 작은 키(셀 2개 이상일 때, 아니면 간격 비교).
 */
import { offsetMap } from './text-map.js';
import type {
  LayoutParagraph,
  LayoutTable,
  PageLayout,
  PageModel,
  ParagraphAlign,
  Rect,
  StyleRun,
  TableCell,
} from '@pdf-editor/shared-types';

export interface CellTarget {
  table: LayoutTable;
  cell: TableCell;
  /** 셀 상자(D5, 정렬 전략 표는 넓힌 상자). */
  box: Rect;
  /** (셀 상자 − 여백(변마다 min(간격, 2pt))) ∪ 원 글자 상자 = 영역 상한. */
  limit: Rect;
  /** 시작 영역의 가로(정렬한 변은 원 간격). */
  areaX: [number, number];
  align: ParagraphAlign;
  /** 줄 간격: 첫 문단 값, 없으면 셀 줄 기준선 간격 중앙값(줄 1개면 null). */
  lineHeight: number | null;
  /** 셀 문단을 이은 문단(id = 셀 첫 문단 id). */
  paragraph: LayoutParagraph;
  /** 셀 문단 id 전부. */
  members: Set<number>;
}

const MARGIN = 2;

const unionRect = (a: Rect | null, b: Rect): Rect =>
  a
    ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
    : [...b];

/** 문단이 든 셀(표 셀 문단이 아니거나 셀을 찾지 못하면 null). */
export function cellOfParagraph(
  layout: PageLayout,
  paragraphId: number,
): { table: LayoutTable; cell: TableCell } | null {
  const p = layout.paragraphs.find((q) => q.id === paragraphId);
  if (!p || p.table === null) return null;
  const table = layout.tables.find((t) => t.id === p.table);
  const cell = table?.cells.find((c) => c.paragraphs.includes(paragraphId));
  return table && cell ? { table, cell } : null;
}

/** 줄 상자들의 합(보이는 글자 줄). */
function linesBox(model: PageModel, lines: readonly number[]): Rect | null {
  let r: Rect | null = null;
  for (const li of lines) {
    const l = model.lines[li];
    if (l) r = unionRect(r, l.bbox);
  }
  return r;
}

/** 정렬 전략 표의 셀 상자: 바깥 열·행을 이웃 간격 절반(또는 표 상자)까지 넓힌다. */
function textCellBox(model: PageModel, table: LayoutTable, cell: TableCell): Rect {
  const box: Rect = [...cell.bbox];
  const textOf = (c: TableCell) => linesBox(model, c.lines);
  // 열 사이 글자 간격, 행 사이 글자 간격의 최솟값.
  const gaps = (axis: 0 | 1): number[] => {
    const n = axis === 0 ? table.cols : table.rows;
    const out: number[] = [];
    for (let k = 0; k + 1 < n; k++) {
      let hi = -Infinity;
      let lo = Infinity;
      for (const c of table.cells) {
        const t = textOf(c);
        if (!t) continue;
        const start = axis === 0 ? c.col : c.row;
        const span = axis === 0 ? c.colSpan : c.rowSpan;
        if (start + span - 1 === k) hi = Math.max(hi, t[axis + 2]!);
        if (start === k + 1) lo = Math.min(lo, t[axis]!);
      }
      if (Number.isFinite(hi) && Number.isFinite(lo) && lo > hi) out.push(lo - hi);
    }
    return out;
  };
  const size = (() => {
    const l = model.lines[cell.lines[0] ?? -1];
    const ch = l ? model.chars[l.chars[0] ?? -1] : undefined;
    return ch?.size ?? 10;
  })();
  const half = (g: number[]) => (g.length > 0 ? Math.min(...g) / 2 : size);
  const hx = half(gaps(0));
  const hy = half(gaps(1));
  if (cell.col === 0) box[0] = Math.min(box[0] - hx, table.bbox[0]);
  if (cell.col + cell.colSpan === table.cols) box[2] = Math.max(box[2] + hx, table.bbox[2]);
  if (cell.row === 0) box[1] = Math.min(box[1] - hy, table.bbox[1]);
  if (cell.row + cell.rowSpan === table.rows) box[3] = Math.max(box[3] + hy, table.bbox[3]);
  return box;
}

/** 정렬 전략 표의 열 정렬 키. 판단할 수 없으면 null. */
function columnAlign(model: PageModel, table: LayoutTable, col: number): ParagraphAlign | null {
  const boxes = table.cells
    .filter((c) => c.col === col && c.colSpan === 1)
    .map((c) => linesBox(model, c.lines))
    .filter((b): b is Rect => b !== null);
  if (boxes.length < 2) return null;
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  const s = [
    spread(boxes.map((b) => b[0])),
    spread(boxes.map((b) => b[2])),
    spread(boxes.map((b) => (b[0] + b[2]) / 2)),
  ];
  const best = Math.min(...s);
  if (s[0] === best) return 'left';
  if (s[1] === best) return 'right';
  return 'center';
}

function gapAlign(text: Rect, box: Rect): ParagraphAlign {
  const l = text[0] - box[0];
  const r = box[2] - text[2];
  if (Math.abs(l - r) < 1) return 'center';
  return r < l ? 'right' : 'left';
}

/**
 * 앞 줄 끝에서 줄을 바꾼 것이 자동 줄바꿈인가: 다음 줄 첫 단어(+ 공백 0.25em)가 앞 줄 뒤 셀 안쪽 폭에 들어가지 않았으면
 * 자동 줄바꿈(공백으로 잇기), 들어갔으면 강제 줄바꿈("\n"). 오른쪽·가운데 정렬로 쌓은 짧은 줄(숫자 열 등)도 판정한다.
 */
function wrapped(model: PageModel, prev: number, next: number, innerWidth: number): boolean {
  const a = model.lines[prev];
  const b = model.lines[next];
  if (!a || !b) return false;
  const visible = b.chars.map((i) => model.chars[i]!);
  const start = visible.findIndex((c) => c.text.trim() !== '');
  if (start < 0) return false;
  let end = start;
  while (end + 1 < visible.length && visible[end + 1]!.text.trim() !== '') end++;
  const qx = (q: readonly number[]) => [Math.min(q[0]!, q[4]!), Math.max(q[2]!, q[6]!)] as const;
  const word = qx(visible[end]!.quad)[1] - qx(visible[start]!.quad)[0];
  const size = visible[start]!.size || 10;
  const width = a.bbox[2] - a.bbox[0];
  return width + 0.25 * size + word > innerWidth - 0.5;
}

/** 문단 안 줄 사이 공백 중 강제 줄바꿈으로 볼 곳을 "\n" 으로 바꾼 텍스트(길이·글자 대응은 그대로). */
function lineBreaks(model: PageModel, p: LayoutParagraph, innerWidth: number): string {
  if (p.lines.length < 2) return p.text;
  const text = p.text;
  const map = offsetMap(p, model.chars);
  const lineAt = map.map((ci) => (ci >= 0 ? model.chars[ci]!.line : -2));
  const breaks: number[] = [];
  for (let k = 1; k < p.lines.length; k++) {
    const prev = p.lines[k - 1]!;
    const next = p.lines[k]!;
    const last = lineAt.lastIndexOf(prev);
    const first = lineAt.indexOf(next, last + 1);
    // 줄 사이가 공백 하나일 때만(줄 끝 하이픈으로 붙인 경우는 그대로).
    if (last < 0 || first !== last + 2 || text[last + 1] !== ' ') continue;
    if (!wrapped(model, prev, next, innerWidth)) breaks.push(last + 1);
  }
  let out = text;
  for (const i of breaks) out = `${out.slice(0, i)}\n${out.slice(i + 1)}`;
  return out;
}

/** 셀 문단들을 한 문단으로 잇는다(D1). 줄 사이·문단 사이는 자동 줄바꿈이면 공백, 아니면 "\n". */
function mergeParagraphs(
  model: PageModel,
  paras: readonly LayoutParagraph[],
  innerWidth: number,
): LayoutParagraph {
  const first = paras[0]!;
  if (paras.length === 1) return { ...first, text: lineBreaks(model, first, innerWidth) };
  let text = '';
  const chars: number[] = [];
  const lines: number[] = [];
  const styleRuns: StyleRun[] = [];
  let bbox: Rect | null = null;
  paras.forEach((p, k) => {
    if (k > 0) text += joiner(model, paras[k - 1]!, p, innerWidth);
    const off = chars.length;
    for (const r of p.styleRuns) styleRuns.push({ ...r, start: r.start + off, end: r.end + off });
    text += lineBreaks(model, p, innerWidth);
    chars.push(...p.chars);
    lines.push(...p.lines);
    bbox = unionRect(bbox, p.bbox);
  });
  return {
    ...first,
    bbox: bbox!,
    lines,
    chars,
    text,
    styleRuns,
    firstLineIndent: 0,
    continuesTo: null,
  };
}

/** 첫 보이는 글자의 기준선 y. */
function baselineOf(model: PageModel, line: number): number | null {
  const l = model.lines[line];
  const c = l?.chars.map((i) => model.chars[i]!).find((ch) => ch.text.trim() !== '');
  return c ? c.origin[1] : null;
}

/** 문단 사이: 자동 줄바꿈이고 기준선 간격이 앞 문단 줄 간격과 같으면(±10%) 공백, 아니면 "\n". */
function joiner(
  model: PageModel,
  prev: LayoutParagraph,
  next: LayoutParagraph,
  innerWidth: number,
): string {
  const lastLine = prev.lines.at(-1);
  const firstLine = next.lines[0];
  if (lastLine === undefined || firstLine === undefined) return '\n';
  const b0 = baselineOf(model, lastLine);
  const b1 = baselineOf(model, firstLine);
  const ref = prev.lineHeight ?? next.lineHeight;
  const pitch = b0 !== null && b1 !== null ? b1 - b0 : null;
  const sameLeading = ref !== null && pitch !== null && Math.abs(pitch - ref) <= 0.1 * ref;
  return sameLeading && wrapped(model, lastLine, firstLine, innerWidth) ? ' ' : '\n';
}

/** 셀 문단들의 보이는(공백류가 아닌) 글자 상자 가로 범위. 없으면 null. */
function inkSpan(model: PageModel, paras: readonly LayoutParagraph[]): [number, number] | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const p of paras) {
    for (const c of p.chars) {
      const ch = model.chars[c];
      if (!ch || ch.text.trim() === '') continue;
      const q = ch.quad;
      x0 = Math.min(x0, q[0], q[2], q[4], q[6]);
      x1 = Math.max(x1, q[0], q[2], q[4], q[6]);
    }
  }
  return x0 <= x1 ? [x0, x1] : null;
}

/** 문단 paragraphId 의 셀 대상. 표 셀 문단이 아니면 null. */
export function cellTarget(
  model: PageModel,
  layout: PageLayout,
  paragraphId: number,
): CellTarget | null {
  const found = cellOfParagraph(layout, paragraphId);
  if (!found) return null;
  const { table, cell } = found;
  const paras = cell.paragraphs
    .map((id) => layout.paragraphs.find((p) => p.id === id))
    .filter((p): p is LayoutParagraph => p !== undefined);
  if (paras.length === 0) return null;
  const box =
    table.strategy === 'text' ? textCellBox(model, table, cell) : ([...cell.bbox] as Rect);
  let text: Rect | null = null;
  for (const p of paras) text = unionRect(text, p.bbox);
  const t = text!;
  const gap = [t[0] - box[0], t[1] - box[1], box[2] - t[2], box[3] - t[3]].map((g) =>
    Math.max(0, g),
  );
  const m = gap.map((g) => Math.min(g, MARGIN));
  // 원 글자가 셀 상자 밖으로 나온 셀(괘선에 걸친 글자, 셀 배정은 줄 가운데 기준)도 같은 텍스트가 초과가 되지 않게
  // 원 글자 상자를 상한에 합친다.
  const limit = unionRect([box[0] + m[0]!, box[1] + m[1]!, box[2] - m[2]!, box[3] - m[3]!], t);
  const align =
    (table.strategy === 'text' && cell.colSpan === 1
      ? columnAlign(model, table, cell.col)
      : null) ?? gapAlign(t, box);
  // 정렬한 변은 원 간격(위치 보존), 반대 변은 셀 경계 − 여백. 정렬한 변의 위치는 보이는 글자 잉크의 가로 범위로 정한다:
  // 문단 상자는 줄 끝 공백 글리프까지 덮어, 리플로우 줄(줄 끝 공백 제외)이 가운데 정렬은 공백 폭 절반, 오른쪽 정렬은
  // 공백 폭만큼 밀린다(docs/m4-pdf-ops.md 6절 #7, fed-combined-finstmt-2025 8쪽 1.0pt). 정렬 판정은 문단 상자 그대로.
  const [i0, i1] = inkSpan(model, paras) ?? [t[0], t[2]];
  let areaX: [number, number];
  if (align === 'right') areaX = [limit[0], i1];
  else if (align === 'center') {
    const side = Math.min(i0 - limit[0], limit[2] - i1);
    areaX = [i0 - side, i1 + side];
  } else areaX = [i0, limit[2]];
  const paragraph = mergeParagraphs(model, paras, limit[2] - limit[0]);
  let lineHeight = paras[0]!.lineHeight;
  if (lineHeight === null) {
    const bases = paragraph.lines
      .map((li) => baselineOf(model, li))
      .filter((b): b is number => b !== null)
      .sort((a, b) => a - b);
    const pitches = bases
      .slice(1)
      .map((b, i) => b - bases[i]!)
      .filter((d) => d > 0.5);
    pitches.sort((a, b) => a - b);
    lineHeight = pitches.length > 0 ? pitches[Math.floor(pitches.length / 2)]! : null;
  }
  return {
    table,
    cell,
    box,
    limit,
    areaX,
    align,
    lineHeight,
    paragraph,
    members: new Set(paras.map((p) => p.id)),
  };
}
