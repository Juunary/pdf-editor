/**
 * 문단 배치(계약 5.4). 클러스터 셰이핑 → 줄 나눔(탐욕, 첫 맞춤) → 초과 시 영역 아래 변 자동 확장(상한까지) → 정렬·좌표.
 * 좌표는 페이지 공간(y 아래), 길이 pt. 같은 입력이면 같은 결과다(reflowMs 제외).
 */
import type { PlacedGlyph, PlacedLine, Rect } from '@pdf-editor/shared-types';
import { now } from './clock.js';
import type { FontFace, FontSegment, ReflowInput, ReflowResult, WritableGlyph } from './index.js';
import { shaperFor, type ShapedGlyph } from './shaper.js';
import {
  classifyCluster,
  graphemeRanges,
  normalBreakBefore,
  preferredEmergencyBreakBefore,
  type CharClass,
} from './text.js';

/** 줄 폭 판정 여유(pt). 원 문단 bbox 와 같은 폭의 줄이 부동소수 오차로 넘치지 않게 한다. */
export const FIT_EPSILON = 0.01;
/** 초과 판정 여유(pt, 계약 5.4: 영역 아래 + 0.5pt). */
export const OVERFLOW_TOLERANCE = 0.5;
/** 폰트 높이 정보가 없을 때 쓰는 기본값(1/1000 em). */
const DEFAULT_ASCENT = 800;
const DEFAULT_DESCENT = -200;

type ItemKind = 'glyph' | 'missing' | 'break';

interface Item {
  start: number;
  end: number;
  seg: FontSegment;
  kind: ItemKind;
  /** kind 가 glyph 일 때만 있다. */
  face: FontFace | null;
  glyphs: ShapedGlyph[];
  /** 전진량(pt, 커닝 포함). */
  adv: number;
  /** adv 중 다음 클러스터와의 커닝(pt). */
  kernAfter: number;
  cc: CharClass;
}

interface LineRange {
  /** 클러스터 인덱스 [a, b). */
  a: number;
  b: number;
  hard: boolean;
}

interface Metrics {
  ascent: number;
  descent: number;
}

export function layout(input: ReflowInput): ReflowResult {
  const t0 = now();
  validate(input);
  const { text, segments, format, areaLimit } = input;
  const items = buildItems(text, segments);
  const ccs = items.map((it) => it.cc);
  const normal = items.map((_, i) => i > 0 && normalBreakBefore(ccs, i));
  const preferred = items.map((_, i) => i > 0 && preferredEmergencyBreakBefore(ccs, i));

  let area = intersect(format.area, areaLimit);
  const indent = Number.isFinite(format.firstLineIndent) ? format.firstLineIndent : 0;
  const lineLeft = (idx: number): number =>
    area[0] + (idx === 0 ? Math.max(indent, 0) : Math.max(-indent, 0));
  const lineWidth = (idx: number): number =>
    Math.max(0, area[2] - area[0] - (idx === 0 ? Math.max(indent, 0) : Math.max(-indent, 0)));
  const maxSize = segments.reduce((m, sg) => Math.max(m, sg.size), 0) || 12;
  const lineHeight = format.lineHeight > 0 ? format.lineHeight : maxSize * 1.2;
  const firstBaselineOffset = Number.isFinite(format.firstBaselineOffset)
    ? format.firstBaselineOffset
    : maxSize;
  const baseline = (idx: number): number => area[1] + firstBaselineOffset + idx * lineHeight;
  const firstFace = segments.find((sg) => sg.face !== null)?.face ?? null;
  const metricsOf = (line: LineRange): Metrics =>
    lineMetrics(items, line) ??
    caretMetrics(text, segments, firstFace, offsetOf(items, line, text), lineHeight);
  const bottomOf = (lines: LineRange[]): number => {
    const last = lines.length - 1;
    const lastLine = lines[last];
    return lastLine === undefined ? area[1] : baseline(last) - metricsOf(lastLine).descent;
  };

  const lines = breakLines(items, normal, preferred, lineWidth);
  const bottom = bottomOf(lines);
  // 초과하면 아래 변을 필요한 높이까지 자동으로 내린다(상한까지, 2026-10-20 사용자 결정). 줄 폭은 그대로라 줄 나눔은
  // 바뀌지 않는다. 사용자가 핸들로 영역을 글 높이보다 줄여도 같은 규칙으로 다시 늘어난다. 상한에 막히면 초과 유지.
  let overflow = bottom > area[3] + OVERFLOW_TOLERANCE;
  if (overflow) {
    area = [area[0], area[1], area[2], Math.max(area[3], Math.min(areaLimit[3], bottom))];
    overflow = bottom > area[3] + OVERFLOW_TOLERANCE;
  }

  const placedLines: PlacedLine[] = [];
  const glyphs: PlacedGlyph[] = [];
  const writable: WritableGlyph[][] = [];
  let box: Rect | null = null;
  lines.forEach((line, idx) => {
    const y = baseline(idx);
    const m = metricsOf(line);
    const isLast = idx === lines.length - 1;
    const placed = placeLine(items, line, lineLeft(idx), lineWidth(idx), format.align, isLast, y);
    glyphs.push(...placed.glyphs);
    writable.push(placed.writable);
    const start = line.a < line.b ? (items[line.a]?.start ?? 0) : offsetOf(items, line, text);
    const end = line.a < line.b ? (items[line.b - 1]?.end ?? start) : start;
    placedLines.push({
      baseline: y,
      x0: placed.x0,
      x1: placed.x1,
      ascent: m.ascent,
      descent: m.descent,
      start,
      end,
      hardBreak: line.hard,
    });
    const lineBox: Rect = [placed.x0, y - m.ascent, placed.x1, y - m.descent];
    box = box === null ? lineBox : union(box, lineBox);
  });

  return {
    summary: {
      lines: placedLines,
      glyphs,
      contentBox: box ?? [area[0], area[1], area[0], area[1]],
      area,
      overflow,
      reflowMs: now() - t0,
    },
    lines: writable,
  };
}

function validate(input: ReflowInput): void {
  const { text, segments } = input;
  let pos = 0;
  for (const sg of segments) {
    if (sg.start !== pos || sg.end < sg.start) {
      throw new Error(
        `reflow: segments 가 텍스트를 빈틈 없이 덮지 않는다(위치 ${pos}, 구간 [${sg.start}, ${sg.end}))`,
      );
    }
    if (!(sg.size > 0) || !Number.isFinite(sg.size)) {
      throw new Error(
        `reflow: 글자 크기가 양수가 아니다(구간 [${sg.start}, ${sg.end}), size ${sg.size})`,
      );
    }
    pos = sg.end;
  }
  if (pos !== text.length) {
    throw new Error(`reflow: segments 가 텍스트 끝(${text.length})까지 덮지 않는다(끝 ${pos})`);
  }
}

/** 클러스터(확장 자소, 구간 경계에서도 나눔)를 만들고, 같은 폰트가 이어지는 구간을 한 번에 셰이핑한다. */
function buildItems(text: string, segments: readonly FontSegment[]): Item[] {
  const items: Item[] = [];
  for (const seg of segments) {
    for (const [start, end] of graphemeRanges(text, seg.start, seg.end)) {
      const cc = classifyCluster(text.slice(start, end));
      const kind: ItemKind = cc.cls === 'BK' ? 'break' : seg.face === null ? 'missing' : 'glyph';
      items.push({ start, end, seg, kind, face: seg.face, glyphs: [], adv: 0, kernAfter: 0, cc });
    }
  }
  let i = 0;
  while (i < items.length) {
    const first = items[i];
    if (first === undefined || first.kind !== 'glyph' || first.face === null) {
      i++;
      continue;
    }
    const face = first.face;
    let j = i + 1;
    while (j < items.length && items[j]?.kind === 'glyph' && items[j]?.face?.key === face.key) j++;
    const unit = items.slice(i, j);
    const shaped = shaperFor(face).shape(
      text,
      unit.map((it) => [it.start, it.end] as const),
    );
    unit.forEach((it, k) => {
      const r = shaped[k] ?? null;
      if (r === null) {
        it.kind = 'missing';
        return;
      }
      const em = it.seg.size / 1000;
      it.glyphs = r.glyphs;
      it.adv = r.advance * em;
      it.kernAfter = r.kernAfter * em;
    });
    i = j;
  }
  return items;
}

/**
 * 탐욕 줄 나눔. 공백은 폭 판정에 넣지 않고(줄 끝에 매달림), 줄 끝 클러스터의 다음 커닝은 뺀다. 넘치면 줄 안의 마지막 일반
 * 나눔 기회에서 나누고, 없으면(어절·단어가 줄 폭보다 김) 비상 나눔(음절·글자 단위)을 한다. 줄에는 최소 한 클러스터가 들어간다.
 * 공백은 넘침 판정 전에 줄에 들어가고 나눔 위치는 공백·강제 줄바꿈 앞이 될 수 없으므로, 줄 끝 공백과 그 뒤 강제 줄바꿈은
 * 항상 그 줄에 붙는다(빈 줄을 따로 만들지 않는다).
 */
function breakLines(
  items: readonly Item[],
  normal: readonly boolean[],
  preferred: readonly boolean[],
  lineWidth: (idx: number) => number,
): LineRange[] {
  const lines: LineRange[] = [];
  const n = items.length;
  let i = 0;
  while (i < n) {
    const a = i;
    const width = lineWidth(lines.length) + FIT_EPSILON;
    let pen = 0;
    let lastBreak = -1;
    let end = -1;
    let hard = false;
    for (let j = a; j < n; j++) {
      const it = items[j];
      if (it === undefined) break;
      if (it.kind === 'break') {
        end = j + 1;
        hard = true;
        break;
      }
      if (it.cc.cls !== 'SP') {
        if (j > a && normal[j]) lastBreak = j;
        if (j > a && pen + (it.adv - it.kernAfter) > width) {
          end = lastBreak > a ? lastBreak : emergencyBreak(items, preferred, a, j);
          break;
        }
      }
      pen += it.adv;
    }
    if (end < 0) end = n;
    lines.push({ a, b: end, hard });
    i = end;
  }
  const last = items[n - 1];
  if (n === 0 || last?.kind === 'break') lines.push({ a: n, b: n, hard: false });
  return lines;
}

/** 비상 나눔 위치 k(a < k ≤ j, k 앞에서 나눔). 공백 앞은 안 되고, 금칙을 지키는 가장 뒤 위치를 우선한다. */
function emergencyBreak(
  items: readonly Item[],
  preferred: readonly boolean[],
  a: number,
  j: number,
): number {
  for (let k = j; k > a; k--) {
    if (items[k]?.cc.cls !== 'SP' && preferred[k]) return k;
  }
  return j;
}

interface PlacedLineGlyphs {
  glyphs: PlacedGlyph[];
  writable: WritableGlyph[];
  x0: number;
  x1: number;
}

/** 한 줄의 정렬·좌표. justify 는 마지막 줄·강제 줄바꿈 앞 줄을 빼고 줄 안 공백에, 공백이 없으면 클러스터 사이에 나눈다. */
function placeLine(
  items: readonly Item[],
  line: LineRange,
  left: number,
  width: number,
  align: string,
  isLast: boolean,
  y: number,
): PlacedLineGlyphs {
  const { a, b } = line;
  let contentEnd = b;
  while (contentEnd > a) {
    const cls = items[contentEnd - 1]?.cc.cls;
    if (cls !== 'SP' && cls !== 'BK') break;
    contentEnd--;
  }
  const advs: number[] = [];
  let natural = 0;
  for (let i = a; i < b; i++) {
    const it = items[i];
    let adv = it === undefined || it.kind !== 'glyph' ? 0 : it.adv;
    if (it !== undefined && i === contentEnd - 1 && it.kind === 'glyph') adv -= it.kernAfter;
    advs.push(adv);
    if (i < contentEnd) natural += adv;
  }
  const free = width - natural;
  const extra = new Array<number>(b - a).fill(0);
  let offset = 0;
  if (align === 'right') offset = Math.max(0, free);
  else if (align === 'center') offset = Math.max(0, free / 2);
  else if (align === 'justify' && !line.hard && !isLast && free > 0) {
    let firstContent = a;
    while (firstContent < contentEnd && items[firstContent]?.cc.cls === 'SP') firstContent++;
    const spaces: number[] = [];
    for (let i = firstContent + 1; i < contentEnd; i++) {
      if (items[i]?.cc.cls === 'SP' && items[i]?.kind === 'glyph') spaces.push(i);
    }
    if (spaces.length > 0) {
      for (const i of spaces) extra[i - a] = free / spaces.length;
    } else {
      // 공백 없는 줄: 이웃한 두 클러스터가 모두 CJK·한글일 때만 그 사이에 나눈다. 라틴 단어 하나뿐인 줄을 글자
      // 사이로 벌리면 추출기가 글자마다 공백을 넣어 복사·검색이 깨진다(M3 코퍼스 측정 2026-10-20). 나눌 곳이 없으면 왼쪽.
      const visible: number[] = [];
      for (let i = a; i < contentEnd; i++) if (items[i]?.kind === 'glyph') visible.push(i);
      const gaps: number[] = [];
      for (let k = 0; k < visible.length - 1; k++) {
        const i = visible[k] ?? a;
        const j = visible[k + 1] ?? a;
        if (items[i]?.cc.wide && items[j]?.cc.wide) gaps.push(i);
      }
      for (const i of gaps) extra[i - a] = free / gaps.length;
    }
  }

  const glyphs: PlacedGlyph[] = [];
  const writable: WritableGlyph[] = [];
  const x0 = left + offset;
  let pen = x0;
  let x1 = x0;
  for (let i = a; i < b; i++) {
    const it = items[i];
    if (it === undefined || it.kind === 'break') continue;
    const size = it.seg.size;
    if (it.kind === 'missing' || it.face === null) {
      glyphs.push({
        offset: it.start,
        length: it.end - it.start,
        font: { kind: 'missing' },
        x: pen,
        y,
        advance: 0,
        size,
      });
    } else {
      const face = it.face;
      const advance = (advs[i - a] ?? 0) + (extra[i - a] ?? 0);
      glyphs.push({
        offset: it.start,
        length: it.end - it.start,
        font:
          face.kind === 'original'
            ? { kind: 'original', fontId: face.fontId ?? -1 }
            : { kind: 'fallback' },
        x: pen,
        y,
        advance,
        size,
      });
      const em = size / 1000;
      let gx = pen;
      for (const g of it.glyphs) {
        writable.push({
          offset: it.start,
          length: it.end - it.start,
          faceKey: face.key,
          code: g.code,
          gid: g.gid,
          x: gx + g.xOffset * em,
          y,
          size,
          pdfWidth: g.pdfWidth,
          syntheticBold: it.seg.syntheticBold,
          syntheticItalic: it.seg.syntheticItalic,
          runIndex: it.seg.runIndex,
        });
        gx += g.advance * em;
      }
      pen += advance;
    }
    if (i === contentEnd - 1) x1 = pen;
  }
  return { glyphs, writable, x0, x1 };
}

/**
 * 줄의 글리프 클러스터에서 가장 큰 올림·가장 깊은 내림(pt, 내림 음수). 글리프가 없으면 null.
 * 공백 클러스터는 공백만 있는 줄에서만 센다: 원본 폰트에 공백 글리프가 없어 폴백으로 간 공백(TeX 폰트 등)이
 * 폴백 폰트 높이로 줄 상자를 키우지 않게 한다.
 */
function lineMetrics(items: readonly Item[], line: LineRange): Metrics | null {
  return metricsOver(items, line, false) ?? metricsOver(items, line, true);
}

function metricsOver(items: readonly Item[], line: LineRange, spaces: boolean): Metrics | null {
  let m: Metrics | null = null;
  for (let i = line.a; i < line.b; i++) {
    const it = items[i];
    if (it === undefined || it.kind !== 'glyph' || it.face === null) continue;
    if ((it.cc.cls === 'SP') !== spaces) continue;
    const fm = faceMetrics(it.face, it.seg.size);
    m =
      m === null
        ? fm
        : { ascent: Math.max(m.ascent, fm.ascent), descent: Math.min(m.descent, fm.descent) };
  }
  return m;
}

function faceMetrics(face: FontFace | null, size: number): Metrics {
  const ok = face !== null && face.ascent > face.descent;
  return {
    ascent: ((ok ? face.ascent : DEFAULT_ASCENT) / 1000) * size,
    descent: ((ok ? face.descent : DEFAULT_DESCENT) / 1000) * size,
  };
}

/** 글리프가 없는 줄(빈 텍스트·빈 줄)의 캐럿 높이: 그 위치의 구간(길이 0 구간 우선) 폰트·크기. */
function caretMetrics(
  text: string,
  segments: readonly FontSegment[],
  firstFace: FontFace | null,
  offset: number,
  lineHeight: number,
): Metrics {
  let seg: FontSegment | undefined;
  for (const sg of segments) if (sg.start === offset && sg.end === offset) seg = sg;
  seg ??= segments.find((sg) => sg.start <= offset && offset < sg.end);
  if (seg === undefined && offset === text.length)
    seg = segments.findLast((sg) => sg.end === offset);
  seg ??= segments[0];
  const size = seg?.size ?? lineHeight / 1.2;
  return faceMetrics(seg?.face ?? firstFace, size);
}

/** 줄의 시작 텍스트 위치(빈 줄은 앞 줄 끝). */
function offsetOf(items: readonly Item[], line: LineRange, text: string): number {
  if (line.a < line.b) return items[line.a]?.start ?? 0;
  return line.a > 0 ? (items[line.a - 1]?.end ?? text.length) : 0;
}

function intersect(r: Rect, limit: Rect): Rect {
  const x0 = Math.max(r[0], limit[0]);
  const y0 = Math.max(r[1], limit[1]);
  return [x0, y0, Math.max(x0, Math.min(r[2], limit[2])), Math.max(y0, Math.min(r[3], limit[3]))];
}

function union(p: Rect, q: Rect): Rect {
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])];
}
