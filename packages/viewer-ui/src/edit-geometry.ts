/**
 * 편집 중 캐럿·선택·조합 밑줄·표시 상자 계산(순수). 모두 `ReflowSummary`(페이지 공간 pt)로 그린다(계약 D7).
 * 가정: 가로쓰기 왼쪽 → 오른쪽. `PlacedLine` 의 [start, end) 가 강제 줄바꿈 `\n` 을 포함하든 빼든 같은 결과가 나오게 한다.
 */
import type {
  PageModel,
  Point,
  PlacedGlyph,
  PlacedLine,
  Rect,
  ReflowSummary,
} from '@pdf-editor/shared-types';
import type { Affinity } from './edit-model.js';

export interface CaretBox {
  /** 캐럿 x(페이지 공간). */
  x: number;
  /** 줄 위쪽·아래쪽(baseline − ascent, baseline + descent). */
  top: number;
  bottom: number;
  line: number;
}

const isSpace = (s: string): boolean => /^\s*$/.test(s);

/** 줄이 보여 주는 텍스트 끝(강제 줄바꿈 글자는 뺀다). */
export function lineVisibleEnd(line: PlacedLine, text: string): number {
  if (line.hardBreak && line.end > line.start && text[line.end - 1] === '\n') return line.end - 1;
  return Math.min(line.end, text.length);
}

function glyphsOf(reflow: ReflowSummary, line: PlacedLine): PlacedGlyph[] {
  return reflow.glyphs
    .filter((g) => g.offset >= line.start && g.offset < line.end)
    .sort((a, b) => a.offset - b.offset);
}

/** 줄이 소프트 줄바꿈(다음 줄로 이어짐)으로 끝나는지. */
function isSoftWrapped(reflow: ReflowSummary, index: number): boolean {
  const line = reflow.lines[index];
  return line !== undefined && !line.hardBreak && index < reflow.lines.length - 1;
}

/** offset 이 속한 줄 번호. 소프트 줄바꿈 경계는 affinity 로 정한다. */
export function lineIndexOf(
  reflow: ReflowSummary,
  text: string,
  offset: number,
  affinity: Affinity = 'downstream',
): number {
  const hits: number[] = [];
  reflow.lines.forEach((line, i) => {
    if (offset >= line.start && offset <= lineVisibleEnd(line, text)) hits.push(i);
  });
  if (hits.length === 0)
    return offset < (reflow.lines[0]?.start ?? 0) ? 0 : reflow.lines.length - 1;
  if (hits.length === 1) return hits[0]!;
  return affinity === 'upstream' ? hits[0]! : hits[hits.length - 1]!;
}

/** 줄 안 offset 의 x. 소프트 줄바꿈 줄 끝의 공백 구간은 줄 오른쪽 끝(x1)에 둔다. */
function xInLine(reflow: ReflowSummary, text: string, index: number, offset: number): number {
  const line = reflow.lines[index]!;
  const glyphs = glyphsOf(reflow, line);
  if (glyphs.length === 0) return line.x0;
  const exact = glyphs.find((g) => g.offset === offset);
  let lastVisibleEnd = line.start;
  for (const g of glyphs) {
    if (!isSpace(text.slice(g.offset, g.offset + g.length))) lastVisibleEnd = g.offset + g.length;
  }
  if (isSoftWrapped(reflow, index) && offset > lastVisibleEnd) return line.x1;
  if (exact) return exact.x;
  let prev: PlacedGlyph | null = null;
  for (const g of glyphs) {
    if (g.offset < offset) prev = g;
    else break;
  }
  if (!prev) return line.x0;
  return offset < prev.offset + prev.length ? prev.x : prev.x + prev.advance;
}

/** offset 의 캐럿 상자. */
export function caretBox(
  reflow: ReflowSummary,
  text: string,
  offset: number,
  affinity: Affinity = 'downstream',
): CaretBox | null {
  if (reflow.lines.length === 0) return null;
  const index = lineIndexOf(reflow, text, offset, affinity);
  const line = reflow.lines[index]!;
  return {
    x: xInLine(reflow, text, index, offset),
    top: line.baseline - Math.abs(line.ascent),
    bottom: line.baseline + Math.abs(line.descent),
    line: index,
  };
}

export interface OffsetHit {
  offset: number;
  affinity: Affinity;
}

/** 줄 안에서 x 에 가장 가까운 캐럿 위치. */
export function offsetAtX(
  reflow: ReflowSummary,
  text: string,
  index: number,
  x: number,
): OffsetHit {
  const line = reflow.lines[index];
  if (!line) return { offset: 0, affinity: 'downstream' };
  const end = lineVisibleEnd(line, text);
  const glyphs = glyphsOf(reflow, line);
  const candidates: { offset: number; x: number }[] = glyphs.map((g) => ({
    offset: g.offset,
    x: g.x,
  }));
  const last = glyphs.at(-1);
  // 소프트 줄바꿈 줄은 끝 공백 앞(마지막 보이는 글자 뒤)까지만 후보로 둔다. 공백 구간은 줄 끝 x1 로 접힌다.
  let visibleEnd = end;
  if (isSoftWrapped(reflow, index)) {
    visibleEnd = line.start;
    for (const g of glyphs) {
      if (!isSpace(text.slice(g.offset, g.offset + g.length))) visibleEnd = g.offset + g.length;
    }
  }
  const filtered = candidates.filter((c) => c.offset <= visibleEnd);
  const endX = last ? (isSoftWrapped(reflow, index) ? line.x1 : last.x + last.advance) : line.x0;
  filtered.push({ offset: visibleEnd, x: endX });
  if (filtered.length === 0) filtered.push({ offset: line.start, x: line.x0 });
  let best = filtered[0]!;
  for (const c of filtered) if (Math.abs(c.x - x) < Math.abs(best.x - x)) best = c;
  const wrapBoundary = isSoftWrapped(reflow, index) && best.offset === line.end;
  return { offset: best.offset, affinity: wrapBoundary ? 'upstream' : 'downstream' };
}

/** 페이지 공간 점 → 캐럿 위치. 가장 가까운 줄을 고른 뒤 x 로 정한다. */
export function offsetAtPoint(reflow: ReflowSummary, text: string, point: Point): OffsetHit {
  if (reflow.lines.length === 0) return { offset: 0, affinity: 'downstream' };
  let best = 0;
  let bestDist = Infinity;
  reflow.lines.forEach((line, i) => {
    const top = line.baseline - Math.abs(line.ascent);
    const bottom = line.baseline + Math.abs(line.descent);
    const dist = point[1] < top ? top - point[1] : point[1] > bottom ? point[1] - bottom : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return offsetAtX(reflow, text, best, point[0]);
}

/** 위(-1)·아래(+1) 줄로 이동. goalX 는 연속 이동 동안 유지하는 x. 첫 줄 위는 처음, 마지막 줄 아래는 끝. */
export function moveVertical(
  reflow: ReflowSummary,
  text: string,
  offset: number,
  affinity: Affinity,
  dir: -1 | 1,
  goalX: number | null,
): OffsetHit & { goalX: number } {
  const here = caretBox(reflow, text, offset, affinity);
  const x = goalX ?? here?.x ?? 0;
  const index = here?.line ?? 0;
  const target = index + dir;
  if (target < 0) return { offset: 0, affinity: 'downstream', goalX: x };
  if (target >= reflow.lines.length)
    return { offset: text.length, affinity: 'downstream', goalX: x };
  return { ...offsetAtX(reflow, text, target, x), goalX: x };
}

/** Home / End: 리플로우 줄 기준. */
export function lineBoundary(
  reflow: ReflowSummary,
  text: string,
  offset: number,
  affinity: Affinity,
  which: 'home' | 'end',
): OffsetHit {
  const index = lineIndexOf(reflow, text, offset, affinity);
  const line = reflow.lines[index];
  if (!line) return { offset: which === 'home' ? 0 : text.length, affinity: 'downstream' };
  if (which === 'home') return { offset: line.start, affinity: 'downstream' };
  const end = lineVisibleEnd(line, text);
  return { offset: end, affinity: isSoftWrapped(reflow, index) ? 'upstream' : 'downstream' };
}

/** [a, b) 선택 구간의 줄별 상자(페이지 공간 [x0, top, x1, bottom]). */
export function rangeRects(reflow: ReflowSummary, text: string, a: number, b: number): Rect[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo === hi) return [];
  const rects: Rect[] = [];
  reflow.lines.forEach((line, i) => {
    const end = lineVisibleEnd(line, text);
    const s = Math.max(lo, line.start);
    const e = Math.min(hi, end);
    const top = line.baseline - Math.abs(line.ascent);
    const bottom = line.baseline + Math.abs(line.descent);
    const spansBreak = hi > end && (line.hardBreak || isSoftWrapped(reflow, i)) && lo <= end;
    if (s > e || (s === e && !spansBreak)) return;
    const x0 = xInLine(reflow, text, i, s);
    let x1 = xInLine(reflow, text, i, e);
    // 줄바꿈을 지나는 선택은 줄 끝에 작은 여백을 둬 줄바꿈이 선택됐음을 보여 준다.
    if (spansBreak && line.hardBreak) x1 += 3;
    if (x1 > x0) rects.push([x0, top, x1, bottom]);
  });
  return rects;
}

/** 조건을 만족하는 글리프의 줄별 이어진 구간(페이지 공간 [x0, baseline, x1, baseline + descent]). */
function glyphSegments(reflow: ReflowSummary, pick: (g: PlacedGlyph) => boolean): Rect[] {
  const out: Rect[] = [];
  for (const line of reflow.lines) {
    let seg: Rect | null = null;
    let prevEnd = -1;
    for (const g of glyphsOf(reflow, line)) {
      if (pick(g) && g.advance > 0) {
        if (seg && g.offset === prevEnd) seg[2] = g.x + g.advance;
        else {
          if (seg) out.push(seg);
          seg = [g.x, line.baseline, g.x + g.advance, line.baseline + Math.abs(line.descent)];
        }
        prevEnd = g.offset + g.length;
      } else {
        if (seg) out.push(seg);
        seg = null;
        prevEnd = -1;
      }
    }
    if (seg) out.push(seg);
  }
  return out;
}

/** 폴백 폰트로 쓴 글자 구간(점선 밑줄 표시용). */
export function fallbackSegments(reflow: ReflowSummary): Rect[] {
  return glyphSegments(reflow, (g) => g.font.kind === 'fallback');
}

export interface MissingMark {
  x: number;
  top: number;
  bottom: number;
  /** 쓰지 않은 글자(텍스트 위치 구간). */
  offset: number;
  length: number;
}

/** 원본·폴백 모두 글리프가 없어 쓰지 않은 글자의 표시 위치. */
export function missingMarks(reflow: ReflowSummary): MissingMark[] {
  const out: MissingMark[] = [];
  reflow.glyphs.forEach((g) => {
    if (g.font.kind !== 'missing') return;
    const line =
      reflow.lines.find((l) => g.offset >= l.start && g.offset < l.end) ?? reflow.lines[0];
    if (!line) return;
    out.push({
      x: g.x,
      top: line.baseline - Math.abs(line.ascent),
      bottom: line.baseline + Math.abs(line.descent),
      offset: g.offset,
      length: g.length,
    });
  });
  return out;
}

/** 조합 밑줄: [s, e) 구간의 줄별 밑줄(페이지 공간 [x0, y, x1, y]). */
export function compositionUnderlines(
  reflow: ReflowSummary,
  text: string,
  range: [number, number],
): Rect[] {
  return rangeRects(reflow, text, range[0], range[1]).map(([x0, , x1, bottom]) => [
    x0,
    bottom,
    x1,
    bottom,
  ]);
}

// ── 시작 캐럿(원 문서 글자 → 텍스트 위치) ───────────────────────────────

/**
 * 더블클릭한 페이지 점에서 가장 가까운 원 문서 글자(`PageModel.chars`)를 찾아 편집 텍스트 위치로 바꾼다
 * (계획의 `charIndexOfOffset`, 계약 5.3). 글자 가운데보다 오른쪽이면 그 글자 뒤. 합성 공백(-1)은 건너뛴다.
 * 매핑이 비어 있으면 null.
 */
export function offsetAtPagePoint(
  model: PageModel,
  charIndexOfOffset: number[],
  point: Point,
): number | null {
  const first = new Map<number, number>();
  const last = new Map<number, number>();
  charIndexOfOffset.forEach((c, k) => {
    if (c < 0) return;
    if (!first.has(c)) first.set(c, k);
    last.set(c, k);
  });
  let bestChar = -1;
  let bestDist = Infinity;
  let bestCenter = 0;
  for (const c of first.keys()) {
    const ch = model.chars[c];
    if (!ch) continue;
    const xs = [ch.quad[0], ch.quad[2], ch.quad[4], ch.quad[6]];
    const ys = [ch.quad[1], ch.quad[3], ch.quad[5], ch.quad[7]];
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    const dx = point[0] < x0 ? x0 - point[0] : point[0] > x1 ? point[0] - x1 : 0;
    const dy = point[1] < y0 ? y0 - point[1] : point[1] > y1 ? point[1] - y1 : 0;
    // 줄 방향(가로)보다 줄 사이 거리를 무겁게 본다.
    const dist = Math.hypot(dx, dy * 2);
    if (dist < bestDist) {
      bestDist = dist;
      bestChar = c;
      bestCenter = (x0 + x1) / 2;
    }
  }
  if (bestChar < 0) return null;
  return point[0] > bestCenter ? last.get(bestChar)! + 1 : first.get(bestChar)!;
}

/** 점이 놓인 가장 안쪽(면적이 가장 작은) 문단. 없으면 null. */
export function paragraphAt<T extends { bbox: Rect }>(paragraphs: T[], point: Point): T | null {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const p of paragraphs) {
    const [x0, y0, x1, y1] = p.bbox;
    if (point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      bestArea = area;
      best = p;
    }
  }
  return best;
}

export type HandleName = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 영역 핸들 드래그: 변·모서리를 (dx, dy)pt 만큼 움직인 영역. 상한(limit) 안으로 자르고 최소 크기를 보장한다. */
export function resizeArea(
  area: Rect,
  handle: HandleName,
  dx: number,
  dy: number,
  limit: Rect,
  minWidth = 20,
  minHeight = 8,
): Rect {
  let [x0, y0, x1, y1] = area;
  if (handle.includes('w')) x0 = Math.min(Math.max(x0 + dx, limit[0]), x1 - minWidth);
  if (handle.includes('e')) x1 = Math.max(Math.min(x1 + dx, limit[2]), x0 + minWidth);
  if (handle.includes('n')) y0 = Math.min(Math.max(y0 + dy, limit[1]), y1 - minHeight);
  if (handle.includes('s')) y1 = Math.max(Math.min(y1 + dy, limit[3]), y0 + minHeight);
  return [x0, y0, x1, y1];
}
