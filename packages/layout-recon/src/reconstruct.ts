/**
 * PageModel → PageLayout(계약 docs/m2-contract.md 3절).
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
  /** ML 보조 후보(계약 3절 8단계). v1 기본 구현 없음. */
  plugins?: readonly LayoutPlugin[];
  /**
   * 이웃 쪽(앞뒤 1–2쪽) 추출 모델. 주면 같은 자리·같은 글(숫자 무시)로 반복되는 쪽 위·아래 줄을
   * 머리·꼬리로 본다(러닝헤드·쪽 번호, 계약 2.5). 없으면 쪽 하나만 본다.
   */
  neighbors?: readonly PageModel[];
  /**
   * 한 문단으로 고정할 PageModel 줄 묶음(M3 편집 블록, docs/m3-integration.md 9.6). 묶음마다 정확히 문단 하나가
   * 된다(줄은 위→아래). 묶음 줄도 표 감지 입력에 넣고(M4 4.1: 셀 편집 블록이 빠지면 셀이 비고 정렬 전략 표가 깨진다),
   * 감지 뒤 묶음의 줄이 모두 한 셀에 들면 그 셀 문단 = 묶음 하나(`table` 설정, 같은 셀의 다른 줄은 보통 나누기).
   * 그 밖의 묶음은 흐름 문단(역할은 다른 흐름 문단과 같은 규칙)이고, 그 줄은 표 셀·도형·머리·꼬리·영역 쌓기·문단
   * 나누기에서 뺀다. 흐름 묶음 문단은 묶음 줄 상자 합으로 XY-cut 에 들어가 첫 줄 자리의 읽기 순서·열을 받는다.
   * 보이지 않는 줄·가로가 아닌 줄·범위 밖 번호는 무시하고, 여러 묶음에 든 줄은 앞 묶음이 갖는다. 없으면 M2 결과와 같다.
   */
  fixedGroups?: readonly (readonly number[])[];
}

/** 반복 비교용 글 정규화: 소문자, 숫자 → #, 공백 하나. */
const normRepeat = (t: string): string =>
  t.toLowerCase().replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();

/** 이웃 쪽에 같은 자리(위 끝 ±3pt, 왼쪽 또는 오른쪽 끝 ±3pt)·같은 정규화 글로 있는 쪽 위·아래 20% 단위. */
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

/** ML 플러그인 슬롯. 순수 함수여야 한다(모델 추론 결과를 미리 계산해 넘기는 어댑터 포함). */
export interface LayoutPlugin {
  name: string;
  proposeRegions(model: PageModel): readonly RegionProposal[];
}

/** DOM·Node 타입 없이 쓰는 시계(Worker·Node 모두 performance 가 있다). */
const now = (): number =>
  (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

interface Draft {
  body: ParagraphBody;
  units: Unit[];
  role: ParagraphRole;
  column: number;
  table: number | null;
  figure: number | null;
  /** 흐름 문단의 영역(열 넘김 연결용). */
  region: Region | null;
}

const FOOTNOTE_START = /^\s*(?:\d{1,3}|[*†‡§¶])\s?\S/u;

/** 캡션 인접: 같은 가로 범위의 도형·표가 위·아래 3em 안에 있거나, 옆(세로 겹침)에 3em 안에 있다. */
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
  // 고정 묶음(편집 블록): 보이는 가로 줄만, 줄마다 첫 묶음 하나.
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

  // 3단계: 표(고정 묶음 줄 포함). 묶음 → 그 줄을 모두 담은 셀(표 번호:셀 번호). 한 셀에 들지 않는 묶음은 빼고
  // 다시 감지한다(그 묶음 줄이 표 감지를 바꾸지 않게, M3 9.6 결과 유지). 두 번 뒤에도 남으면 그 줄만 셀에서 뺀다.
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

  // 4단계: 도형과 라벨.
  const free = (f: LineFeature) => !tableLines.has(f.index) && !fixedOf.has(f.index);
  // 표 안에 대부분(60% 이상) 들어가는 도형 후보는 표의 남은 괘선·배경이다.
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
      // 산문 줄(6단어 이상, 도형 폭 절반 이상)은 라벨이 아니라 흐름 본문이다(사진 위 본문·사이드바).
      if (f.words.length >= 6 && width(f.bbox) > 0.5 * width(fig.bbox)) continue;
      labelOf.set(f.index, k);
    }
  });

  // 5단계: 흐름 단위·머리·꼬리.
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
  // 본문 가로 줄이 없으면(가로 표를 회전해 넣은 쪽, 세로쓰기 쪽) 섹션 탭 판정을 하지 않는다.
  // 탭은 본문 가로 범위 밖이면서 쪽 좌우 여백 띠(쪽 폭 15%) 안에 있어야 한다.
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
  // 고정 묶음 문단: 같은 행 조각은 간격과 무관하게 잇는다(양쪽 정렬 줄의 넓은 단어 간격으로 가로로 갈라지지 않게).
  const fixedUnits = fixedGroups.map((g) => buildUnits(model, g, fillers, true));
  const fixedBoxes: Rect[] = fixedUnits.map((us) =>
    us.slice(1).reduce((b, u) => union(b, u.full), us[0]!.full),
  );
  const regions = stackRegions(margins.body, [...tableBoxes, ...figBoxes, ...fixedBoxes]);

  // 6단계: XY-cut.
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

  // 머리.
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

  // 열 번호: 가장 안쪽 세로 자르기 묶음, 묶음 밖 항목은 연속 구간마다 새 열.
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
          // 셀 편집 블록: 묶음 하나 = 셀 문단 하나(같은 행 조각은 잇는다).
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

  // 꼬리.
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

  // 역할(흐름 문단).
  for (const d of drafts) {
    if (d.role !== 'body' || d.table !== null || d.figure !== null) continue;
    d.role = flowRole(d.units, d.body.text, body, bounds[1], pageH, d.body.bbox, [
      ...tableBoxes,
      ...figBoxes,
    ]);
  }

  // 7단계: 영역 넘김 연결.
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
    // q 는 자기 영역의 첫 문단이어야 한다.
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
