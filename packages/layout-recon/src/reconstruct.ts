/**
 * PageModel → PageLayout (contract docs/m2-contract.md section 3).
 */
import type {
  LayoutColumn,
  LayoutFigure,
  LayoutItemRef,
  LayoutParagraph,
  LayoutTable,
  PageLayout,
  PageModel,
  ParagraphRole,
  Rect,
} from '@pdf-editor/shared-types';
import { buildParagraph, type ParagraphBody } from './build.js';
import { C } from './constants.js';
import { lineFeatures, type LineFeature } from './features.js';
import { detectFigures } from './figures.js';
import { bodySize, splitMargins, splitParagraphs, stackRegions, type Region } from './flow.js';
import {
  area,
  center,
  containsPoint,
  expand,
  height,
  intersect,
  median,
  union,
  width,
} from './geom.js';
import { summarizePaths } from './paths.js';
import { detectTables } from './tables.js';
import { BULLET, CAPTION, NUMBERED_HEADING, SENTENCE_END } from './text-rules.js';
import { buildUnits, inlineImages, makeUnit, type Unit } from './units.js';
import { xyCut, type CutItem } from './xycut.js';

export interface ReconOptions {
  /** ML-assisted candidates (contract section 3, step 8). No default implementation in v1. */
  plugins?: readonly LayoutPlugin[];
  /**
   * Extraction models of neighboring pages (1–2 pages before and after). If given, lines at the top/bottom of the page repeated at the same position with the same text (ignoring digits) are
   * treated as headers/footers (running heads, page numbers, contract 2.5). If absent, only the single page is considered.
   */
  neighbors?: readonly PageModel[];
  /**
   * Groups of PageModel lines to pin as one paragraph (M3 edit blocks, docs/m3-integration.md 9.6). Each group yields exactly one paragraph
   * (lines top→bottom). Group lines are also fed into table detection (M4 4.1: if a cell edit block is missing, the cell becomes empty and alignment-strategy tables break);
   * after detection, if all lines of a group fall into one cell, that cell paragraph = the group (`table` set; other lines in the same cell are split normally).
   * Any other group is a flow paragraph (role follows the same rules as other flow paragraphs), and its lines are excluded from table cells, figures, headers/footers, region stacking and paragraph
   * splitting. A flow group paragraph enters XY-cut with the union of its line boxes and receives the reading order and column of the first line's position.
   * Invisible lines, non-horizontal lines and out-of-range indices are ignored, and a line in several groups belongs to the earlier group. If absent, the result equals M2.
   */
  fixedGroups?: readonly (readonly number[])[];
}

/** Text normalization for repetition comparison: lowercase, digits → #, single spaces. */
const normRepeat = (t: string): string =>
  t.toLowerCase().replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();

/** Units in the top/bottom 20% of the page that also appear on a neighboring page at the same position (top edge ±3pt, left or right edge ±3pt) with the same normalized text. */
function repeatedUnits(
  units: readonly Unit[],
  bounds: Rect,
  neighbors: readonly PageModel[],
): Set<Unit> {
  const out = new Set<Unit>();
  if (!neighbors.length) return out;
  const H = height(bounds);
  const others = neighbors.map((m) => lineFeatures(m).filter((f) => f.text.trim() !== ''));
  for (const u of units) {
    const edge = u.bbox[3] <= bounds[1] + 0.2 * H || u.bbox[1] >= bounds[3] - 0.2 * H;
    if (!edge) continue;
    const matchPart = (p: LineFeature) =>
      others.some((fs) =>
        fs.some(
          (f) =>
            Math.abs(f.bbox[1] - p.bbox[1]) <= 3 &&
            (Math.abs(f.bbox[0] - p.bbox[0]) <= 3 || Math.abs(f.bbox[2] - p.bbox[2]) <= 3) &&
            normRepeat(f.text) === normRepeat(p.text),
        ),
      );
    if (u.parts.every(matchPart)) out.add(u);
  }
  return out;
}

export interface RegionProposal {
  kind: 'table' | 'figure' | 'paragraph';
  bbox: [number, number, number, number];
  score: number;
}

/** ML plugin slot. Must be a pure function (including adapters that pass precomputed model inference results). */
export interface LayoutPlugin {
  name: string;
  proposeRegions(model: PageModel): readonly RegionProposal[];
}

/** Clock usable without DOM/Node types (both Worker and Node have performance). */
const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

interface Draft {
  body: ParagraphBody;
  units: Unit[];
  role: ParagraphRole;
  column: number;
  table: number | null;
  figure: number | null;
  /** Region of a flow paragraph (for linking across columns). */
  region: Region | null;
}

const FOOTNOTE_START = /^\s*(?:\d{1,3}|[*†‡§¶])\s?\S/u;

/** Caption adjacency: a figure or table with the same horizontal range lies within 3em above or below, or within 3em beside it (vertical overlap). */
function nearObject(bbox: Rect, size: number, objects: readonly Rect[]): boolean {
  const d = 3 * size;
  return objects.some((o) => {
    const ox = Math.min(o[2], bbox[2]) - Math.max(o[0], bbox[0]);
    const oy = Math.min(o[3], bbox[3]) - Math.max(o[1], bbox[1]);
    const below = bbox[1] - o[3];
    const above = o[1] - bbox[3];
    const side = Math.max(o[0] - bbox[2], bbox[0] - o[2]);
    return (
      (ox > 0 && ((below >= -d && below <= d) || (above >= -d && above <= d))) ||
      (oy > 0 && side <= d)
    );
  });
}

function flowRole(
  units: Unit[],
  text: string,
  body: number,
  pageTop: number,
  pageH: number,
  bbox: Rect,
  objects: readonly Rect[],
): ParagraphRole {
  const size = units.reduce((m, u) => Math.max(m, u.size), 0);
  const bold = units.every((u) => u.bold);
  if (CAPTION.test(text) && nearObject(bbox, size, objects)) return 'caption';
  if (units.length <= 3 && size >= C.headingSizeRatio * body) return 'heading';
  if (
    units.length <= 2 &&
    NUMBERED_HEADING.test(text) &&
    (bold || size > body * 1.05) &&
    text.length <= 120
  )
    return 'heading';
  if (BULLET.test(text)) return 'list-item';
  if (bold && units.length <= 2 && text.length <= 120 && !/[.,;]$/u.test(text.trim()))
    return 'heading';
  if (size <= 0.9 * body && FOOTNOTE_START.test(text) && units[0]!.bbox[1] > pageTop + 0.6 * pageH)
    return 'footnote';
  return 'body';
}

export function reconstructPage(model: PageModel, options: ReconOptions = {}): PageLayout {
  const t0 = now();
  const warnings: string[] = [];
  const feats = lineFeatures(model);
  const visible = feats.filter((f) => f.chars.length > 0 && f.text.trim() !== '');
  const visibleSet = new Set(visible);
  const unassignedLines = feats.filter((f) => !visibleSet.has(f)).map((f) => f.index);
  // Pinned groups (edit blocks): visible horizontal lines only, one first group per line.
  const fixedOf = new Map<number, number>();
  (options.fixedGroups ?? []).forEach((g, k) => {
    for (const li of g) {
      const f = feats[li];
      if (f && visibleSet.has(f) && f.horizontal && !fixedOf.has(li)) fixedOf.set(li, k);
    }
  });
  const fixedFeats: LineFeature[][] = [];
  for (const [li, k] of fixedOf) (fixedFeats[k] ??= []).push(feats[li]!);
  const horizontal = visible.filter((f) => f.horizontal);
  const rotated = visible.filter((f) => !f.horizontal);
  const pathSummary = summarizePaths(model);
  const bounds = model.bounds;
  const pageH = height(bounds);

  // Step 3: tables (including pinned group lines). Group → the cell containing all its lines (table index:cell index). Groups that do not fit in one cell are removed and
  // detection is rerun (so those group lines do not change table detection, preserving the M3 9.6 result). If any remain after two passes, only those lines are removed from cells.
  const excluded = new Set<number>();
  const inputOf = () =>
    horizontal.filter((f) => {
      const k = fixedOf.get(f.index);
      return k === undefined || !excluded.has(k);
    });
  let detected = detectTables(model, inputOf(), pathSummary);
  const groupCell = new Map<number, string>();
  for (let pass = 0; pass < 3; pass++) {
    const cellOfLine = new Map<number, string>();
    detected.forEach((t, ti) =>
      t.cells.forEach((c, ci) => {
        for (const li of c.lines) cellOfLine.set(li, `${ti}:${ci}`);
      }),
    );
    groupCell.clear();
    const spread: number[] = [];
    fixedFeats.forEach((g, k) => {
      if (!g || g.length === 0 || excluded.has(k)) return;
      const keys = new Set(g.map((f) => cellOfLine.get(f.index) ?? ''));
      const only = [...keys][0]!;
      if (keys.size === 1 && only !== '') groupCell.set(k, only);
      else if ([...keys].some((x) => x !== '')) spread.push(k);
    });
    if (spread.length === 0 || pass === 2) break;
    for (const k of spread) excluded.add(k);
    detected = detectTables(model, inputOf(), pathSummary);
  }
  for (const t of detected) {
    for (const c of t.cells) {
      c.lines = c.lines.filter((li) => {
        const k = fixedOf.get(li);
        return k === undefined || groupCell.has(k);
      });
    }
  }
  const fixedGroups = fixedFeats.filter(
    (g, k) => g !== undefined && g.length > 0 && !groupCell.has(k),
  );
  const cellGroups = new Map<string, LineFeature[]>();
  for (const [k, key] of groupCell) cellGroups.set(key, fixedFeats[k]!);
  const tableLines = new Set(detected.flatMap((t) => t.cells.flatMap((c) => c.lines)));
  const excludedPaths = new Set(detected.flatMap((t) => t.paths));

  // Step 4: figures and labels.
  const free = (f: LineFeature) => !tableLines.has(f.index) && !fixedOf.has(f.index);
  // A figure candidate mostly (at least 60%) inside a table is the table's leftover rules or background.
  const figs = detectFigures(model, visible.filter(free), pathSummary, excludedPaths).filter(
    (f) =>
      !detected.some((t) => {
        const i = intersect(f.bbox, t.bbox);
        return i !== null && area(i) >= 0.6 * area(f.bbox);
      }),
  );
  const labelOf = new Map<number, number>();
  figs.forEach((fig, k) => {
    for (const f of visible) {
      if (!free(f) || labelOf.has(f.index) || CAPTION.test(f.text)) continue;
      const box = expand(fig.bbox, 0.3 * f.size);
      if (!intersect(box, f.bbox) || !containsPoint(box, center(f.bbox))) continue;
      if (fig.kind === 'vector' && width(f.bbox) > width(fig.bbox)) continue;
      // A prose line (at least 6 words, at least half the figure width) is flow body text, not a label (body text over a photo, sidebar).
      if (f.words.length >= 6 && width(f.bbox) > 0.5 * width(fig.bbox)) continue;
      labelOf.set(f.index, k);
    }
  });

  // Step 5: flow units, headers and footers.
  const flowFeats = horizontal.filter((f) => free(f) && !labelOf.has(f.index));
  const fillers = inlineImages(model, median(flowFeats.map((f) => f.size)) || 10);
  const units = buildUnits(model, flowFeats, fillers);
  const body = bodySize(units);
  const margins = splitMargins(
    units,
    bounds,
    body,
    repeatedUnits(units, bounds, options.neighbors ?? []),
  );
  const bodyX0 = margins.body.reduce((m, u) => Math.min(m, u.bbox[0]), bounds[2]);
  const bodyX1 = margins.body.reduce((m, u) => Math.max(m, u.bbox[2]), bounds[0]);
  const rotatedFree = rotated.filter((f) => free(f) && !labelOf.has(f.index));
  // If there are no horizontal body lines (a page with a rotated landscape table, or vertical writing), section tab classification is skipped.
  // A tab must be outside the body's horizontal range and inside the left/right page margin band (15% of page width).
  const sideBand = 0.15 * width(bounds);
  const sideTabs = margins.body.length
    ? rotatedFree.filter(
        (f) =>
          (f.bbox[0] >= bodyX1 - 1 && f.bbox[0] >= bounds[2] - sideBand) ||
          (f.bbox[2] <= bodyX0 + 1 && f.bbox[2] <= bounds[0] + sideBand),
      )
    : [];
  const sideSet = new Set(sideTabs);
  const rotatedBody = rotatedFree.filter((f) => !sideSet.has(f));

  const tableBoxes: Rect[] = detected.map((t) => t.bbox);
  const figBoxes: Rect[] = figs.map((f, k) => {
    let b = f.bbox;
    for (const [li, fk] of labelOf) if (fk === k) b = union(b, feats[li]!.bbox);
    return b;
  });
  // Pinned group paragraph: same-row fragments are joined regardless of gap (so wide word gaps in justified lines do not split them horizontally).
  const fixedUnits = fixedGroups.map((g) => buildUnits(model, g, fillers, true));
  const fixedBoxes: Rect[] = fixedUnits.map((us) =>
    us.slice(1).reduce((b, u) => union(b, u.full), us[0]!.full),
  );
  const regions = stackRegions(margins.body, [...tableBoxes, ...figBoxes, ...fixedBoxes]);

  // Step 6: XY-cut.
  type Item =
    | { kind: 'region'; region: Region; bbox: Rect }
    | { kind: 'table'; index: number; bbox: Rect }
    | { kind: 'figure'; index: number; bbox: Rect }
    | { kind: 'rotated'; feat: LineFeature; bbox: Rect }
    | { kind: 'fixed'; index: number; bbox: Rect };
  const items: Item[] = [
    ...regions.map((region) => ({ kind: 'region' as const, region, bbox: region.bbox })),
    ...tableBoxes.map((bbox, index) => ({ kind: 'table' as const, index, bbox })),
    ...figBoxes.map((bbox, index) => ({ kind: 'figure' as const, index, bbox })),
    ...rotatedBody.map((feat) => ({ kind: 'rotated' as const, feat, bbox: feat.bbox })),
    ...fixedBoxes.map((bbox, index) => ({ kind: 'fixed' as const, index, bbox })),
  ];
  const cut = xyCut(items as CutItem[]);

  const drafts: Draft[] = [];
  const readingOrder: LayoutItemRef[] = [];
  const tables: LayoutTable[] = [];
  const figures: LayoutFigure[] = [];
  const pushPara = (units: Unit[], d: Omit<Draft, 'body' | 'units'>): number => {
    drafts.push({ body: buildParagraph(model, units), units, ...d });
    return drafts.length - 1;
  };
  const byPos = (a: Unit, b: Unit) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];

  // Header.
  const headerUnits = [...margins.header, ...sideTabs.map((f) => makeUnit(model, [f]))].sort(byPos);
  for (const u of headerUnits) {
    const id = pushPara([u], {
      role: 'header',
      column: -1,
      table: null,
      figure: null,
      region: null,
    });
    readingOrder.push({ kind: 'paragraph', id });
  }

  // Column index: the innermost vertical cut group; items outside any group get a new column for each consecutive run.
  const columnOfGroup = new Map<number, number>();
  const columnBoxes: Rect[] = [];
  let lastFullWidth = false;
  const columnFor = (itemIndex: number, bbox: Rect): number => {
    const g = cut.group[itemIndex]!;
    let col: number;
    if (g >= 0) {
      lastFullWidth = false;
      if (!columnOfGroup.has(g)) {
        columnOfGroup.set(g, columnBoxes.length);
        columnBoxes.push(bbox);
      }
      col = columnOfGroup.get(g)!;
    } else {
      if (!lastFullWidth) columnBoxes.push(bbox);
      lastFullWidth = true;
      col = columnBoxes.length - 1;
    }
    columnBoxes[col] = union(columnBoxes[col]!, bbox);
    return col;
  };

  for (const idx of cut.order) {
    const it = items[idx]!;
    if (it.kind === 'region') {
      const col = columnFor(idx, it.bbox);
      for (const us of splitParagraphs(it.region)) {
        const id = pushPara(us, {
          role: 'body',
          column: col,
          table: null,
          figure: null,
          region: it.region,
        });
        readingOrder.push({ kind: 'paragraph', id });
      }
    } else if (it.kind === 'fixed') {
      const col = columnFor(idx, it.bbox);
      const id = pushPara(fixedUnits[it.index]!, {
        role: 'body',
        column: col,
        table: null,
        figure: null,
        region: null,
      });
      readingOrder.push({ kind: 'paragraph', id });
    } else if (it.kind === 'rotated') {
      const col = columnFor(idx, it.bbox);
      const id = pushPara([makeUnit(model, [it.feat])], {
        role: 'other',
        column: col,
        table: null,
        figure: null,
        region: null,
      });
      readingOrder.push({ kind: 'paragraph', id });
    } else if (it.kind === 'table') {
      const t = detected[it.index]!;
      const tableId = tables.length;
      const cells = t.cells.map((c, ci) => {
        const group = cellGroups.get(`${it.index}:${ci}`) ?? null;
        const groupSet = new Set(group ?? []);
        const cellFeats = c.lines.map((li) => feats[li]!).filter((f) => !groupSet.has(f));
        const cellUnits = buildUnits(model, cellFeats, fillers, true);
        const parts: { top: number; units: Unit[] }[] = [];
        if (cellUnits.length) {
          const region: Region = { units: cellUnits, bbox: c.bbox };
          for (const us of splitParagraphs(region)) parts.push({ top: us[0]!.bbox[1], units: us });
        }
        if (group) {
          // Cell edit block: one group = one cell paragraph (same-row fragments are joined).
          const us = buildUnits(model, group, fillers, true);
          if (us.length) parts.push({ top: us[0]!.bbox[1], units: us });
        }
        parts.sort((a, b) => a.top - b.top);
        const paragraphs = parts.map((part) =>
          pushPara(part.units, {
            role: 'body',
            column: -1,
            table: tableId,
            figure: null,
            region: null,
          }),
        );
        return {
          row: c.row,
          col: c.col,
          rowSpan: c.rowSpan,
          colSpan: c.colSpan,
          bbox: c.bbox,
          lines: paragraphs.flatMap((p) => drafts[p]!.body.lines),
          paragraphs,
        };
      });
      tables.push({
        id: tableId,
        bbox: t.bbox,
        rows: t.rowBounds.length - 1,
        cols: t.colBounds.length - 1,
        rowBounds: t.rowBounds,
        colBounds: t.colBounds,
        cells,
        strategy: t.strategy,
        paths: [...t.paths],
      });
      readingOrder.push({ kind: 'table', id: tableId });
    } else {
      const f = figs[it.index]!;
      const figureId = figures.length;
      const labelFeats = [...labelOf]
        .filter(([, k]) => k === it.index)
        .map(([li]) => feats[li]!)
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      const labels = labelFeats.map((lf) =>
        pushPara([makeUnit(model, [lf])], {
          role: lf.horizontal ? 'body' : 'other',
          column: -1,
          table: null,
          figure: figureId,
          region: null,
        }),
      );
      figures.push({
        id: figureId,
        bbox: it.bbox,
        kind: f.kind,
        images: f.images,
        paths: f.paths,
        labels,
      });
      readingOrder.push({ kind: 'figure', id: figureId });
    }
  }

  // Footer.
  for (const u of [...margins.footer].sort(byPos)) {
    const id = pushPara([u], {
      role: 'footer',
      column: -1,
      table: null,
      figure: null,
      region: null,
    });
    readingOrder.push({ kind: 'paragraph', id });
  }

  // Role (flow paragraphs).
  for (const d of drafts) {
    if (d.role !== 'body' || d.table !== null || d.figure !== null) continue;
    d.role = flowRole(d.units, d.body.text, body, bounds[1], pageH, d.body.bbox, [
      ...tableBoxes,
      ...figBoxes,
    ]);
  }

  // Step 7: linking across regions.
  const continuesTo = drafts.map(() => null as number | null);
  const flowOrder = readingOrder
    .filter((r) => r.kind === 'paragraph')
    .map((r) => r.id)
    .filter((id) => drafts[id]!.region !== null);
  for (let k = 0; k + 1 < flowOrder.length; k++) {
    const p = drafts[flowOrder[k]!]!;
    const q = drafts[flowOrder[k + 1]!]!;
    if (p.region === q.region || p.role !== 'body' || q.role !== 'body') continue;
    const last = p.units.at(-1)!;
    const colRight = p.region!.bbox[2];
    const colW = width(p.region!.bbox);
    if (last.bbox[2] < colRight - 0.1 * colW) continue;
    if (SENTENCE_END.test(p.body.text)) continue;
    if (q.units.length > 1 && q.body.firstLineIndent > C.indentEm * q.units[0]!.size) continue;
    // q must be the first paragraph of its own region.
    if (q.region!.units[0] !== q.units[0]) continue;
    continuesTo[flowOrder[k]!] = flowOrder[k + 1]!;
  }

  const paragraphs: LayoutParagraph[] = drafts.map((d, id) => ({
    id,
    ...d.body,
    role: d.role,
    column: d.column,
    table: d.table,
    figure: d.figure,
    continuesTo: continuesTo[id]!,
  }));
  const columns: LayoutColumn[] = columnBoxes.map((bbox, id) => ({ id, bbox }));
  if (rotatedBody.length) warnings.push(`회전·세로 줄 ${rotatedBody.length}개는 한 줄 문단(other)`);
  return {
    pageIndex: model.pageIndex,
    bounds: [...bounds] as Rect,
    columns,
    paragraphs,
    tables,
    figures,
    readingOrder,
    unassignedLines,
    warnings,
    reconMs: now() - t0,
  };
}
