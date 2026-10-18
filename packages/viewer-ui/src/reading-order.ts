/**
 * 읽기 순서와 선택 판정(순수 함수).
 *
 * 읽기 순서는 `PageModel.lines` 배열 순서(MuPDF 기준 읽기 순서)이고, 줄 안은 `LineInfo.chars` 순서다.
 * 구조화 텍스트에 없는 글자(`line` = -1, 줄이 참조하지 않는 글자)는 뒤에 따로 모아 붙인다.
 * 선택은 글자 사이 "캐럿 위치"(0 … items.length)로 다룬다. 선택 구간 = 캐럿 구간 [from, to).
 */
import type { CharInfo, PageModel, Point } from '@pdf-editor/shared-types';
import { quadFrame } from './layout.js';

export interface ReadingItem {
  /** PageModel.chars 인덱스. */
  charIndex: number;
  /** ReadingOrder.lines 인덱스. */
  line: number;
  /** PageModel.blocks 인덱스. 줄에 속하지 않은 글자는 ORPHAN_BLOCK. */
  block: number;
}

export interface ReadingLine {
  /** ReadingOrder.items 구간 [start, end). */
  start: number;
  end: number;
  block: number;
  /** 구조화 텍스트에 없어 글리프 순서·위치로 묶은 줄. */
  orphan: boolean;
}

export interface ReadingOrder {
  items: ReadingItem[];
  lines: ReadingLine[];
  /** 구조화 텍스트에 없는 글자 수. */
  orphanChars: number;
}

export const ORPHAN_BLOCK = -1;

/** 글리프 순서가 이어지는 글자를 기준선 위치로 줄로 묶는다. */
function sameOrphanLine(a: CharInfo, b: CharInfo): boolean {
  if (a.wmode !== b.wmode) return false;
  const tolerance = 0.5 * Math.max(a.size, b.size, 1);
  // 가로 쓰기는 x 로 진행하고 y 가 줄 위치, 세로 쓰기는 반대.
  const [alongA, acrossA] = a.wmode === 1 ? [a.origin[1], a.origin[0]] : [a.origin[0], a.origin[1]];
  const [alongB, acrossB] = a.wmode === 1 ? [b.origin[1], b.origin[0]] : [b.origin[0], b.origin[1]];
  if (Math.abs(acrossA - acrossB) > tolerance) return false;
  return alongB >= alongA - tolerance;
}

function groupOrphanLines(chars: CharInfo[], indices: number[]): number[][] {
  const groups: number[][] = [];
  let current: number[] | null = null;
  let prev: CharInfo | null = null;
  for (const index of indices) {
    const char = chars[index]!;
    if (current && prev && sameOrphanLine(prev, char)) {
      current.push(index);
    } else {
      current = [index];
      groups.push(current);
    }
    prev = char;
  }
  return groups;
}

export function buildReadingOrder(model: PageModel): ReadingOrder {
  const n = model.chars.length;
  const covered = new Uint8Array(n);
  const items: ReadingItem[] = [];
  const lines: ReadingLine[] = [];

  for (const line of model.lines) {
    const start = items.length;
    for (const charIndex of line.chars) {
      if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= n || covered[charIndex]) {
        continue;
      }
      covered[charIndex] = 1;
      items.push({ charIndex, line: lines.length, block: line.block });
    }
    if (items.length > start) {
      lines.push({ start, end: items.length, block: line.block, orphan: false });
    }
  }

  const orphans: number[] = [];
  for (let i = 0; i < n; i++) if (!covered[i]) orphans.push(i);
  for (const group of groupOrphanLines(model.chars, orphans)) {
    const start = items.length;
    for (const charIndex of group) {
      items.push({ charIndex, line: lines.length, block: ORPHAN_BLOCK });
    }
    lines.push({ start, end: items.length, block: ORPHAN_BLOCK, orphan: true });
  }

  return { items, lines, orphanChars: orphans.length };
}

export interface AssembleOptions {
  /** 같은 블록 안 줄 사이(기본 "\n"). */
  lineSeparator?: string;
  /** 블록 사이(기본 "\n\n", MuPDF 텍스트 출력과 같은 빈 줄). */
  blockSeparator?: string;
}

/** 캐럿 구간 [from, to) 의 글자를 읽기 순서 텍스트로 조립한다. 범위는 자동으로 보정한다. */
export function assembleText(
  model: PageModel,
  order: ReadingOrder,
  from: number,
  to: number,
  options: AssembleOptions = {},
): string {
  const { lineSeparator = '\n', blockSeparator = '\n\n' } = options;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(order.items.length, Math.max(from, to));
  let out = '';
  for (let k = lo; k < hi; k++) {
    const item = order.items[k]!;
    if (k > lo) {
      const prev = order.items[k - 1]!;
      if (item.line !== prev.line)
        out += item.block !== prev.block ? blockSeparator : lineSeparator;
    }
    out += model.chars[item.charIndex]!.text;
  }
  return out;
}

/**
 * 글자 quad 까지의 거리에서 줄 진행 방향 거리의 가중치. 줄 사이 방향 거리를 더 크게 쳐서, 텍스트 아래·옆을 끌 때
 * 긴 앞줄의 끝 글자보다 세로로 가까운 줄을 고르게 한다(0 이면 줄 높이 범위만 본다).
 */
export const ALONG_LINE_WEIGHT = 0.25;

export interface PointLocation {
  /** 글자 quad 까지의 가중 거리(pt). 안쪽이면 0. */
  distance: number;
  /** 읽기 진행 방향(가로 쓰기는 ul→ur, 세로 쓰기는 ul→ll)으로 본 위치 비율. 안쪽이면 0–1. */
  progress: number;
}

/** 점이 글자 quad 의 어디에 있는지. 폭·높이가 0 인 quad 도 안전하게 다룬다. */
export function locatePoint(char: CharInfo, p: Point): PointLocation {
  const f = quadFrame(char.quad);
  const dx = p[0] - f.ox;
  const dy = p[1] - f.oy;
  const s = dx * f.ux + dy * f.uy;
  const t = dx * f.vx + dy * f.vy;
  const ds = s < 0 ? -s : s > f.lu ? s - f.lu : 0;
  const dt = t < 0 ? -t : t > f.lv ? t - f.lv : 0;
  const vertical = char.wmode === 1;
  const progress = vertical ? (f.lv > 0 ? t / f.lv : 0) : f.lu > 0 ? s / f.lu : 0;
  // 가로 쓰기는 u(ds)가 줄 진행 방향, 세로 쓰기는 v(dt)가 줄 진행 방향이다.
  const distance = vertical
    ? Math.hypot(ds, ALONG_LINE_WEIGHT * dt)
    : Math.hypot(ALONG_LINE_WEIGHT * ds, dt);
  return { distance, progress };
}

export interface CaretHit {
  /** 캐럿 위치(0 … items.length). 글자 k 의 앞이 k, 뒤가 k + 1. */
  caret: number;
  /** 가장 가까운 글자의 ReadingOrder.items 인덱스. */
  item: number;
  distance: number;
}

/**
 * 점(페이지 공간)에서 가장 가까운 글자와 캐럿 위치. 글자 안이면 절반 앞쪽은 글자 앞, 뒤쪽은 글자 뒤.
 * 줄 끝 바깥·줄 사이·글자가 없는 곳에서도 가장 가까운 글자(가중 거리, `ALONG_LINE_WEIGHT`)로 정해지므로
 * 드래그가 튀지 않는다.
 * 거리가 같으면 읽기 순서가 앞선 글자.
 */
export function caretAt(model: PageModel, order: ReadingOrder, p: Point): CaretHit | null {
  let best = -1;
  let bestDistance = Infinity;
  let bestProgress = 0;
  for (let k = 0; k < order.items.length; k++) {
    const char = model.chars[order.items[k]!.charIndex]!;
    const loc = locatePoint(char, p);
    if (loc.distance < bestDistance) {
      best = k;
      bestDistance = loc.distance;
      bestProgress = loc.progress;
      // 글자 안이면 이후 글자와 겹쳐도 읽기 순서가 앞선 글자를 유지한다.
      if (bestDistance === 0) break;
    }
  }
  if (best < 0) return null;
  return { caret: best + (bestProgress > 0.5 ? 1 : 0), item: best, distance: bestDistance };
}

/** 점이 안에 들어 있는 글자의 ReadingOrder.items 인덱스. 없으면 -1. */
export function itemAtPoint(model: PageModel, order: ReadingOrder, p: Point): number {
  for (let k = 0; k < order.items.length; k++) {
    const char = model.chars[order.items[k]!.charIndex]!;
    if (locatePoint(char, p).distance === 0) return k;
  }
  return -1;
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

/** 더블클릭: 같은 줄에서 공백/비공백이 이어지는 구간(캐럿 구간). */
export function wordRange(model: PageModel, order: ReadingOrder, item: number): [number, number] {
  const target = order.items[item];
  if (!target) return [0, 0];
  const line = order.lines[target.line]!;
  const kind = isBlank(model.chars[target.charIndex]!.text);
  let from = item;
  let to = item + 1;
  while (
    from > line.start &&
    isBlank(model.chars[order.items[from - 1]!.charIndex]!.text) === kind
  ) {
    from--;
  }
  while (to < line.end && isBlank(model.chars[order.items[to]!.charIndex]!.text) === kind) {
    to++;
  }
  return [from, to];
}

/** 트리플클릭: 줄 전체(캐럿 구간). */
export function lineRange(order: ReadingOrder, item: number): [number, number] {
  const target = order.items[item];
  if (!target) return [0, 0];
  const line = order.lines[target.line]!;
  return [line.start, line.end];
}
