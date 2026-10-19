/**
 * 문단 객체 만들기(계약 2.2–2.4): 텍스트, 상자, 줄 간격, 들여쓰기, 정렬, 모양 구간.
 */
import type { LayoutParagraph, PageModel, RGB, Rect, StyleRun } from '@pdf-editor/shared-types';
import { median } from './geom.js';
import type { Unit } from './units.js';

export type ParagraphBody = Omit<
  LayoutParagraph,
  'id' | 'role' | 'column' | 'table' | 'figure' | 'continuesTo'
>;

const round2 = (v: number): number => Math.round(v * 100) / 100;

function styleRuns(model: PageModel, chars: readonly number[]): StyleRun[] {
  const runs: (StyleRun & { key: string })[] = [];
  let cur: (StyleRun & { key: string }) | null = null;
  chars.forEach((ci, pos) => {
    const c = model.chars[ci]!;
    if (c.text.trim() === '' && cur) {
      cur.end = pos + 1;
      return;
    }
    const font = model.fonts[c.fontId];
    const size = Math.round(c.size * 10) / 10;
    const color: RGB | null = c.color ? [c.color[0], c.color[1], c.color[2]] : null;
    const key = `${c.fontId}|${size}|${color ? color.map((v) => Math.round(v * 255)).join(',') : '-'}`;
    if (cur && cur.key === key) {
      cur.end = pos + 1;
      return;
    }
    cur = {
      key,
      start: pos,
      end: pos + 1,
      fontId: c.fontId,
      size,
      bold: font?.bold ?? false,
      italic: font?.italic ?? false,
      color,
    };
    runs.push(cur);
  });
  return runs.map(({ key: _key, ...r }) => r);
}

function alignOf(units: readonly Unit[], indent: number): LayoutParagraph['align'] {
  if (units.length < 2) return 'unknown';
  const size = median(units.map((u) => u.size));
  const tol = 0.5 * size;
  const body = units.length >= 3 ? units.slice(0, -1) : units.slice();
  const forLeft = Math.abs(indent) > tol && body.length > 1 ? body.slice(1) : body;
  const spread = (xs: number[]): number => Math.max(...xs) - Math.min(...xs);
  const sl = spread(forLeft.map((u) => u.bbox[0]));
  const sr = spread(body.map((u) => u.bbox[2]));
  const sc = spread(units.map((u) => (u.bbox[0] + u.bbox[2]) / 2));
  if (sl <= tol && sr <= tol && units.length >= 3) return 'justify';
  if (sl <= tol) return 'left';
  if (sr <= tol && spread(units.map((u) => u.bbox[2])) <= tol) return 'right';
  if (sc <= tol) return 'center';
  return 'unknown';
}

export function buildParagraph(model: PageModel, units: readonly Unit[]): ParagraphBody {
  const lines: number[] = [];
  const chars: number[] = [];
  let text = '';
  let bbox: Rect | null = null;
  for (const u of units) {
    const t = u.text;
    if (text && t) text += /[-‐]$/u.test(text) ? '' : ' ';
    text += t;
    for (const p of u.parts) {
      lines.push(p.index);
      chars.push(...p.chars);
    }
    bbox = bbox
      ? [
          Math.min(bbox[0], u.full[0]),
          Math.min(bbox[1], u.full[1]),
          Math.max(bbox[2], u.full[2]),
          Math.max(bbox[3], u.full[3]),
        ]
      : u.full;
  }
  const pitches: number[] = [];
  for (let i = 1; i < units.length; i++) pitches.push(units[i]!.baseline - units[i - 1]!.baseline);
  const firstLineIndent =
    units.length > 1 ? round2(units[0]!.bbox[0] - median(units.slice(1).map((u) => u.bbox[0]))) : 0;
  return {
    // 추출 캐시(PageModel)와 배열을 공유하지 않도록 복사한다.
    bbox: bbox ? [bbox[0], bbox[1], bbox[2], bbox[3]] : [0, 0, 0, 0],
    lines,
    chars,
    text,
    lineHeight: pitches.length ? round2(median(pitches)) : null,
    firstLineIndent,
    align: alignOf(units, firstLineIndent),
    styleRuns: styleRuns(model, chars),
  };
}
