/**
 * 시각 줄(Unit): 같은 행의 가까운 stext 줄 조각을 합친 단위(계약 3절 5단계 첫 항목).
 * 영역 쌓기·문단 나누기·머리·꼬리 판정은 Unit 단위로 한다.
 */
import type { PageModel, RGB, Rect } from '@pdf-editor/shared-types';
import { C } from './constants.js';
import type { LineFeature } from './features.js';
import { height, overlapY, union, width } from './geom.js';

export interface Unit {
  /** 왼쪽 → 오른쪽 조각(흡수한 첨자·기호 조각 포함). */
  parts: LineFeature[];
  /** 배치 판단용 상자(흡수한 조각 제외). */
  bbox: Rect;
  /** 흡수한 조각까지 덮는 상자(문단 상자용). */
  full: Rect;
  size: number;
  baseline: number;
  /** 보이는 글자 과반이 굵은 폰트. */
  bold: boolean;
  /** 보이는 글자 과반의 색(없으면 null). */
  color: RGB | null;
  /** 조각 텍스트를 공백으로 이은 것. */
  text: string;
}

/** 줄 끝 번호: 쪽 번호·식 번호. */
const NUMBER_TAG = /^\s*\(?\d{1,4}(?:\.\d{1,3})?[a-z]?\)?\s*$/u;

/** 점 끈(목차). */
export const LEADER = /(?:\.\s?){4,}\s*$|…{2,}\s*$/u;

const colorKey = (c: RGB | null): string =>
  c ? c.map((v) => Math.round(v * 20)).join(',') : 'none';

/** 조각들로 Unit 을 만든다(parts 는 이미 왼쪽→오른쪽). */
export function makeUnit(model: PageModel, parts: LineFeature[]): Unit {
  let bbox = parts[0]!.bbox;
  for (const p of parts.slice(1)) bbox = union(bbox, p.bbox);
  let boldChars = 0;
  let visible = 0;
  const colors = new Map<string, { c: RGB | null; n: number }>();
  for (const p of parts) {
    for (const ci of p.chars) {
      const ch = model.chars[ci]!;
      if (ch.text.trim() === '') continue;
      visible++;
      if (model.fonts[ch.fontId]?.bold) boldChars++;
      const k = colorKey(ch.color);
      const e = colors.get(k) ?? { c: ch.color, n: 0 };
      e.n++;
      colors.set(k, e);
    }
  }
  const top = [...colors.values()].sort((a, b) => b.n - a.n)[0];
  // 기준 조각: 글자가 가장 많은 조각(같으면 큰 쪽). 첨자·큰 연산자 조각이 기준선·크기를 흔들지 않게 한다.
  const main = parts.reduce((m, p) =>
    p.chars.length > m.chars.length || (p.chars.length === m.chars.length && p.size > m.size)
      ? p
      : m,
  );
  return {
    parts,
    bbox,
    full: bbox,
    size: main.size,
    baseline: main.baseline,
    bold: visible > 0 ? boldChars * 2 > visible : parts.every((p) => p.bold),
    color: top && top.n * 2 > visible ? top.c : null,
    text: parts.map((p) => p.text).join(' '),
  };
}

/** 같은 행 판정. */
export function sameRow(a: Rect, b: Rect): boolean {
  return overlapY(a, b) >= C.sameRowOverlap * Math.min(height(a), height(b));
}

/**
 * 가로 줄을 행으로 묶고, 행 안에서 간격이 글자 크기 × rowJoinGapEm 이하인 이웃 조각을 합친다.
 * 결과는 위→아래, 왼쪽→오른쪽.
 */
export function buildUnits(
  model: PageModel,
  feats: readonly LineFeature[],
  fillers: readonly Rect[] = [],
): Unit[] {
  const pageWidth = width(model.bounds);
  // 행 간격을 메우는 것: 인라인 이미지와 다른 글자 조각(수식의 큰 연산자·첨자는 다른 기준선의 조각이다).
  // 글자 조각은 좁고(쪽 폭 25% 이하) 행 높이를 거의 다 덮을 때만 메운다(다른 열의 줄은 메우지 않음).
  const textFillers = feats.map((f) => f.bbox).filter((r) => width(r) <= 0.25 * pageWidth);
  const sorted = [...feats].sort((a, b) => a.baseline - b.baseline || a.bbox[0] - b.bbox[0]);
  const rows: LineFeature[][] = [];
  for (const f of sorted) {
    const row = rows.at(-1);
    const ref = row?.[0];
    // 위·아래 첨자 조각(크기 비 1.3 초과)은 기준선 차이를 더 허용한다.
    const ratio = ref ? Math.max(f.size, ref.size) / Math.max(Math.min(f.size, ref.size), 0.1) : 1;
    const tol = (ratio > 1.3 ? 0.6 : 0.35) * Math.max(f.size, ref?.size ?? 0);
    if (row && ref && Math.abs(f.baseline - ref.baseline) <= tol && sameRow(f.bbox, ref.bbox))
      row.push(f);
    else rows.push([f]);
  }
  const units: Unit[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.bbox[0] - b.bbox[0]);
    // 머리·꼬리 띠의 행(러닝헤드 + 쪽 번호)에는 줄 끝 번호 잇기를 하지 않는다.
    const pageH = height(model.bounds);
    const inMargin =
      row[0]!.bbox[3] <= model.bounds[1] + C.marginBand * pageH ||
      row[0]!.bbox[1] >= model.bounds[3] - C.marginBand * pageH;
    let parts: LineFeature[] = [row[0]!];
    for (const f of row.slice(1)) {
      const prev = parts.at(-1)!;
      const gap = Math.min(
        uncoveredGap(prev.bbox, f.bbox, fillers, 0.5),
        uncoveredGap(prev.bbox, f.bbox, [...fillers, ...textFillers], 0.8),
      );
      const ratio = Math.max(f.size, prev.size) / Math.max(Math.min(f.size, prev.size), 0.1);
      // 위·아래 첨자(작은 조각이 바로 붙음)는 크기 비율과 무관하게 합친다.
      const script = ratio > 1.5 && gap <= 0.3 * Math.max(f.size, prev.size);
      const em = Math.max(f.size, prev.size);
      // 번호·쪽 번호 같은 짧은 조각(폭 3em 이하)은 2em 간격까지 잇는다(목차·절 번호).
      const shortPart = Math.min(width(prev.bbox), width(f.bbox)) <= 3 * em;
      const near = gap <= C.rowJoinGapEm * em || (shortPart && gap <= 2 * em);
      // 줄 끝 번호(목차 쪽 번호·식 번호)는 넓은 왼쪽 조각(쪽 폭 25% 이상) 또는 점 끈 뒤면 간격과 무관하게 잇는다.
      const tag =
        !inMargin &&
        f === row.at(-1) &&
        NUMBER_TAG.test(f.text) &&
        (width(prev.bbox) >= 0.25 * pageWidth || LEADER.test(prev.text));
      if ((near && (ratio <= 1.5 || script)) || tag) parts.push(f);
      else {
        units.push(makeUnit(model, parts));
        parts = [f];
      }
    }
    units.push(makeUnit(model, parts));
  }
  return absorbMinor(model, units).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}

const visibleCount = (u: Unit): number => u.text.replace(/\s/gu, '').length;

/**
 * 보이는 글자 3개 이하 조각(수식 첨자·큰 연산자·따로 잡힌 글머리)을 세로로 겹치고 가로로 가까운 본 단위에
 * 흡수한다. 흡수한 조각은 텍스트·줄 목록에는 들어가지만 배치 판단 상자(bbox)는 바꾸지 않는다.
 */
function absorbMinor(model: PageModel, units: Unit[]): Unit[] {
  // 작은 조각: 보이는 글자 3개 이하, 또는 본문 크기 80% 이하 글자의 10자 이하 조각(첨자 묶음).
  const sizes = units.map((u) => u.size).sort((a, b) => a - b);
  const typical = sizes.length ? sizes[sizes.length >> 1]! : 10;
  const isMinor = (u: Unit) =>
    visibleCount(u) <= 3 || (u.size <= 0.8 * typical && visibleCount(u) <= 10);
  const minor = units.filter(isMinor);
  if (minor.length === 0) return units;
  const major = units.filter((u) => !isMinor(u));
  const hosts = new Map<Unit, Unit[]>();
  const kept: Unit[] = [];
  for (const m of minor) {
    let best: Unit | null = null;
    let bestScore = -Infinity;
    for (const u of major) {
      const ov = overlapY(m.bbox, u.bbox);
      if (ov < 0.3 * Math.min(height(m.bbox), height(u.bbox))) continue;
      const gapX = Math.max(0, Math.max(m.bbox[0], u.bbox[0]) - Math.min(m.bbox[2], u.bbox[2]));
      if (gapX > 1.5 * u.size) continue;
      const score = ov / Math.max(height(m.bbox), 0.1) - gapX / (10 * u.size);
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    if (best) hosts.set(best, [...(hosts.get(best) ?? []), m]);
    else kept.push(m);
  }
  const merged = major.map((u) => {
    const extra = hosts.get(u);
    if (!extra) return u;
    const parts = [...u.parts, ...extra.flatMap((m) => m.parts)].sort(
      (a, b) => a.bbox[0] - b.bbox[0],
    );
    const nu = makeUnit(model, parts);
    // 판단 상자·크기·기준선은 본 단위 것을 쓴다.
    return { ...nu, bbox: u.bbox, size: u.size, baseline: u.baseline, full: nu.bbox };
  });
  return [...merged, ...kept];
}

/**
 * 두 조각 사이 가로 간격에서 같은 행의 인라인 이미지(글리프 그림 등)가 덮는 길이를 뺀 값.
 * Hancom 출력은 구결·외자 글리프를 작은 이미지로 넣어 줄을 여러 stext 줄로 쪼갠다(2026-10-19 실측).
 */
function uncoveredGap(a: Rect, b: Rect, fillers: readonly Rect[], minCover: number): number {
  const lo = a[2];
  const hi = b[0];
  if (hi <= lo || fillers.length === 0) return hi - lo;
  const row: Rect = [lo, Math.min(a[1], b[1]), hi, Math.max(a[3], b[3])];
  const spans = fillers
    .filter(
      (r) =>
        r[2] > lo && r[0] < hi && overlapY(r, row) >= minCover * Math.min(height(r), height(row)),
    )
    .map((r) => [Math.max(r[0], lo), Math.min(r[2], hi)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let end = lo;
  for (const [s0, s1] of spans) {
    const st = Math.max(s0, end);
    if (s1 > st) covered += s1 - st;
    end = Math.max(end, s1);
  }
  return hi - lo - covered;
}

/** 인라인 이미지 후보: 높이가 글자 크기 3배 이하인 작은 이미지. */
export function inlineImages(model: PageModel, size: number): Rect[] {
  return model.images
    .filter(
      (im) => im.op !== 'clip-image-mask' && height(im.bbox) <= 3 * size && height(im.bbox) > 0,
    )
    .map((im) => im.bbox);
}
