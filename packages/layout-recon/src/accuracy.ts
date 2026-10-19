/**
 * 정확도 채점(docs/m2-contract.md 4.2). 정답 라벨(4.1)과 PageLayout 을 비교한다.
 */
import type { PageLayout, ParagraphRole, Rect } from '@pdf-editor/shared-types';
import { iou } from './geom.js';

export interface LabelParagraph {
  type: 'paragraph';
  role: ParagraphRole;
  lines: number[];
}

export interface LabelCell {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
  lines: number[];
}

export interface LabelTable {
  type: 'table';
  bbox: Rect;
  rows: number;
  cols: number;
  lines: number[];
  cells?: LabelCell[];
}

export interface LabelFigure {
  type: 'figure';
  bbox: Rect;
  labels: number[];
}

export type LabelItem = LabelParagraph | LabelTable | LabelFigure;

export interface PageLabel {
  doc: string;
  pageIndex: number;
  split: 'dev' | 'test';
  extract: { lineCount: number; linesSha256: string };
  status: 'draft' | 'reviewed' | 'confirmed';
  items: LabelItem[];
  ignoreLines?: number[];
}

export interface Counts {
  tp: number;
  fp: number;
  fn: number;
}

export interface PageScore {
  /** 흐름 문단 완전 일치: tp = 일치, fp = 예측 − 일치, fn = 라벨 − 일치. */
  paragraphs: Counts;
  /** 같은 문단 줄 쌍. */
  pairs: Counts;
  /** 읽기 순서 Kendall τ(머리·꼬리 제외). 항목 2개 미만이면 null. */
  tau: number | null;
  /** 기준선 τ: 복원 없이 PageModel 줄 순서(MuPDF 구조화 텍스트 순서)만 쓴 값(같은 항목 대응). */
  tauBaseline: number | null;
  /** τ 에서 뺀 라벨 항목 수(예측 순위가 없는 항목: 줄 없는 도형이 매칭되지 않은 경우 등). */
  tauExcluded: number;
  tables: Counts;
  /** 매칭된 표 중 행·열 수가 모두 맞은 수 / 매칭 수. */
  tableShape: { exact: number; matched: number };
  /** 셀 라벨이 있는 표의 셀 줄 (행, 열) 일치. */
  cellLines: { correct: number; total: number };
  figures: Counts;
  /** 머리·꼬리 줄. */
  margin: Counts;
  /** 실패 사례(분석용): 일치하지 않은 라벨 문단과 그 줄을 담은 예측 문단. */
  misses: string[];
}

const key = (lines: Iterable<number>): string => [...lines].sort((a, b) => a - b).join(',');

function greedyMatch(a: Rect[], b: Rect[], min: number): [number, number][] {
  const pairs: [number, number, number][] = [];
  a.forEach((ra, i) =>
    b.forEach((rb, j) => {
      const v = iou(ra, rb);
      if (v >= min) pairs.push([v, i, j]);
    }),
  );
  pairs.sort((x, y) => y[0] - x[0]);
  const ua = new Set<number>();
  const ub = new Set<number>();
  const out: [number, number][] = [];
  for (const [, i, j] of pairs) {
    if (ua.has(i) || ub.has(j)) continue;
    ua.add(i);
    ub.add(j);
    out.push([i, j]);
  }
  return out;
}

/** 순서쌍 일치율 τ = (일치 − 불일치) / (일치 + 불일치). 예측 순위가 같은 쌍은 세지 않는다. */
export function kendallTau(ranks: readonly number[]): number | null {
  let c = 0;
  let d = 0;
  for (let i = 0; i < ranks.length; i++)
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[i]! < ranks[j]!) c++;
      else if (ranks[i]! > ranks[j]!) d++;
    }
  return c + d === 0 ? null : (c - d) / (c + d);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function scoreLayout(label: PageLabel, layout: PageLayout): PageScore {
  const ignore = new Set(label.ignoreLines ?? []);
  const clean = (ls: readonly number[]) => ls.filter((l) => !ignore.has(l));
  const labelParas = label.items.filter((i): i is LabelParagraph => i.type === 'paragraph');
  const labelTables = label.items.filter((i): i is LabelTable => i.type === 'table');
  const labelFigures = label.items.filter((i): i is LabelFigure => i.type === 'figure');
  const flowPred = layout.paragraphs.filter((p) => p.table === null && p.figure === null);

  // 문단 완전 일치.
  const labelKeys = new Map(labelParas.map((p) => [key(clean(p.lines)), p]));
  const predKeys = new Set(flowPred.map((p) => key(clean(p.lines))).filter((k) => k !== ''));
  let matched = 0;
  const misses: string[] = [];
  const predOfLine = new Map<number, number>();
  for (const p of layout.paragraphs) for (const l of p.lines) predOfLine.set(l, p.id);
  for (const [k, p] of labelKeys) {
    if (k === '') continue;
    if (predKeys.has(k)) matched++;
    else {
      const parts = new Map<number, number[]>();
      for (const l of clean(p.lines)) {
        const id = predOfLine.get(l) ?? -1;
        parts.set(id, [...(parts.get(id) ?? []), l]);
      }
      misses.push(
        `${p.role}[${clean(p.lines).join(',')}] → ${[...parts]
          .map(([id, ls]) => {
            const pp = layout.paragraphs[id];
            const extra = pp ? clean(pp.lines).filter((l) => !p.lines.includes(l)).length : 0;
            return `${id < 0 ? 'none' : `P${id}`}(${ls.length}${extra ? `+${extra}` : ''})`;
          })
          .join(' ')}`,
      );
    }
  }
  const nLabel = [...labelKeys.keys()].filter((k) => k !== '').length;
  const paragraphs = { tp: matched, fp: predKeys.size - matched, fn: nLabel - matched };

  // 줄 쌍(라벨 흐름 문단의 줄만).
  const flowLines = new Set(labelParas.flatMap((p) => clean(p.lines)));
  const pairSet = (groups: number[][]): Set<string> => {
    const s = new Set<string>();
    for (const g of groups) {
      const ls = g.filter((l) => flowLines.has(l)).sort((a, b) => a - b);
      for (let i = 0; i < ls.length; i++)
        for (let j = i + 1; j < ls.length; j++) s.add(`${ls[i]}-${ls[j]}`);
    }
    return s;
  };
  const lp = pairSet(labelParas.map((p) => p.lines));
  const pp = pairSet(layout.paragraphs.map((p) => p.lines));
  let ptp = 0;
  for (const x of pp) if (lp.has(x)) ptp++;
  const pairs = { tp: ptp, fp: pp.size - ptp, fn: lp.size - ptp };

  // 읽기 순서: 예측 최상위 항목 위치 + 항목 안 줄 순서로 줄 순위를 만든다.
  const rank = new Map<number, number>();
  const figurePos = new Map<number, number>();
  layout.readingOrder.forEach((ref, pos) => {
    let ls: number[] = [];
    if (ref.kind === 'paragraph') ls = layout.paragraphs[ref.id]!.lines;
    else if (ref.kind === 'table')
      ls = layout.tables[ref.id]!.cells.flatMap((c) =>
        c.paragraphs.flatMap((p) => layout.paragraphs[p]!.lines),
      );
    else {
      figurePos.set(ref.id, pos);
      ls = layout.figures[ref.id]!.labels.flatMap((p) => layout.paragraphs[p]!.lines);
    }
    ls.forEach((l, k) => rank.set(l, pos + (k + 1) / (ls.length + 2)));
  });
  const figMatch = new Map(
    greedyMatch(
      labelFigures.map((f) => f.bbox),
      layout.figures.map((f) => f.bbox),
      0.5,
    ),
  );
  const ranks: number[] = [];
  const baseRanks: number[] = [];
  let tauExcluded = 0;
  label.items.forEach((it) => {
    if (it.type === 'paragraph' && (it.role === 'header' || it.role === 'footer')) return;
    const ls = clean(it.type === 'paragraph' || it.type === 'table' ? it.lines : it.labels);
    if (ls.length) baseRanks.push(median(ls));
    const rs = ls.map((l) => rank.get(l)).filter((r): r is number => r !== undefined);
    if (rs.length) ranks.push(median(rs));
    else if (it.type === 'figure') {
      const j = figMatch.get(labelFigures.indexOf(it));
      if (j !== undefined && figurePos.has(j)) ranks.push(figurePos.get(j)! + 0.5);
      else tauExcluded++;
    } else tauExcluded++;
  });
  const tau = ranks.length >= 2 ? kendallTau(ranks) : null;
  const tauBaseline = baseRanks.length >= 2 ? kendallTau(baseRanks) : null;

  // 표.
  const tm = greedyMatch(
    labelTables.map((t) => t.bbox),
    layout.tables.map((t) => t.bbox),
    0.5,
  );
  const tables = {
    tp: tm.length,
    fp: layout.tables.length - tm.length,
    fn: labelTables.length - tm.length,
  };
  let exact = 0;
  const cellLines = { correct: 0, total: 0 };
  // 셀 줄: 셀 라벨이 있는 모든 라벨 표의 줄을 센다. 매칭되지 않은 표의 줄은 틀린 것으로 센다.
  const matchOf = new Map(tm);
  for (const [i, j] of tm) {
    const lt = labelTables[i]!;
    const pt = layout.tables[j]!;
    if (lt.rows === pt.rows && lt.cols === pt.cols) exact++;
  }
  labelTables.forEach((lt, i) => {
    if (!lt.cells) return;
    const j = matchOf.get(i);
    const cellOf = new Map<number, string>();
    if (j !== undefined)
      for (const c of layout.tables[j]!.cells)
        for (const l of c.lines) cellOf.set(l, `${c.row},${c.col}`);
    for (const c of lt.cells)
      for (const l of clean(c.lines)) {
        cellLines.total++;
        if (cellOf.get(l) === `${c.row},${c.col}`) cellLines.correct++;
      }
  });

  // 도형.
  const figures = {
    tp: figMatch.size,
    fp: layout.figures.length - figMatch.size,
    fn: labelFigures.length - figMatch.size,
  };

  // 머리·꼬리 줄.
  const lm = new Set(
    labelParas
      .filter((p) => p.role === 'header' || p.role === 'footer')
      .flatMap((p) => clean(p.lines)),
  );
  const pm = new Set(
    layout.paragraphs
      .filter((p) => p.role === 'header' || p.role === 'footer')
      .flatMap((p) => clean(p.lines)),
  );
  let mtp = 0;
  for (const l of pm) if (lm.has(l)) mtp++;
  const margin = { tp: mtp, fp: pm.size - mtp, fn: lm.size - mtp };

  return {
    paragraphs,
    pairs,
    tau,
    tauBaseline,
    tauExcluded,
    tables,
    tableShape: { exact, matched: tm.length },
    cellLines,
    figures,
    margin,
    misses,
  };
}

export interface ScoreSummary {
  pages: number;
  paragraphF1: number;
  paragraphP: number;
  paragraphR: number;
  pairF1: number;
  tauMean: number | null;
  /** 기준선 τ 쪽 평균(PageModel 줄 순서). */
  tauBaselineMean: number | null;
  tableP: number | null;
  tableR: number | null;
  tableShape: number | null;
  cellAccuracy: number | null;
  figureP: number | null;
  figureR: number | null;
  marginF1: number | null;
}

const add = (a: Counts, b: Counts): Counts => ({
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  fn: a.fn + b.fn,
});
const prec = (c: Counts): number | null => (c.tp + c.fp ? c.tp / (c.tp + c.fp) : null);
const rec = (c: Counts): number | null => (c.tp + c.fn ? c.tp / (c.tp + c.fn) : null);
const f1 = (c: Counts): number | null =>
  2 * c.tp + c.fp + c.fn ? (2 * c.tp) / (2 * c.tp + c.fp + c.fn) : null;

/** 전체 합산(계약 4.3: 쪽 평균이 아닌 합산, τ 만 쪽 평균). */
export function summarizeScores(scores: readonly PageScore[]): ScoreSummary {
  const z: Counts = { tp: 0, fp: 0, fn: 0 };
  const para = scores.reduce((s, x) => add(s, x.paragraphs), z);
  const pairs = scores.reduce((s, x) => add(s, x.pairs), z);
  const tables = scores.reduce((s, x) => add(s, x.tables), z);
  const figures = scores.reduce((s, x) => add(s, x.figures), z);
  const margin = scores.reduce((s, x) => add(s, x.margin), z);
  const taus = scores.map((s) => s.tau).filter((t): t is number => t !== null);
  const baseTaus = scores.map((s) => s.tauBaseline).filter((t): t is number => t !== null);
  const shape = scores.reduce(
    (s, x) => ({ e: s.e + x.tableShape.exact, m: s.m + x.tableShape.matched }),
    { e: 0, m: 0 },
  );
  const cells = scores.reduce(
    (s, x) => ({ c: s.c + x.cellLines.correct, t: s.t + x.cellLines.total }),
    { c: 0, t: 0 },
  );
  return {
    pages: scores.length,
    paragraphF1: f1(para) ?? 0,
    paragraphP: prec(para) ?? 0,
    paragraphR: rec(para) ?? 0,
    pairF1: f1(pairs) ?? 0,
    tauMean: taus.length ? taus.reduce((a, b) => a + b, 0) / taus.length : null,
    tauBaselineMean: baseTaus.length ? baseTaus.reduce((a, b) => a + b, 0) / baseTaus.length : null,
    tableP: prec(tables),
    tableR: rec(tables),
    tableShape: shape.m ? shape.e / shape.m : null,
    cellAccuracy: cells.t ? cells.c / cells.t : null,
    figureP: prec(figures),
    figureR: rec(figures),
    marginF1: f1(margin),
  };
}
