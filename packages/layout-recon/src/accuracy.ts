/**
 * Accuracy scoring (docs/m2-contract.md 4.2). Compares the ground-truth labels (4.1) with the PageLayout.
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
  /** dev: for tuning, test: first holdout (measured once), test2: second holdout (reinforcement round, docs/m2-contract.md 4.4). */
  split: 'dev' | 'test' | 'test2';
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

/** Role confusion matrix column and row names. Label row `none`: predicted paragraphs with no label counterpart. Predicted column `none`: label paragraphs with no counterpart. */
export const ROLE_NONE = 'none';
/** Predicted column `container`: the counterpart is a paragraph inside a table or figure. */
export const ROLE_CONTAINER = 'container';
/** Lower bound for role scoring pairing: Jaccard of the label paragraph line set and the predicted paragraph line set. */
export const ROLE_PAIR_MIN_JACCARD = 0.5;
/** Roles scored (confusion matrix order). */
export const ROLES: readonly ParagraphRole[] = [
  'body',
  'heading',
  'list-item',
  'caption',
  'footnote',
  'header',
  'footer',
  'other',
];

/** Confusion matrix: matrix[label role | 'none'][predicted role | 'container' | 'none'] = pair count. Zero cells are omitted. */
export type RoleMatrix = Record<string, Record<string, number>>;

export interface PageScore {
  /** Exact flow paragraph match: tp = matches, fp = predictions − matches, fn = labels − matches. */
  paragraphs: Counts;
  /** Line pairs in the same paragraph. */
  pairs: Counts;
  /** Reading order Kendall τ (excluding headers/footers). null if fewer than 2 items. */
  tau: number | null;
  /** Baseline τ: value using only the PageModel line order (MuPDF structured text order) without reconstruction (same item correspondence). */
  tauBaseline: number | null;
  /** Number of label items excluded from τ (items with no predicted rank: e.g. a figure without lines that was not matched). */
  tauExcluded: number;
  tables: Counts;
  /** Number of matched tables with both row and column counts correct / number of matches. */
  tableShape: { exact: number; matched: number };
  /** Cell line (row, column) matches for tables with cell labels. */
  cellLines: { correct: number; total: number };
  figures: Counts;
  /** Header/footer lines. */
  margin: Counts;
  /** Role confusion matrix (based on one-to-one pairs of label and predicted paragraphs with line Jaccard of at least 0.5). */
  roles: RoleMatrix;
  /** Paired entries whose roles differ (for analysis): `labelRole[lines] → predictedRole P<id>[lines]`. */
  roleMisses: string[];
  /** Failure cases (for analysis): label paragraphs that did not match, and the predicted paragraphs containing their lines. */
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

/** Pairwise concordance τ = (concordant − discordant) / (concordant + discordant). Pairs with equal predicted rank are not counted. */
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

/**
 * Role scoring (W4-1). Pairs label and predicted paragraphs one-to-one in descending line-set Jaccard order (lower bound `ROLE_PAIR_MIN_JACCARD`)
 * to build the role confusion matrix. Label paragraphs with no counterpart because of wrong paragraph boundaries count in predicted column `none`, and predicted flow paragraphs with no counterpart count in label row `none`.
 * Predicted paragraphs with none of a label paragraph's lines (table/figure detection problems) are not counted.
 */
function scoreRoles(
  labelParas: readonly LabelParagraph[],
  layout: PageLayout,
  clean: (ls: readonly number[]) => number[],
): { roles: RoleMatrix; roleMisses: string[] } {
  const roles: RoleMatrix = {};
  const bump = (row: string, col: string): void => {
    const r = (roles[row] ??= {});
    r[col] = (r[col] ?? 0) + 1;
  };
  const roleMisses: string[] = [];
  const lab = labelParas
    .map((p) => ({ p, lines: new Set(clean(p.lines)) }))
    .filter((x) => x.lines.size > 0);
  const pred = layout.paragraphs
    .map((p) => ({ p, lines: new Set(clean(p.lines)) }))
    .filter((x) => x.lines.size > 0);
  const flowLines = new Set(lab.flatMap((x) => [...x.lines]));

  const cands: [number, number, number][] = [];
  lab.forEach((a, i) =>
    pred.forEach((b, j) => {
      let inter = 0;
      for (const l of a.lines) if (b.lines.has(l)) inter++;
      if (inter === 0) return;
      const v = inter / (a.lines.size + b.lines.size - inter);
      if (v >= ROLE_PAIR_MIN_JACCARD) cands.push([v, i, j]);
    }),
  );
  cands.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
  const labUsed = new Set<number>();
  const predUsed = new Set<number>();
  for (const [, i, j] of cands) {
    if (labUsed.has(i) || predUsed.has(j)) continue;
    labUsed.add(i);
    predUsed.add(j);
    const { p: lp } = lab[i]!;
    const { p: pp } = pred[j]!;
    const inContainer = pp.table !== null || pp.figure !== null;
    bump(lp.role, inContainer ? ROLE_CONTAINER : pp.role);
    if (inContainer || pp.role !== lp.role)
      roleMisses.push(
        `${lp.role}[${clean(lp.lines).join(',')}] → ${inContainer ? ROLE_CONTAINER : pp.role} P${pp.id}[${clean(pp.lines).join(',')}]`,
      );
  }
  lab.forEach((x, i) => {
    if (!labUsed.has(i)) bump(x.p.role, ROLE_NONE);
  });
  pred.forEach((x, j) => {
    if (predUsed.has(j) || x.p.table !== null || x.p.figure !== null) return;
    if (![...x.lines].some((l) => flowLines.has(l))) return;
    bump(ROLE_NONE, x.p.role);
  });
  return { roles, roleMisses };
}

export function scoreLayout(label: PageLabel, layout: PageLayout): PageScore {
  const ignore = new Set(label.ignoreLines ?? []);
  const clean = (ls: readonly number[]) => ls.filter((l) => !ignore.has(l));
  const labelParas = label.items.filter((i): i is LabelParagraph => i.type === 'paragraph');
  const labelTables = label.items.filter((i): i is LabelTable => i.type === 'table');
  const labelFigures = label.items.filter((i): i is LabelFigure => i.type === 'figure');
  const flowPred = layout.paragraphs.filter((p) => p.table === null && p.figure === null);

  // Exact paragraph match.
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

  // Line pairs (lines of label flow paragraphs only).
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

  // Reading order: builds line ranks from the predicted top-level item position + line order within the item.
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

  // Tables.
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
  // Cell lines: counts the lines of all label tables that have cell labels. Lines of unmatched tables count as wrong.
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

  // Figures.
  const figures = {
    tp: figMatch.size,
    fp: layout.figures.length - figMatch.size,
    fn: labelFigures.length - figMatch.size,
  };

  // Header/footer lines.
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

  const { roles, roleMisses } = scoreRoles(labelParas, layout, clean);

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
    roles,
    roleMisses,
    misses,
  };
}

export interface RoleMetrics {
  /** Number of label paragraphs (including unpaired ones). */
  support: number;
  /** Number of predicted paragraphs (including unpaired flow paragraphs). */
  predicted: number;
  /** Pairs whose label and predicted roles match. */
  tp: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ScoreSummary {
  pages: number;
  paragraphF1: number;
  paragraphP: number;
  paragraphR: number;
  pairF1: number;
  tauMean: number | null;
  /** Page average of baseline τ (PageModel line order). */
  tauBaselineMean: number | null;
  tableP: number | null;
  tableR: number | null;
  tableShape: number | null;
  cellAccuracy: number | null;
  figureP: number | null;
  figureR: number | null;
  marginF1: number | null;
  /** Per-role precision and recall (based on summed confusion matrices, `ROLES` order). */
  roles: Record<string, RoleMetrics>;
  /** Summed role confusion matrix. */
  roleMatrix: RoleMatrix;
  /** Number of label paragraphs / number paired with line Jaccard of at least 0.5 / number of pairs with the same role. */
  rolePairs: { labeled: number; paired: number; match: number };
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

/** Sums per-page confusion matrices and computes per-role metrics. */
function summarizeRoles(scores: readonly PageScore[]): {
  roles: Record<string, RoleMetrics>;
  roleMatrix: RoleMatrix;
  rolePairs: { labeled: number; paired: number; match: number };
} {
  const roleMatrix: RoleMatrix = {};
  for (const s of scores)
    for (const [row, cols] of Object.entries(s.roles))
      for (const [col, n] of Object.entries(cols)) {
        const r = (roleMatrix[row] ??= {});
        r[col] = (r[col] ?? 0) + n;
      }
  const roles: Record<string, RoleMetrics> = {};
  for (const role of ROLES) {
    const tp = roleMatrix[role]?.[role] ?? 0;
    const support = Object.values(roleMatrix[role] ?? {}).reduce((a, b) => a + b, 0);
    const predicted = Object.values(roleMatrix).reduce((a, cols) => a + (cols[role] ?? 0), 0);
    roles[role] = {
      support,
      predicted,
      tp,
      precision: predicted ? tp / predicted : null,
      recall: support ? tp / support : null,
      f1: support + predicted ? (2 * tp) / (support + predicted) : null,
    };
  }
  let labeled = 0;
  let paired = 0;
  let match = 0;
  for (const [row, cols] of Object.entries(roleMatrix)) {
    if (row === ROLE_NONE) continue;
    for (const [col, n] of Object.entries(cols)) {
      labeled += n;
      if (col === ROLE_NONE) continue;
      paired += n;
      if (col === row) match += n;
    }
  }
  return { roles, roleMatrix, rolePairs: { labeled, paired, match } };
}

/** Overall sum (contract 4.3: summed, not page-averaged; only τ is page-averaged). */
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
    ...summarizeRoles(scores),
  };
}
