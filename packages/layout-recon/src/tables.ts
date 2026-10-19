/**
 * 표 검출(계약 3절 3단계). 괘선 전략과 정렬 전략.
 *
 * 괘선 전략(PyMuPDF·pdfplumber `find_tables` lines 전략 포팅 + 글자 보정)
 *   1. 선분: 괘선(Rule) + 채움 사각형 4변. 스냅(3pt) → 이음(3pt) → 3pt 미만 버림.
 *   2. 띠 닫기: 양 끝이 같은 가로선 쌍(booktabs 위·가운데·아래 줄, 줄무늬 행, 바깥 세로선 없는 표) 사이
 *      띠에 글자가 표처럼 놓이면 양 끝에 가상 세로선을 넣는다. 가로선만 있는 표가 이 경로로 들어온다.
 *   3. 교차점(3pt) → 최소 셀(네 모서리가 교차점이고 네 변이 선분으로 이어진 사각형) → 모서리를 공유하는
 *      셀 묶음 = 표 후보. 행·열 경계 = 셀 변의 서로 다른 값.
 *   4. 글자 보정(가장 잘게 나뉜 격자): 괘선 열 안의 투영 빈틈을 열 경계로 더하고, 괘선 행 안에서 여러 열이
 *      같은 기준선으로 이어지면(행 괘선 없는 본문) 기준선 행으로 나눈다.
 *   5. 유지 조건: 2행·2열 이상, 글자 있는 셀 2개 이상·30% 이상. 안쪽 세로 괘선이 없는 띠 표는 글자 정렬
 *      검사(여러 셀 행, 산문 아님)를 더 거친다. 복잡 도형이 덮은 영역(차트)은 버린다.
 * 정렬 전략(괘선 표 밖 줄)
 *   기준선 행 → 짧은 조각 둘 이상인 행이 이어지는 구간 → 투영 빈틈 열 → 정렬·산문·숫자 열·도형 검사.
 * 조각: 줄의 단어 상자를 간격 기준으로 합친 것. MuPDF 가 공백 글자로 채운 숫자 줄(한 줄에 여러 열)도
 *   조각으로는 열마다 나뉜다. 줄 배정은 줄 단위(줄 상자 중심, 여러 셀에 걸치면 글자 중심 다수결)이고
 *   줄 하나는 표 하나·셀 하나에만 든다.
 */
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import type { LineFeature } from './features.js';
import { C as RECON } from './constants.js';
import { median } from './geom.js';
import type { PathSummary } from './paths.js';

export interface DetectedCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: Rect;
  /** 셀 안 줄(LineFeature.index = PageModel.lines 인덱스), 위→아래·왼쪽→오른쪽. */
  lines: number[];
}

export interface DetectedTable {
  bbox: Rect;
  /** rows+1 개, 위→아래. */
  rowBounds: number[];
  /** cols+1 개, 왼쪽→오른쪽. */
  colBounds: number[];
  /** 덮는 셀만(병합 셀은 하나). 빈 셀도 넣는다. */
  cells: DetectedCell[];
  strategy: 'lines' | 'text';
  /** 표 괘선·배경으로 쓴 PageModel.paths 인덱스(도형 검출에서 뺀다). */
  paths: number[];
}

/**
 * 표 검출 상수(계약 3절 3단계). 길이는 pt, *Em 은 글자 크기 배수, *Ratio 는 비율.
 * constants.ts 의 C 와 같은 규칙으로 정확도 하네스 dev 세트로만 조정한다.
 */
export const T = {
  // ── 괘선 전략 ──
  /** 같은 선 위 선분 스냅 허용. */
  snap: 3,
  /** 끊긴 선분 이음 간격. */
  join: 3,
  /** 이보다 짧은 선분은 버린다. */
  minEdge: 3,
  /** 교차점 허용. */
  intersect: 3,
  /** 셀 경계가 이 거리 이내로 붙으면 한 경계로 모은다(가는 빈 행·열 방지). */
  minCell: 6,
  /** 쪽 배경으로 보고 버리는 채움 사각형(쪽 폭·높이 대비). */
  pageBoxRatio: 0.9,
  /** 띠 닫기: 가로선 양 끝 일치 허용. */
  closeEnd: 6,
  /** 띠 닫기: 이보다 짧은 가로선은 쓰지 않는다. */
  closeMinWidth: 30,
  /** 띠 닫기: 글자 없는 띠를 닫는 최대 높이. */
  closeEmptyMax: 20,
  /** 띠 닫기: 한두 행짜리 얇은 띠(머리 행·구역 행)로 보는 최대 높이(행 수 × 줄 높이 배수). */
  thinBandRatio: 2.2,
  /** 괘선에서 이 거리(snap 초과) 안쪽에 평행한 채움 사각형 변은 셀 배경 여백으로 보고 버린다. */
  boxInset: 8,
  /** 채움 색 성분이 모두 이 값 이상이면 흰 배경 사각형으로 보고 변을 쓰지 않는다. */
  whiteBox: 0.97,
  /** 조각 합치기(열 투영용): 단어 간격이 이 배수 미만이면 한 조각. 열 빈틈 최소 폭도 같다. */
  colGapEm: 0.8,
  /** 열 빈틈 최소 폭 하한. */
  colGapMin: 2,
  /** 열 빈틈을 가로질러도 되는 행 비율(여러 열에 걸친 머리 셀 허용). */
  colCrossRatio: 0.15,
  /** 괘선 표 글자 열 경계: 빈틈 양쪽에 조각이 있는 최소 행 수. */
  gapSupport: 2,
  /** 괘선 행 나누기: 기준선 행의 찬 열 수 중앙값이 행 안 글자 있는 열 수의 이 비율 이상. */
  splitFillRatio: 0.6,
  /** 괘선 행 나누기: 기준선 행 중앙값과 줄 기준선 차이 허용(글자 크기 배수). */
  alignBaseEm: 0.25,
  /** 괘선 행 나누기: 기준선이 맞는 줄 비율 하한. */
  alignBaseRatio: 0.8,
  /** 줄바꿈 문단 열(셀 안 여러 줄 문장): 조각 단어 수 중앙값 하한. */
  wrapWords: 3,
  /** 줄바꿈 문단 열: 조각 폭 / 열 폭 중앙값 하한. */
  wrapFill: 0.6,
  /** 셀 경계를 가로지른 줄 판정 여유. */
  crossEps: 1,
  /** 표 유지: 글자 있는 셀 최소 비율. */
  minFilledRatio: 0.3,
  /** 표 유지: 글자 있는 행의 이 비율 이상(최소 2행)에 글자가 있는 열이 둘 이상이어야 한다(도식 거부). */
  richColRatio: 0.3,
  /** 격자 표 유지: 두 셀 이상 찬 행 비율 하한(글자 있는 행 대비). */
  gridMultiRatio: 0.3,
  /** 띠 표 유지: 두 셀 이상 찬 행 비율 하한(글자 있는 행 대비). */
  bandMultiRatio: 0.5,
  /** 산문 열: 조각 단어 수 중앙값 하한. */
  proseWords: 5,
  /** 산문 열: 조각 폭 / 열 폭 중앙값 하한. */
  proseFill: 0.6,
  /** 차트: 복잡 도형(곡선·사선)이 표 상자의 이 비율 이상을 덮으면 버린다. */
  chartCover: 0.4,
  /** 띠 표 확장: 위·아래 행을 붙이는 최대 기준선 간격(행 간격 중앙값 배수). */
  extendPitchRatio: 1.6,
  // ── 정렬 전략 ──
  /** 한 행 안 조각을 나누는 간격(글자 크기 배수). */
  fragGapEm: 1.5,
  /** 짧은 조각(셀 후보) 단어 수 상한. */
  shortWords: 6,
  /** 짧은 조각 폭 상한(글자 크기 배수). */
  shortWidthEm: 18,
  /** 구간 잇기: 기준선 간격이 전형 간격의 이 배수 이하. */
  runPitchRatio: 2,
  /** 구간 안에 둘 수 있는 연속 한 조각 행 수. */
  runSingles: 2,
  /** 정렬 전략: 최소 여러 조각 행 수·열 지지 행 수·정렬 조각 수. */
  textMinRows: 3,
  /** 정렬 허용(왼쪽·오른쪽·가운데). */
  alignTol: 2,
  /** 정렬된 열 비율 하한. */
  alignRatio: 0.6,
  /** 산문 거부: 조각 폭 중앙값 / 구역 폭 상한. */
  textMaxFragRatio: 0.3,
  /** 산문 거부: 조각 단어 수 중앙값 상한. */
  textMaxWords: 4,
  /** 두 열 표: 오른쪽 열 숫자 조각 비율 하한. */
  numericRatio: 0.6,
  /** 정렬 전략 거부: 구역 안 그래픽(세로선·도형·좁은 상자) 수 상한. */
  textMaxGraphics: 4,
} as const;

// ───────────────────────── 공통 자료형 ─────────────────────────

/** 표 판정용 줄(보이는 글자가 있는 가로 줄). */
interface TLine {
  f: LineFeature;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  size: number;
}

/** 한 행 안의 글자 조각(단어 상자를 간격 기준으로 합친 x 구간). */
interface Frag {
  x0: number;
  x1: number;
  /** 첫 단어 줄의 y 중심(셀 채움 판정용). */
  cy: number;
  text: string;
  words: number;
  size: number;
}

/** 기준선 행. */
interface Row {
  lines: TLine[];
  y0: number;
  y1: number;
  /** 같은 행 판정 기준 상자(글자가 가장 많은 줄). */
  ref0: number;
  ref1: number;
  refChars: number;
}

interface Gap {
  x0: number;
  x1: number;
}

/** 표 후보의 셀(가장 잘게 나뉜 격자 인덱스). */
interface GridCell {
  r: number;
  c: number;
  rs: number;
  cs: number;
}

interface Candidate {
  kind: 'grid' | 'band' | 'text';
  rowBounds: number[];
  colBounds: number[];
  cells: GridCell[];
  /** 줄 → 셀 인덱스. */
  assign: Map<TLine, number>;
  paths: number[];
}

const NUMERIC_RE = /^[\s$€£¥₩+\-–—−(]*(?:\d[\d,.\s]*|\.\d+)[%)*]*$|^[\s.…–—-]+$|^n\/?a$/iu;
/** 혼자서는 열이 되지 않는 기호(통화·부호). 오른쪽 숫자 셀에 붙는다. */
const SYMBOL_RE = /^[$€£¥₩+\-–—−±]$/u;

const centerIn = (l: TLine, x0: number, y0: number, x1: number, y1: number): boolean =>
  l.cx >= x0 && l.cx <= x1 && l.cy >= y0 && l.cy <= y1;

const fragCx = (f: Frag): number => (f.x0 + f.x1) / 2;

/** 정렬된 경계 배열에서 v 가 드는 칸(0..n-1, 바깥은 끝 칸으로 붙인다). */
function locate(bounds: readonly number[], v: number): number {
  let lo = 0;
  let hi = bounds.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid]! <= v) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function uniqSorted(xs: readonly number[], tol = 0.01): number[] {
  const s = [...xs].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) if (out.length === 0 || x - out.at(-1)! > tol) out.push(x);
  return out;
}

function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
}

// ───────────────────────── 줄·행·조각 ─────────────────────────

function prepareLines(lines: readonly LineFeature[]): TLine[] {
  const out: TLine[] = [];
  for (const f of lines) {
    if (!f.horizontal || f.text.trim() === '') continue;
    const [x0, y0, x1, y1] = f.bbox;
    out.push({ f, x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, size: f.size || y1 - y0 });
  }
  return out;
}

/**
 * 기준선 행 묶기: y 중심 순으로 훑으며, 최근 두 행의 기준 상자와 세로 겹침이 낮은 쪽 높이의
 * 50% 이상이면 그 행에 넣는다. 행 안 줄은 x 순, 행은 위→아래.
 */
function clusterRows(ls: readonly TLine[]): Row[] {
  const sorted = [...ls].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const rows: Row[] = [];
  for (const l of sorted) {
    const h = Math.max(l.y1 - l.y0, 0.1);
    let target: Row | null = null;
    for (let k = rows.length - 1; k >= Math.max(0, rows.length - 2); k--) {
      const r = rows[k]!;
      const ov = Math.min(r.ref1, l.y1) - Math.max(r.ref0, l.y0);
      if (ov >= 0.5 * Math.min(h, Math.max(r.ref1 - r.ref0, 0.1))) {
        target = r;
        break;
      }
    }
    if (!target) {
      const n = l.f.chars.length;
      rows.push({ lines: [l], y0: l.y0, y1: l.y1, ref0: l.y0, ref1: l.y1, refChars: n });
      continue;
    }
    target.lines.push(l);
    target.y0 = Math.min(target.y0, l.y0);
    target.y1 = Math.max(target.y1, l.y1);
    if (l.f.chars.length > target.refChars) {
      target.ref0 = l.y0;
      target.ref1 = l.y1;
      target.refChars = l.f.chars.length;
    }
  }
  for (const r of rows) r.lines.sort((a, b) => a.x0 - b.x0);
  return rows.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
}

const rowBaseline = (r: Row): number => median(r.lines.map((l) => l.f.baseline));

/** 줄들의 단어 상자를 x 순으로 모아 간격이 gapEm × 글자 크기 미만이면 한 조각으로 합친다. */
function fragsOf(lines: readonly TLine[], gapEm: number): Frag[] {
  const ws: Frag[] = [];
  for (const l of lines) {
    const boxes = l.f.words.length ? l.f.words : [{ x0: l.x0, x1: l.x1, text: l.f.text }];
    for (const w of boxes)
      if (w.text.trim() !== '')
        ws.push({ x0: w.x0, x1: w.x1, cy: l.cy, text: w.text.trim(), words: 1, size: l.size });
  }
  ws.sort((a, b) => a.x0 - b.x0);
  const out: Frag[] = [];
  for (const w of ws) {
    const cur = out.at(-1);
    if (cur && w.x0 - cur.x1 < gapEm * Math.max(cur.size, w.size)) {
      cur.x1 = Math.max(cur.x1, w.x1);
      cur.text = `${cur.text} ${w.text}`;
      cur.words += 1;
      cur.size = Math.max(cur.size, w.size);
    } else out.push({ ...w });
  }
  return out;
}

// ───────────────────────── 투영 빈틈(열) ─────────────────────────

/**
 * 행별 조각 x 구간을 투영해 안쪽 빈틈을 찾는다. 빈틈은 (a) 어느 행도 덮지 않은 구간, 또는 (b) 덮는 행이
 * allowance 개 이하이고 그 조각들이 모두 구간 밖으로 삐져나가는(여러 열에 걸친 머리 셀) 구간이다.
 * (b) 에서 구간 안에 갇힌 조각이 있으면(드문드문 찬 열) 빈틈이 아니다. 폭 minWidth 미만은 버린다.
 */
function findGaps(rows: readonly Frag[][], minWidth: number, allowance: number): Gap[] {
  const empty = coverageGaps(rows, 0).filter((g) => g.x1 - g.x0 >= minWidth);
  if (allowance <= 0) return empty;
  const all = rows.flat();
  const bridged = coverageGaps(rows, allowance).filter(
    (g) =>
      g.x1 - g.x0 >= minWidth &&
      !empty.some((e) => e.x1 > g.x0 && e.x0 < g.x1) &&
      !all.some((f) => f.x0 >= g.x0 - 0.5 && f.x1 <= g.x1 + 0.5),
  );
  return [...empty, ...bridged].sort((a, b) => a.x0 - b.x0);
}

/** 조각이 덮는 행 수가 allowance 이하인 안쪽 x 구간들(투영). */
function coverageGaps(rows: readonly Frag[][], allowance: number): Gap[] {
  const ev: [number, number][] = [];
  for (const fr of rows) {
    const iv = fr.map((f) => [f.x0, f.x1] as [number, number]).sort((a, b) => a[0] - b[0]);
    let cur: [number, number] | null = null;
    for (const [a, b] of iv) {
      if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else {
        if (cur) ev.push([cur[0], 1], [cur[1], -1]);
        cur = [a, b];
      }
    }
    if (cur) ev.push([cur[0], 1], [cur[1], -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const gaps: Gap[] = [];
  let cnt = 0;
  let prev = ev[0]?.[0] ?? 0;
  for (const [x, d] of ev) {
    if (x > prev && cnt <= allowance) {
      const last = gaps.at(-1);
      if (last && last.x1 >= prev) last.x1 = x;
      else gaps.push({ x0: prev, x1: x });
    }
    cnt += d;
    prev = x;
  }
  return gaps;
}

/** 빈틈 양쪽(lo..hi 안)에 조각이 모두 있는 행 수. */
function gapSupport(rows: readonly Frag[][], g: Gap, lo: number, hi: number): number {
  let n = 0;
  for (const fr of rows) {
    const left = fr.some((f) => f.x1 <= g.x0 + 0.5 && f.x0 >= lo - 0.5);
    const right = fr.some((f) => f.x0 >= g.x1 - 0.5 && f.x1 <= hi + 0.5);
    if (left && right) n++;
  }
  return n;
}

const minGapWidth = (size: number): number => Math.max(T.colGapMin, T.colGapEm * size);

// ───────────────────────── 열 성격 ─────────────────────────

interface ColStat {
  frags: Frag[];
  /** 긴 문장 조각(산문·셀 안 줄바꿈 문단). */
  prose: boolean;
  /** 숫자 조각 비율. */
  numeric: number;
  /** 통화·부호 기호만 있는 열. */
  symbolOnly: boolean;
}

/** 조각을 중심 x 로 열에 나눠 열마다 성격을 본다. */
function columnStats(frags: readonly Frag[], cb: readonly number[]): ColStat[] {
  const cols: Frag[][] = cb.slice(1).map(() => []);
  for (const f of frags) cols[locate(cb, fragCx(f))]!.push(f);
  return cols.map((fs, k) => {
    const w = Math.max(cb[k + 1]! - cb[k]!, 1);
    const words = median(fs.map((f) => f.words));
    const fill = median(fs.map((f) => (f.x1 - f.x0) / w));
    return {
      frags: fs,
      prose: fs.length > 0 && words >= T.proseWords && fill >= T.proseFill,
      numeric: fs.length ? fs.filter((f) => NUMERIC_RE.test(f.text)).length / fs.length : 0,
      symbolOnly: fs.length > 0 && fs.every((f) => SYMBOL_RE.test(f.text)),
    };
  });
}

/** 글자 열 경계 중 왼쪽 열이 통화·부호 기호만이면 지운다(기호는 오른쪽 숫자 셀에 붙는다). */
function mergeCurrencyCols(
  cb: readonly number[],
  frags: readonly Frag[],
  removable: (x: number) => boolean,
): number[] {
  const stats = columnStats(frags, cb);
  return cb.filter(
    (x, i) => !(i > 0 && i < cb.length - 1 && removable(x) && stats[i - 1]?.symbolOnly),
  );
}

// ───────────────────────── 줄 배정 ─────────────────────────

/** 줄이 드는 격자 칸. 경계를 넘는 줄은 글자 중심 다수결. */
function gridPosOfLine(
  model: PageModel,
  l: TLine,
  rb: readonly number[],
  cb: readonly number[],
): [number, number] {
  const r = locate(rb, l.cy);
  const c = locate(cb, l.cx);
  const e = T.crossEps;
  if (l.x0 >= cb[c]! - e && l.x1 <= cb[c + 1]! + e && l.y0 >= rb[r]! - e && l.y1 <= rb[r + 1]! + e)
    return [r, c];
  const votes = new Map<number, number>();
  let best: [number, number] = [r, c];
  let bestN = 0;
  for (const ci of l.f.chars) {
    const ch = model.chars[ci];
    if (!ch || ch.text.trim() === '') continue;
    const q = ch.quad;
    const x = (Math.min(q[0], q[2], q[4], q[6]) + Math.max(q[0], q[2], q[4], q[6])) / 2;
    const y = (Math.min(q[1], q[3], q[5], q[7]) + Math.max(q[1], q[3], q[5], q[7])) / 2;
    const rr = locate(rb, y);
    const cc = locate(cb, x);
    const key = rr * 100000 + cc;
    const n = (votes.get(key) ?? 0) + 1;
    votes.set(key, n);
    if (n > bestN) {
      bestN = n;
      best = [rr, cc];
    }
  }
  return best;
}

/** 격자 칸 → 셀 인덱스 표(-1 = 빈 칸). */
function ownerGrid(cells: readonly GridCell[], nr: number, nc: number): Int32Array {
  const own = new Int32Array(nr * nc).fill(-1);
  cells.forEach((c, i) => {
    for (let r = c.r; r < c.r + c.rs; r++)
      for (let k = c.c; k < c.c + c.cs; k++) own[r * nc + k] = i;
  });
  return own;
}

function assignLines(
  model: PageModel,
  ls: readonly TLine[],
  rb: readonly number[],
  cb: readonly number[],
  cells: readonly GridCell[],
): Map<TLine, number> {
  const nc = cb.length - 1;
  const own = ownerGrid(cells, rb.length - 1, nc);
  const out = new Map<TLine, number>();
  for (const l of ls) {
    const [r, c] = gridPosOfLine(model, l, rb, cb);
    const k = own[r * nc + c]!;
    if (k >= 0) out.set(l, k);
  }
  return out;
}

/** 격자에서 어느 셀도 덮지 않은 칸을 1×1 빈 셀로 채운다. */
function fillHoles(cells: GridCell[], nr: number, nc: number): void {
  const own = ownerGrid(cells, nr, nc);
  for (let r = 0; r < nr; r++)
    for (let c = 0; c < nc; c++) if (own[r * nc + c]! < 0) cells.push({ r, c, rs: 1, cs: 1 });
}

// ───────────────────────── 괘선 전략: 선분 ─────────────────────────

interface Edge {
  o: 'h' | 'v';
  /** h: y, v: x. */
  pos: number;
  /** h: x0..x1, v: y0..y1. */
  a0: number;
  a1: number;
  paths: number[];
  virt: boolean;
}

/** 괘선과 채움 사각형 4변을 선분으로 모은다. 쪽 전체 배경 사각형은 뺀다. */
function collectEdges(model: PageModel, ps: PathSummary): Edge[] {
  const pw = model.bounds[2] - model.bounds[0];
  const ph = model.bounds[3] - model.bounds[1];
  const out: Edge[] = [];
  const add = (o: 'h' | 'v', pos: number, a0: number, a1: number, path: number | null): void => {
    if (a1 - a0 >= 1) out.push({ o, pos, a0, a1, paths: path === null ? [] : [path], virt: false });
  };
  for (const r of ps.rules) {
    if (r.orient === 'h') add('h', r.y0, r.x0, r.x1, r.path);
    else add('v', r.x0, r.y0, r.y1, r.path);
  }
  // 두께 thinBoxMax 이하의 가는 이미지도 괘선이다(LaTeX 출력 일부는 표 괘선을 1픽셀 이미지로 그린다).
  for (const im of model.images) {
    const [x0, y0, x1, y1] = im.bbox;
    if (y1 - y0 <= RECON.thinBoxMax && x1 - x0 > RECON.thinBoxMax)
      add('h', (y0 + y1) / 2, x0, x1, null);
    else if (x1 - x0 <= RECON.thinBoxMax && y1 - y0 > RECON.thinBoxMax)
      add('v', (x0 + x1) / 2, y0, y1, null);
  }
  // 채움 사각형 변: 보이는 변만 쓴다. (a) 흰색에 가까운 사각형, (b) 바로 바깥 띠가 같은 색 사각형으로
  // 덮인 변(같은 색끼리 붙거나 포갠 배경), (c) 괘선 바로 안쪽(snap 초과 boxInset 이하)에 평행한 변(셀 안
  // 배경 여백)은 버린다. 셀마다 줄여 그린 배경이 가는 빈 행·열을 만들지 않게 한다.
  const hRules = out.filter((e) => e.o === 'h');
  const vRules = out.filter((e) => e.o === 'v');
  const insetOfRule = (rules: readonly Edge[], pos: number, a0: number, a1: number): boolean =>
    rules.some((r) => {
      const d = Math.abs(r.pos - pos);
      const cover = Math.min(r.a1, a1) - Math.max(r.a0, a0);
      return d > T.snap && d <= T.boxInset && cover >= 0.8 * (a1 - a0);
    });
  const boxes = ps.boxes.filter((b) => {
    const [x0, y0, x1, y1] = b.bbox;
    if (x1 - x0 >= T.pageBoxRatio * pw && y1 - y0 >= T.pageBoxRatio * ph) return false;
    return !(b.color && b.color.every((c) => c >= T.whiteBox));
  });
  const byColor = new Map<string, Rect[]>();
  for (const b of boxes) pushTo(byColor, colorKey(b.color), b.bbox);
  for (const b of boxes) {
    const [x0, y0, x1, y1] = b.bbox;
    const same = b.color ? (byColor.get(colorKey(b.color)) ?? []) : [];
    // 변 바깥 1pt 띠의 표본 5점이 모두 같은 색 사각형 안이면 보이지 않는 변이다.
    const hidden = (pts: [number, number][]): boolean =>
      pts.every(([x, y]) =>
        same.some((r) => r !== b.bbox && x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]),
      );
    const along = (a0: number, a1: number): number[] =>
      [0.1, 0.3, 0.5, 0.7, 0.9].map((t) => a0 + t * (a1 - a0));
    if (!insetOfRule(hRules, y0, x0, x1) && !hidden(along(x0, x1).map((x) => [x, y0 - 1])))
      add('h', y0, x0, x1, b.path);
    if (!insetOfRule(hRules, y1, x0, x1) && !hidden(along(x0, x1).map((x) => [x, y1 + 1])))
      add('h', y1, x0, x1, b.path);
    if (!insetOfRule(vRules, x0, y0, y1) && !hidden(along(y0, y1).map((y) => [x0 - 1, y])))
      add('v', x0, y0, y1, b.path);
    if (!insetOfRule(vRules, x1, y0, y1) && !hidden(along(y0, y1).map((y) => [x1 + 1, y])))
      add('v', x1, y0, y1, b.path);
  }
  return out;
}

/** 채움 색 비교 키(0.02 단위로 반올림). 색을 모르면 고유하지 않은 빈 키. */
const colorKey = (c: readonly number[] | null): string =>
  c ? c.map((v) => Math.round(v * 50)).join(',') : '';

/** 같은 방향 선분의 위치를 tol 이내 사슬 군집 평균으로 맞춘다(pdfplumber snap_edges). */
function snapEdges(es: readonly Edge[], tol: number): void {
  const s = [...es].sort((a, b) => a.pos - b.pos);
  let i = 0;
  while (i < s.length) {
    let j = i + 1;
    while (j < s.length && s[j]!.pos - s[j - 1]!.pos <= tol) j++;
    let sum = 0;
    for (let k = i; k < j; k++) sum += s[k]!.pos;
    for (let k = i; k < j; k++) s[k]!.pos = sum / (j - i);
    i = j;
  }
}

/** 같은 위치 선분을 간격 tol 이하면 잇고, 길이 minLen 미만은 버린다(pdfplumber join_edge_group). */
function joinEdges(es: readonly Edge[], tol: number, minLen: number): Edge[] {
  const byPos = new Map<number, Edge[]>();
  for (const e of es) pushTo(byPos, e.pos, e);
  const out: Edge[] = [];
  for (const g of byPos.values()) {
    g.sort((a, b) => a.a0 - b.a0);
    let cur: Edge | null = null;
    for (const e of g) {
      if (cur && e.a0 <= cur.a1 + tol) {
        cur.a1 = Math.max(cur.a1, e.a1);
        cur.paths.push(...e.paths);
        cur.virt = cur.virt && e.virt;
      } else {
        if (cur) out.push(cur);
        cur = { ...e, paths: [...e.paths] };
      }
    }
    if (cur) out.push(cur);
  }
  return out.filter((e) => e.a1 - e.a0 >= minLen);
}

/**
 * 띠 안 글자가 표 행처럼 놓였는지(띠 닫기 판정). 빈 띠는 얇을 때만, 한두 행짜리 얇은 띠(머리 행·구역 행)는
 * 그대로, 그 밖은 열 빈틈이 두 행 이상에서 지지되고 모든 열이 산문은 아닐 때 닫는다.
 */
function bandLooksTabular(
  ls: readonly TLine[],
  x0: number,
  x1: number,
  top: number,
  bottom: number,
): boolean {
  const inBand = ls.filter((l) => centerIn(l, x0, top, x1, bottom));
  if (inBand.length === 0) return bottom - top <= T.closeEmptyMax;
  const rows = clusterRows(inBand);
  const size = median(inBand.map((l) => l.size));
  const lineH = median(inBand.map((l) => l.y1 - l.y0));
  if (rows.length <= 2 && bottom - top <= T.thinBandRatio * rows.length * lineH) return true;
  const frs = rows.map((r) => fragsOf(r.lines, T.colGapEm));
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * rows.length)).filter(
    (g) => gapSupport(frs, g, x0, x1) >= T.gapSupport,
  );
  if (gaps.length === 0) return false;
  const cb = [x0, ...gaps.map((g) => (g.x0 + g.x1) / 2), x1];
  const stats = columnStats(frs.flat(), cb).filter((s) => s.frags.length > 0);
  return !stats.every((s) => s.prose);
}

/**
 * 띠 닫기: 양 끝이 같은 긴 가로선끼리 묶어 위아래로 이웃한 쌍 사이 띠가 표처럼 보이면
 * 양 끝에 가상 세로선을 만든다.
 */
function closeBands(h: readonly Edge[], ls: readonly TLine[]): Edge[] {
  const long = h.filter((e) => e.a1 - e.a0 >= T.closeMinWidth);
  const parent = long.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < long.length; i++)
    for (let j = i + 1; j < long.length; j++) {
      const a = long[i]!;
      const b = long[j]!;
      if (Math.abs(a.a0 - b.a0) <= T.closeEnd && Math.abs(a.a1 - b.a1) <= T.closeEnd)
        parent[find(i)] = find(j);
    }
  const groups = new Map<number, Edge[]>();
  long.forEach((e, i) => pushTo(groups, find(i), e));
  const out: Edge[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.pos - b.pos);
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1]!;
      const b = g[i]!;
      if (b.pos - a.pos <= T.snap) continue;
      // 끝이 조금 다르면 안쪽 끝에 세운다(두 가로선 모두와 교차하도록).
      const x0 = Math.max(a.a0, b.a0);
      const x1 = Math.min(a.a1, b.a1);
      if (!bandLooksTabular(ls, x0, x1, a.pos, b.pos)) continue;
      out.push(
        { o: 'v', pos: x0, a0: a.pos, a1: b.pos, paths: [], virt: true },
        { o: 'v', pos: x1, a0: a.pos, a1: b.pos, paths: [], virt: true },
      );
    }
  }
  return out;
}

// ───────────────────────── 괘선 전략: 교차점·셀 ─────────────────────────

interface Pt {
  x: number;
  y: number;
  /** 지나는 가로·세로 선분 인덱스. */
  h: Set<number>;
  v: Set<number>;
}

const ptKey = (x: number, y: number): string => `${x}|${y}`;

/** 세로·가로 선분 교차점(허용 tol). 키는 (세로선 x, 가로선 y). */
function intersections(h: readonly Edge[], v: readonly Edge[], tol: number): Map<string, Pt> {
  const hs = h.map((e, i) => ({ e, i })).sort((a, b) => a.e.pos - b.e.pos);
  const pts = new Map<string, Pt>();
  v.forEach((ve, vi) => {
    // 가로선 y 가 [a0 - tol, a1 + tol] 안인 것만 이분 탐색으로 고른다.
    let lo = 0;
    let hi = hs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid]!.e.pos < ve.a0 - tol) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < hs.length && hs[k]!.e.pos <= ve.a1 + tol; k++) {
      const { e: he, i: hIdx } = hs[k]!;
      if (ve.pos < he.a0 - tol || ve.pos > he.a1 + tol) continue;
      const key = ptKey(ve.pos, he.pos);
      let p = pts.get(key);
      if (!p) {
        p = { x: ve.pos, y: he.pos, h: new Set(), v: new Set() };
        pts.set(key, p);
      }
      p.h.add(hIdx);
      p.v.add(vi);
    }
  });
  return pts;
}

const shares = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * 최소 셀(pdfplumber intersections_to_cells): 교차점마다 아래·오른쪽 교차점을 가까운 순으로 보며
 * 왼쪽·위 변이 선분으로 이어지고 오른쪽 아래 교차점이 오른쪽·아래 변으로 이어지는 첫 사각형.
 */
function findCells(pts: ReadonlyMap<string, Pt>): Rect[] {
  const byX = new Map<number, Pt[]>();
  const byY = new Map<number, Pt[]>();
  for (const p of pts.values()) {
    pushTo(byX, p.x, p);
    pushTo(byY, p.y, p);
  }
  for (const g of byX.values()) g.sort((a, b) => a.y - b.y);
  for (const g of byY.values()) g.sort((a, b) => a.x - b.x);
  const cells: Rect[] = [];
  for (const p of pts.values()) {
    const below = byX.get(p.x)!.filter((q) => q.y > p.y);
    const right = byY.get(p.y)!.filter((q) => q.x > p.x);
    search: for (const b of below) {
      if (!shares(p.v, b.v)) continue;
      for (const r of right) {
        if (!shares(p.h, r.h)) continue;
        const br = pts.get(ptKey(r.x, b.y));
        if (br && shares(br.v, r.v) && shares(br.h, b.h)) {
          cells.push([p.x, p.y, r.x, b.y]);
          break search;
        }
      }
    }
  }
  return cells;
}

/** 모서리를 공유하는 셀끼리 묶는다(pdfplumber cells_to_tables). */
function groupCells(cells: readonly Rect[]): Rect[][] {
  const parent = cells.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const corner = new Map<string, number>();
  cells.forEach((c, i) => {
    for (const k of [ptKey(c[0], c[1]), ptKey(c[2], c[1]), ptKey(c[0], c[3]), ptKey(c[2], c[3])]) {
      const j = corner.get(k);
      if (j === undefined) corner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Rect[]>();
  cells.forEach((c, i) => pushTo(groups, find(i), c));
  return [...groups.values()];
}

// ───────────────────────── 괘선 전략: 표 후보 ─────────────────────────

interface BuildCtx {
  model: PageModel;
  free: readonly TLine[];
  ps: PathSummary;
}

/**
 * 가는 틈 없애기: 셀 경계 값이 minCell 이내로 붙어 있으면(어긋난 배경 사각형·이중선) 한 값으로 모으고
 * 넓이가 없어진 셀은 버린다.
 */
function collapseSlivers(group: readonly Rect[]): Rect[] {
  const snapMap = (vals: number[]): Map<number, number> => {
    const u = uniqSorted(vals);
    const m = new Map<number, number>();
    let start = 0;
    for (let i = 1; i <= u.length; i++) {
      if (i < u.length && u[i]! - u[i - 1]! <= T.minCell) continue;
      const rep = u[(start + i - 1) >> 1]!;
      for (let k = start; k < i; k++) m.set(u[k]!, rep);
      start = i;
    }
    return m;
  };
  const mx = snapMap(group.flatMap((c) => [c[0], c[2]]));
  const my = snapMap(group.flatMap((c) => [c[1], c[3]]));
  const out = new Map<string, Rect>();
  for (const c of group) {
    const r: Rect = [mx.get(c[0])!, my.get(c[1])!, mx.get(c[2])!, my.get(c[3])!];
    if (r[2] > r[0] && r[3] > r[1]) out.set(r.join(','), r);
  }
  return [...out.values()];
}

/** 괘선 셀을 괘선 격자 인덱스로 옮긴다. 겹치는 셀은 작은 것부터 자리를 차지한다. */
function ruledCells(
  group: readonly Rect[],
  R0: readonly number[],
  C0: readonly number[],
): GridCell[] {
  const nc0 = C0.length - 1;
  const occ = new Uint8Array((R0.length - 1) * nc0);
  const area = (c: Rect): number => (c[2] - c[0]) * (c[3] - c[1]);
  const out: GridCell[] = [];
  for (const c of [...group].sort((a, b) => area(a) - area(b))) {
    const r = R0.indexOf(c[1]);
    const rs = R0.indexOf(c[3]) - r;
    const k = C0.indexOf(c[0]);
    const cs = C0.indexOf(c[2]) - k;
    let free = true;
    for (let i = r; i < r + rs && free; i++)
      for (let j = k; j < k + cs; j++) if (occ[i * nc0 + j]) free = false;
    if (!free) continue;
    for (let i = r; i < r + rs; i++) for (let j = k; j < k + cs; j++) occ[i * nc0 + j] = 1;
    out.push({ r, c: k, rs, cs });
  }
  return out;
}

/** 글자 열 경계: 괘선 열 안 투영 빈틈 중 gapSupport 행 이상이 같은 괘선 열 안 양쪽에 조각을 둔 것. */
function textColumnBounds(frs: readonly Frag[][], C0: readonly number[], size: number): number[] {
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * frs.length));
  const out: number[] = [];
  for (const g of gaps) {
    if (C0.some((x) => x >= g.x0 - T.snap && x <= g.x1 + T.snap)) continue;
    const k = locate(C0, (g.x0 + g.x1) / 2);
    if (gapSupport(frs, g, C0[k]!, C0[k + 1]!) >= T.gapSupport) out.push((g.x0 + g.x1) / 2);
  }
  return out;
}

/**
 * 괘선 행 하나를 기준선 행으로 나눌지: 기준선 행이 둘 이상, 두 열 이상 찬 기준선 행이 둘 이상, 찬 열 수
 * 중앙값이 행 안 글자 있는 열 수의 splitFillRatio 이상(기록 행). 여러 줄 열의 절반 이상이 줄바꿈 문단이면
 * (셀 안 긴 문장), 줄 기준선이 기준선 행과 어긋나면(세로 가운데 정렬 머리), 표 맨 위 괘선 행에 숫자 조각이
 * 없으면(여러 줄 열 제목) 나누지 않는다. 나누면 기준선 행 사이 y 들을 돌려준다.
 */
function rowSplits(
  subs: readonly Row[],
  C: readonly number[],
  top: number,
  bottom: number,
  isTopRow: boolean,
): number[] {
  if (subs.length < 2) return [];
  const subFr = subs.map((s) => fragsOf(s.lines, T.colGapEm));
  if (isTopRow && !subFr.flat().some((f) => NUMERIC_RE.test(f.text))) return [];
  const occ = subFr.map((fr) => new Set(fr.map((f) => locate(C, fragCx(f)))).size);
  const nonEmpty = new Set(subFr.flat().map((f) => locate(C, fragCx(f)))).size;
  const multi = occ.filter((n) => n >= 2).length;
  if (multi < 2 || median(occ) < Math.max(2, T.splitFillRatio * nonEmpty)) return [];
  const byCol = new Map<number, Frag[]>();
  for (const f of subFr.flat()) pushTo(byCol, locate(C, fragCx(f)), f);
  let multiLine = 0;
  let wrapped = 0;
  for (const [k, fs] of byCol) {
    if (fs.length < 2) continue;
    multiLine++;
    const w = Math.max(C[k + 1]! - C[k]!, 1);
    const words = median(fs.map((f) => f.words));
    const fill = median(fs.map((f) => (f.x1 - f.x0) / w));
    if (words >= T.wrapWords && fill >= T.wrapFill) wrapped++;
  }
  if (multiLine > 0 && wrapped * 2 >= multiLine) return [];
  // 기준선 정렬: 줄 기준선이 제 기준선 행 중앙값에서 글자 크기 alignBaseEm 배 안이어야 한다. 세로 가운데
  // 정렬된 여러 줄 머리 셀처럼 반 줄씩 어긋난 행은 기록 행이 아니다.
  const lines = subs.flatMap((sr) => sr.lines.map((l) => [l, rowBaseline(sr)] as const));
  const aligned = lines.filter(([l, b]) => Math.abs(l.f.baseline - b) <= T.alignBaseEm * l.size);
  if (aligned.length < T.alignBaseRatio * lines.length) return [];
  // 이어진 줄: 첫 글자 열이 아닌 한 열에만 글자가 있는 기준선 행은 여러 줄 셀의 나머지 줄이므로 기준선이
  // 가까운 이웃 행에 붙인다.
  const groups = subs.map((sr, i) => ({
    y0: sr.y0,
    y1: sr.y1,
    base: rowBaseline(sr),
    cols: new Set(subFr[i]!.map((f) => locate(C, fragCx(f)))),
  }));
  const firstCol = Math.min(...groups.flatMap((g) => [...g.cols]));
  for (let i = 0; i < groups.length && groups.length > 1;) {
    const g = groups[i]!;
    if (g.cols.size !== 1 || g.cols.has(firstCol)) {
      i++;
      continue;
    }
    const up = groups[i - 1];
    const dn = groups[i + 1];
    const target = !up ? dn! : !dn ? up : g.base - up.base <= dn.base - g.base ? up : dn;
    target.y0 = Math.min(target.y0, g.y0);
    target.y1 = Math.max(target.y1, g.y1);
    for (const c of g.cols) target.cols.add(c);
    groups.splice(i, 1);
    i = Math.max(0, i - 1);
  }
  const seps: number[] = [];
  for (let i = 1; i < groups.length; i++) {
    const a = groups[i - 1]!;
    const b = groups[i]!;
    const y = b.y0 >= a.y1 ? (a.y1 + b.y0) / 2 : (a.base + b.y0) / 2;
    if (y > top && y < bottom && (seps.length === 0 || y > seps.at(-1)!)) seps.push(y);
  }
  return seps;
}

/**
 * 괘선 셀 조각(가장 잘게 나뉜 격자 사각형)을 셀로 낸다. 내용 조각이 두 열 이상에 걸치면 줄이 가로지르지
 * 않는 경계에서 나눈다(줄무늬 행·행 괘선 없는 본문). 내용이 한 열뿐이거나 비면 병합 셀 그대로.
 */
function emitPiece(
  out: GridCell[],
  ls: readonly TLine[],
  R: readonly number[],
  C: readonly number[],
  r0: number,
  r1: number,
  c0: number,
  c1: number,
): void {
  if (c1 - c0 === 1) {
    out.push({ r: r0, c: c0, rs: r1 - r0, cs: 1 });
    return;
  }
  const inPiece = ls.filter((l) => centerIn(l, C[c0]!, R[r0]!, C[c1]!, R[r1]!));
  const used = new Set(fragsOf(inPiece, T.colGapEm).map((f) => locate(C, fragCx(f))));
  if (used.size < 2) {
    out.push({ r: r0, c: c0, rs: r1 - r0, cs: c1 - c0 });
    return;
  }
  let start = c0;
  for (let k = c0 + 1; k <= c1; k++) {
    const x = C[k]!;
    const crossed = k < c1 && inPiece.some((l) => l.x0 < x - T.crossEps && l.x1 > x + T.crossEps);
    if (k === c1 || !crossed) {
      out.push({ r: r0, c: start, rs: r1 - r0, cs: k - start });
      start = k;
    }
  }
}

/**
 * 셀 묶음 하나를 표 후보로 만든다. 괘선 격자 → 글자 열 경계 추가 → 괘선 행 나누기 → 셀(병합 유지·분할)
 * → 줄 배정 → 유지 조건 검사. virtCols 는 가상 세로선 x 위치(띠 표 판정용).
 */
function buildLinesTable(
  ctx: BuildCtx,
  group: readonly Rect[],
  virtCols: ReadonlySet<number>,
): Candidate | null {
  // 안쪽 세로 경계에 실제 선이 하나라도 있으면 격자 표, 아니면 띠 표(가상 변만).
  const interiorReal = uniqSorted(group.flatMap((c) => [c[0], c[2]]))
    .slice(1, -1)
    .some((x) => !virtCols.has(x));
  group = collapseSlivers(group);
  const R0 = uniqSorted(group.flatMap((c) => [c[1], c[3]]));
  const C0 = uniqSorted(group.flatMap((c) => [c[0], c[2]]));
  const bbox: Rect = [C0[0]!, R0[0]!, C0.at(-1)!, R0.at(-1)!];
  const ls = ctx.free.filter((l) => centerIn(l, ...bbox));
  if (ls.length === 0) return null;
  const ruled = ruledCells(group, R0, C0);

  // 1) 열: 괘선 열 경계 + 글자 열 경계(통화·부호 기호 열은 오른쪽에 붙인다).
  const rowsAll = clusterRows(ls);
  const frsAll = rowsAll.map((r) => fragsOf(r.lines, T.colGapEm));
  const textBounds = new Set(textColumnBounds(frsAll, C0, median(ls.map((l) => l.size))));
  const C = mergeCurrencyCols(uniqSorted([...C0, ...textBounds]), frsAll.flat(), (x) =>
    textBounds.has(x),
  );

  // 2) 행: 괘선 행 경계 + 기록 행으로 나눈 괘선 행의 기준선 행 경계.
  const splitRows = new Map<number, number[]>();
  for (let r = 0; r < R0.length - 1; r++) {
    const subs = clusterRows(ls.filter((l) => l.cy >= R0[r]! && l.cy < R0[r + 1]!));
    const seps = rowSplits(subs, C, R0[r]!, R0[r + 1]!, r === 0);
    if (seps.length) splitRows.set(r, seps);
  }
  const R = uniqSorted([...R0, ...[...splitRows.values()].flat()]);

  // 3) 셀: 괘선 셀을 잘게 나뉜 격자로 옮긴다. 나눈 괘선 행의 한 행짜리 셀은 기준선 행마다 따로 낸다.
  const cells: GridCell[] = [];
  for (const rc of ruled) {
    const r0 = R.indexOf(R0[rc.r]!);
    const r1 = R.indexOf(R0[rc.r + rc.rs]!);
    const c0 = C.indexOf(C0[rc.c]!);
    const c1 = C.indexOf(C0[rc.c + rc.cs]!);
    if (rc.rs === 1 && splitRows.has(rc.r))
      for (let r = r0; r < r1; r++) emitPiece(cells, ls, R, C, r, r + 1, c0, c1);
    else emitPiece(cells, ls, R, C, r0, r1, c0, c1);
  }
  fillHoles(cells, R.length - 1, C.length - 1);

  // 4) 유지 조건: 크기, 글자 있는 셀 비율, 두 셀 이상 찬 행(격자 30%·띠 50%), 띠 표는 산문 아님, 차트 아님.
  if (R.length < 3 || C.length < 3) return null;
  const assign = assignLines(ctx.model, ls, R, C, cells);
  const fill = cellFill(cells, R, C, frsAll.flat(), assign);
  if (fill.filled < 2 || fill.filled < T.minFilledRatio * cells.length) return null;
  const kind: Candidate['kind'] = R0.length >= 3 && interiorReal ? 'grid' : 'band';
  const multiMin = kind === 'grid' ? T.gridMultiRatio : T.bandMultiRatio;
  if (fill.multiRows < 2 || fill.multiRows < multiMin * fill.textRows) return null;
  if (fill.richCols < 2) return null;
  if (
    kind === 'band' &&
    columnStats(frsAll.flat(), C).every((s) => s.frags.length === 0 || s.prose)
  )
    return null;
  if (chartCovered(ctx.ps, bbox)) return null;
  return { kind, rowBounds: R, colBounds: C, cells, assign, paths: pathsInside(ctx.ps, bbox) };
}

/**
 * 셀 채움: 줄이 배정된 셀 + 조각 중심이 든 셀(공백으로 채운 숫자 줄처럼 한 줄이 여러 셀에 걸친 경우).
 * filled = 글자 있는 셀 수, textRows = 글자 있는 행 수, multiRows = 두 셀 이상 찬 행 수,
 * richCols = 글자 있는 행의 richColRatio 이상(최소 2행)에 글자가 있는 열 수.
 */
function cellFill(
  cells: readonly GridCell[],
  R: readonly number[],
  C: readonly number[],
  frags: readonly Frag[],
  assign: ReadonlyMap<TLine, number>,
): { filled: number; textRows: number; multiRows: number; richCols: number } {
  const nc = C.length - 1;
  const own = ownerGrid(cells, R.length - 1, nc);
  const filled = new Set<number>();
  const perRow = new Map<number, Set<number>>();
  const perCol = new Map<number, Set<number>>();
  const mark = (r: number, k: number): void => {
    if (k < 0) return;
    filled.add(k);
    const set = perRow.get(r) ?? new Set<number>();
    set.add(k);
    perRow.set(r, set);
    const c = cells[k]!.c;
    const rows = perCol.get(c) ?? new Set<number>();
    rows.add(r);
    perCol.set(c, rows);
  };
  for (const [l, k] of assign) mark(locate(R, l.cy), k);
  for (const f of frags) {
    const r = locate(R, f.cy);
    mark(r, own[r * nc + locate(C, fragCx(f))]!);
  }
  const multiRows = [...perRow.values()].filter((x) => x.size >= 2).length;
  const richMin = Math.max(2, T.richColRatio * perRow.size);
  const richCols = [...perCol.values()].filter((x) => x.size >= richMin).length;
  return { filled: filled.size, textRows: perRow.size, multiRows, richCols };
}

/** 복잡 도형(곡선·사선) 상자가 영역의 chartCover 이상을 덮는지(16×16 칸 근사). */
function chartCovered(ps: PathSummary, r: Rect): boolean {
  const shapes = ps.shapes.filter(
    (s) =>
      s.complex && s.bbox[2] > r[0] && s.bbox[0] < r[2] && s.bbox[3] > r[1] && s.bbox[1] < r[3],
  );
  if (shapes.length === 0) return false;
  const N = 16;
  const w = (r[2] - r[0]) / N;
  const h = (r[3] - r[1]) / N;
  let covered = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = r[0] + (i + 0.5) * w;
      const y = r[1] + (j + 0.5) * h;
      if (shapes.some((s) => x >= s.bbox[0] && x <= s.bbox[2] && y >= s.bbox[1] && y <= s.bbox[3]))
        covered++;
    }
  return covered >= T.chartCover * N * N;
}

/** 표 상자 안(괘선 여유 snap)의 괘선·채움 사각형 경로. */
function pathsInside(ps: PathSummary, r: Rect): number[] {
  const tol = T.snap;
  const inside = (x0: number, y0: number, x1: number, y1: number): boolean =>
    x0 >= r[0] - tol && y0 >= r[1] - tol && x1 <= r[2] + tol && y1 <= r[3] + tol;
  const out = new Set<number>();
  for (const e of ps.rules) if (inside(e.x0, e.y0, e.x1, e.y1)) out.add(e.path);
  for (const b of ps.boxes) if (inside(...b.bbox)) out.add(b.path);
  return [...out].sort((a, b) => a - b);
}

/**
 * 띠 표 확장: 가상 변으로 닫힌 띠 표(줄무늬·booktabs) 바로 위·아래 행이 표 x 범위 안에서 두 열 이상을
 * 채우고 기준선 간격이 표 행 간격의 extendPitchRatio 배 이하이면 행으로 붙인다(줄무늬 없는 머리·끝 행).
 */
function extendBand(ctx: BuildCtx, cand: Candidate, taken: ReadonlySet<TLine>): void {
  const C = cand.colBounds;
  const tol = T.snap;
  const pool = ctx.free.filter(
    (l) => !taken.has(l) && !cand.assign.has(l) && l.x0 >= C[0]! - tol && l.x1 <= C.at(-1)! + tol,
  );
  const rows = clusterRows(pool);
  const tableRows = (): Row[] => clusterRows([...cand.assign.keys()]);
  const tr = tableRows();
  const pitch = median(tr.slice(1).map((r, i) => rowBaseline(r) - rowBaseline(tr[i]!)));
  if (!(pitch > 0)) return;
  const fits = (r: Row): boolean =>
    new Set(fragsOf(r.lines, T.colGapEm).map((f) => locate(C, fragCx(f)))).size >= 2;
  const addRow = (r: Row, top: boolean): void => {
    const R = cand.rowBounds;
    let row: number;
    if (top) {
      cand.rowBounds = [Math.min(r.y0, R[0]! - 0.5), ...R];
      for (const c of cand.cells) c.r += 1;
      row = 0;
    } else {
      cand.rowBounds = [...R, Math.max(r.y1, R.at(-1)! + 0.5)];
      row = R.length - 1;
    }
    const base = cand.cells.length;
    for (let k = 0; k < C.length - 1; k++) cand.cells.push({ r: row, c: k, rs: 1, cs: 1 });
    for (const l of r.lines) cand.assign.set(l, base + locate(C, l.cx));
  };
  for (;;) {
    const first = tableRows()[0]!;
    const above = rows.filter((r) => r.y1 <= cand.rowBounds[0]! + 1).at(-1);
    if (!above || above.lines.some((l) => cand.assign.has(l))) break;
    if (rowBaseline(first) - rowBaseline(above) > T.extendPitchRatio * pitch || !fits(above)) break;
    addRow(above, true);
  }
  for (;;) {
    const last = tableRows().at(-1)!;
    const below = rows.find((r) => r.y0 >= cand.rowBounds.at(-1)! - 1);
    if (!below || below.lines.some((l) => cand.assign.has(l))) break;
    if (rowBaseline(below) - rowBaseline(last) > T.extendPitchRatio * pitch || !fits(below)) break;
    addRow(below, false);
  }
}

/** 괘선 전략 전체: 선분 → 띠 닫기 → 교차점 → 셀 → 묶음 → 후보. */
function linesStrategy(ctx: BuildCtx): Candidate[] {
  const raw = collectEdges(ctx.model, ctx.ps);
  const hRaw = raw.filter((e) => e.o === 'h');
  const vRaw = raw.filter((e) => e.o === 'v');
  snapEdges(hRaw, T.snap);
  snapEdges(vRaw, T.snap);
  const h = joinEdges(hRaw, T.join, T.minEdge);
  const vAll = [...joinEdges(vRaw, T.join, T.minEdge), ...closeBands(h, ctx.free)];
  snapEdges(vAll, T.snap);
  const v = joinEdges(vAll, T.join, T.minEdge);
  if (h.length < 2 || v.length < 2) return [];
  // 가상 세로선만 지나는 x(실제 선과 이어진 것은 실제로 본다).
  const virtCols = new Set(v.filter((e) => e.virt).map((e) => e.pos));
  for (const e of v) if (!e.virt) virtCols.delete(e.pos);
  const groups = groupCells(findCells(intersections(h, v, T.intersect)));
  const out: Candidate[] = [];
  for (const g of groups) {
    const C0 = uniqSorted(g.flatMap((c) => [c[0], c[2]]));
    // 네 변이 실제 선인 1×1 상자(글상자·쪽 테두리)는 표가 아니다. 가상 변 띠는 글자 보정으로 본다.
    if (g.length === 1 && !C0.some((x) => virtCols.has(x))) continue;
    const cand = buildLinesTable(ctx, g, virtCols);
    if (cand) out.push(cand);
  }
  return out;
}

// ───────────────────────── 정렬 전략 ─────────────────────────

const isShort = (f: Frag): boolean =>
  f.words <= T.shortWords && f.x1 - f.x0 <= T.shortWidthEm * f.size;

/**
 * 정렬 전략: 남은 줄의 기준선 행에서 짧은 조각이 둘 이상인 행(여러 조각 행)이 이어지는 구간을 찾고,
 * 구간 안 줄로 열(투영 빈틈)·행(기준선)을 만든 뒤 검사한다.
 */
function textStrategy(
  ctx: BuildCtx,
  taken: ReadonlySet<TLine>,
  accepted: readonly Rect[],
): Candidate[] {
  const rows = clusterRows(ctx.free.filter((l) => !taken.has(l)));
  const shorts = rows.map((r) => fragsOf(r.lines, T.fragGapEm).filter(isShort));
  const multi = shorts.map((s) => s.length >= 2);
  const out: Candidate[] = [];
  const used = new Set<TLine>();
  const boxes = [...accepted];
  let i = 0;
  while (i < rows.length) {
    if (!multi[i]) {
      i++;
      continue;
    }
    // 구간 잇기: 기준선 간격이 전형 간격의 runPitchRatio 배 이하, 한 조각 행은 연속 runSingles 개까지.
    const run = [i];
    const pitches: number[] = [];
    let singles = 0;
    let j = i + 1;
    for (; j < rows.length; j++) {
      const d = rowBaseline(rows[j]!) - rowBaseline(rows[run.at(-1)!]!);
      const size = median(rows[j]!.lines.map((l) => l.size));
      const typical = Math.max(pitches.length ? median(pitches) : 0, 1.2 * size);
      if (d > T.runPitchRatio * typical) break;
      if (multi[j]) singles = 0;
      else if (++singles > T.runSingles) break;
      run.push(j);
      pitches.push(d);
    }
    while (run.length && !multi[run.at(-1)!]) run.pop();
    i = Math.max(j, i + 1);
    const multiRuns = run.filter((k) => multi[k]);
    if (multiRuns.length < T.textMinRows) continue;
    const cand = buildTextTable(
      ctx,
      run.map((k) => rows[k]!),
      multiRuns.flatMap((k) => shorts[k]!),
      used,
    );
    if (!cand) continue;
    const bb = candBBox(cand);
    if (boxes.some((b) => overlapFrac(bb, b) > 0.2)) continue;
    boxes.push(bb);
    for (const l of cand.assign.keys()) used.add(l);
    out.push(cand);
  }
  return out;
}

function buildTextTable(
  ctx: BuildCtx,
  runRows: readonly Row[],
  shortFrags: readonly Frag[],
  used: ReadonlySet<TLine>,
): Candidate | null {
  // 구역 x 범위: 여러 조각 행의 짧은 조각. 그 안에 중심이 든 구간 줄만 쓴다.
  const rx0 = Math.min(...shortFrags.map((f) => f.x0));
  const rx1 = Math.max(...shortFrags.map((f) => f.x1));
  const ls = runRows
    .flatMap((r) => r.lines)
    .filter((l) => !used.has(l) && l.cx >= rx0 - 1 && l.cx <= rx1 + 1);
  const rows = clusterRows(ls);
  if (rows.length < T.textMinRows) return null;
  const frs = rows.map((r) => fragsOf(r.lines, T.fragGapEm));
  const allFr = frs.flat();
  const size = median(ls.map((l) => l.size));
  const bx0 = Math.min(...ls.map((l) => l.x0));
  const bx1 = Math.max(...ls.map((l) => l.x1));

  // 산문 거부: 조각이 구역 폭에 비해 넓거나 단어가 많다(두 단 본문·목록).
  const width = Math.max(bx1 - bx0, 1);
  if (median(allFr.map((f) => (f.x1 - f.x0) / width)) > T.textMaxFragRatio) return null;
  if (median(allFr.map((f) => f.words)) > T.textMaxWords) return null;

  // 열: 투영 빈틈 중 textMinRows 행 이상이 양쪽에 조각을 둔 것. 통화·부호 기호 열은 오른쪽에 붙인다.
  const gaps = findGaps(frs, minGapWidth(size), Math.floor(T.colCrossRatio * rows.length)).filter(
    (g) => gapSupport(frs, g, bx0, bx1) >= T.textMinRows,
  );
  const C = mergeCurrencyCols([bx0, ...gaps.map((g) => (g.x0 + g.x1) / 2), bx1], allFr, () => true);
  const nc = C.length - 1;
  const stats = columnStats(allFr, C);
  if (nc < 2) return null;
  if (nc === 2 && stats[1]!.numeric < T.numericRatio) return null;

  // 정렬: 열마다 조각 왼쪽·오른쪽·가운데 중 하나가 textMinRows 개 이상 alignTol 안에 모여야 한다.
  const aligned = stats.filter(
    (s) => alignedCount(s.frags) >= Math.min(T.textMinRows, Math.max(s.frags.length, 1)),
  ).length;
  if (aligned < 2 || aligned < T.alignRatio * nc) return null;

  // 행: 기준선 행. 두 셀 이상 찬 행이 textMinRows 개 이상.
  const R = rowBoundsOf(rows);
  const cells: GridCell[] = [];
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < nc; c++) cells.push({ r, c, rs: 1, cs: 1 });
  const assign = assignLines(ctx.model, ls, R, C, cells);
  const perRow = new Map<number, Set<number>>();
  for (const k of assign.values()) {
    const c = cells[k]!;
    const s = perRow.get(c.r) ?? new Set<number>();
    s.add(c.c);
    perRow.set(c.r, s);
  }
  if ([...perRow.values()].filter((s) => s.size >= 2).length < T.textMinRows) return null;

  const bbox: Rect = [C[0]!, R[0]!, C.at(-1)!, R.at(-1)!];
  if (chartCovered(ctx.ps, bbox)) return null;
  if (graphicsCount(ctx.ps, bbox) > T.textMaxGraphics) return null;
  return {
    kind: 'text',
    rowBounds: R,
    colBounds: C,
    cells,
    assign,
    paths: pathsInside(ctx.ps, bbox),
  };
}

/** 왼쪽·오른쪽·가운데 끝 중 alignTol 안에 가장 많이 모인 조각 수. */
function alignedCount(fs: readonly Frag[]): number {
  let best = 0;
  for (const key of [(f: Frag) => f.x0, (f: Frag) => f.x1, fragCx]) {
    const xs = fs.map(key).sort((a, b) => a - b);
    let lo = 0;
    for (let hi = 0; hi < xs.length; hi++) {
      while (xs[hi]! - xs[lo]! > T.alignTol) lo++;
      best = Math.max(best, hi - lo + 1);
    }
  }
  return best;
}

/** 기준선 행 경계: 위·아래는 글자 외곽, 사이는 이웃 행 상자 간격의 가운데. */
function rowBoundsOf(rows: readonly Row[]): number[] {
  const R = [rows[0]!.y0];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const y = b.y0 >= a.y1 ? (a.y1 + b.y0) / 2 : (rowBaseline(a) + b.y0) / 2;
    R.push(Math.max(y, R.at(-1)! + 0.01));
  }
  R.push(Math.max(rows.at(-1)!.y1, R.at(-1)! + 0.01));
  return R;
}

/** 정렬 전략 구역 안 그래픽 수: 세로선, 도형, 구역 폭 80% 미만 채움 상자(줄무늬 제외). */
function graphicsCount(ps: PathSummary, r: Rect): number {
  const inside = (b: Rect): boolean =>
    b[0] >= r[0] - 1 && b[1] >= r[1] - 1 && b[2] <= r[2] + 1 && b[3] <= r[3] + 1;
  const w = r[2] - r[0];
  const vPaths = new Set<number>();
  for (const e of ps.rules)
    if (e.orient === 'v' && inside([e.x0, e.y0, e.x1, e.y1])) vPaths.add(e.path);
  let n = vPaths.size;
  for (const s of ps.shapes) if (inside(s.bbox)) n++;
  for (const b of ps.boxes) if (inside(b.bbox) && b.bbox[2] - b.bbox[0] < 0.8 * w) n++;
  return n;
}

// ───────────────────────── 마무리 ─────────────────────────

const candBBox = (c: Candidate): Rect => [
  c.colBounds[0]!,
  c.rowBounds[0]!,
  c.colBounds.at(-1)!,
  c.rowBounds.at(-1)!,
];

/** a 면적 중 b 와 겹치는 비율. */
function overlapFrac(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max((a[2] - a[0]) * (a[3] - a[1]), 1e-6);
}

function toDetected(c: Candidate): DetectedTable {
  const R = c.rowBounds;
  const C = c.colBounds;
  const linesOf = new Map<number, TLine[]>();
  for (const [l, k] of c.assign) pushTo(linesOf, k, l);
  const cells: DetectedCell[] = c.cells
    .map((g, k) => ({
      row: g.r,
      col: g.c,
      rowSpan: g.rs,
      colSpan: g.cs,
      bbox: [C[g.c]!, R[g.r]!, C[g.c + g.cs]!, R[g.r + g.rs]!] as Rect,
      lines: (linesOf.get(k) ?? [])
        .sort((a, b) => a.f.baseline - b.f.baseline || a.x0 - b.x0)
        .map((l) => l.f.index),
    }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    bbox: candBBox(c),
    rowBounds: R,
    colBounds: C,
    cells,
    strategy: c.kind === 'text' ? 'text' : 'lines',
    paths: c.paths,
  };
}

/**
 * 표를 찾는다. 반환한 표들의 셀 줄은 서로 겹치지 않는다(줄 하나는 최대 한 셀).
 * `lines` 는 가로 줄(horizontal)만 넘어온다.
 */
export function detectTables(
  model: PageModel,
  lines: readonly LineFeature[],
  paths: PathSummary,
): DetectedTable[] {
  const ctx: BuildCtx = { model, free: prepareLines(lines), ps: paths };
  // 1) 괘선 전략: 격자 표 → 띠 표 순, 같은 종류는 셀 많은 것 먼저. 받은 표와 20% 넘게 겹치면 버린다.
  const order = { grid: 0, band: 1, text: 2 } as const;
  const cands = linesStrategy(ctx).sort(
    (a, b) => order[a.kind] - order[b.kind] || b.cells.length - a.cells.length,
  );
  const accepted: Candidate[] = [];
  const taken = new Set<TLine>();
  for (const c of cands) {
    const bb = candBBox(c);
    if (
      accepted.some((a) => overlapFrac(bb, candBBox(a)) > 0.2 || overlapFrac(candBBox(a), bb) > 0.2)
    )
      continue;
    for (const l of [...c.assign.keys()]) if (taken.has(l)) c.assign.delete(l);
    if (c.kind === 'band') extendBand(ctx, c, taken);
    for (const l of c.assign.keys()) taken.add(l);
    accepted.push(c);
  }
  // 2) 정렬 전략: 괘선 표 밖 줄.
  accepted.push(...textStrategy(ctx, taken, accepted.map(candBBox)));
  return accepted.map(toDetected).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
