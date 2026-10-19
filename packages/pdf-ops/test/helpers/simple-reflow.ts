/**
 * 테스트 전용 단순 배치(reflow 패키지 구현 전 ReflowResult 를 직접 만든다). 왼쪽 정렬, 공백 뒤 줄 나눔,
 * 폭은 원본 폰트 명세 폭·폴백 /W 그대로(셰이핑 없음). 계약 5.4 의 일부만 따른다.
 */
import * as mupdf from 'mupdf';
import type { ParagraphFormat, PlacedGlyph, PlacedLine, Rect } from '@pdf-editor/shared-types';
import type { FontSegment, ReflowResult, WritableGlyph } from '@pdf-editor/reflow';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const fontCache = new WeakMap<Uint8Array, mupdf.Font>();

function gidOf(bytes: Uint8Array, cluster: string): number {
  let f = fontCache.get(bytes);
  if (!f) {
    f = new mupdf.Font('fallback', bytes);
    fontCache.set(bytes, f);
  }
  return f.encodeCharacter(cluster.codePointAt(0)!);
}

interface Item {
  offset: number;
  length: number;
  text: string;
  seg: FontSegment;
  glyphs: { code: Uint8Array; gid: number; width: number }[];
  advance: number;
}

export function simpleReflow(
  text: string,
  segments: readonly FontSegment[],
  format: ParagraphFormat,
  options: { scale?: number } = {},
): ReflowResult {
  const s = options.scale ?? 1;
  const items: Item[] = [];
  const placed: PlacedGlyph[] = [];
  for (const seg of segments) {
    const sub = text.slice(seg.start, seg.end);
    for (const c of segmenter.segment(sub)) {
      const offset = seg.start + c.index;
      const size = seg.size * s;
      if (!seg.face) {
        placed.push({
          offset,
          length: c.segment.length,
          font: { kind: 'missing' },
          x: 0,
          y: 0,
          advance: 0,
          size,
        });
        continue;
      }
      let glyphs: Item['glyphs'];
      if (c.segment === '\n') glyphs = [];
      else if (seg.face.source.kind === 'pdf-widths') {
        glyphs = (seg.face.source.encode(c.segment) ?? []).map((g) => ({ ...g }));
      } else {
        const gid = gidOf(seg.face.source.bytes, c.segment);
        glyphs = [
          {
            code: Uint8Array.of(gid >> 8, gid & 0xff),
            gid,
            width: seg.face.source.pdfWidth(gid),
          },
        ];
      }
      const advance = glyphs.reduce((w, g) => w + (g.width / 1000) * size, 0);
      items.push({ offset, length: c.segment.length, text: c.segment, seg, glyphs, advance });
    }
  }
  const area = format.area;
  const width = area[2] - area[0];
  const lines: Item[][] = [[]];
  let x = format.firstLineIndent > 0 ? format.firstLineIndent : 0;
  // 단어(공백까지) 단위로 넣는다.
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.text === '\n') {
      lines.at(-1)!.push(it);
      lines.push([]);
      x = 0;
      i++;
      continue;
    }
    let j = i;
    let w = 0;
    while (j < items.length && items[j]!.text !== '\n' && !/\s/u.test(items[j]!.text)) {
      w += items[j]!.advance;
      j++;
    }
    if (x > 0 && x + w > width + 0.01) {
      lines.push([]);
      x = 0;
    }
    for (let k = i; k < j; k++) lines.at(-1)!.push(items[k]!);
    x += w;
    if (j < items.length && /\s/u.test(items[j]!.text) && items[j]!.text !== '\n') {
      lines.at(-1)!.push(items[j]!);
      x += items[j]!.advance;
      j++;
    }
    i = j;
  }
  const out: WritableGlyph[][] = [];
  const placedLines: PlacedLine[] = [];
  let box: Rect | null = null;
  lines.forEach((line, li) => {
    const baseline = area[1] + format.firstBaselineOffset * s + li * format.lineHeight * s;
    let px = area[0] + (li === 0 ? Math.max(0, format.firstLineIndent) : 0);
    const start = line[0]?.offset ?? (out.length > 0 ? text.length : 0);
    const wg: WritableGlyph[] = [];
    let x1 = px;
    let maxSize = 0;
    for (const it of line) {
      const size = it.seg.size * s;
      maxSize = Math.max(maxSize, size);
      placed.push({
        offset: it.offset,
        length: it.length,
        font:
          it.seg.face!.kind === 'fallback'
            ? { kind: 'fallback' }
            : { kind: 'original', fontId: it.seg.face!.fontId ?? 0 },
        x: px,
        y: baseline,
        advance: it.advance,
        size,
      });
      for (const g of it.glyphs) {
        wg.push({
          offset: it.offset,
          length: it.length,
          faceKey: it.seg.face!.key,
          code: g.code,
          gid: g.gid,
          x: px,
          y: baseline,
          size,
          pdfWidth: g.width,
          syntheticBold: it.seg.syntheticBold,
          syntheticItalic: it.seg.syntheticItalic,
          runIndex: it.seg.runIndex,
        });
        px += (g.width / 1000) * size;
      }
      if (!/\s/u.test(it.text)) x1 = px;
    }
    out.push(wg);
    const end = line.length > 0 ? line.at(-1)!.offset + line.at(-1)!.length : start;
    placedLines.push({
      baseline,
      x0: area[0],
      x1,
      ascent: maxSize * 0.8,
      descent: maxSize * 0.2,
      start,
      end,
      hardBreak: line.at(-1)?.text === '\n',
    });
    const r: Rect = [
      area[0],
      baseline - maxSize * 0.8,
      Math.max(x1, area[0]),
      baseline + maxSize * 0.2,
    ];
    box = box
      ? [
          Math.min(box[0], r[0]),
          Math.min(box[1], r[1]),
          Math.max(box[2], r[2]),
          Math.max(box[3], r[3]),
        ]
      : r;
  });
  return {
    summary: {
      lines: placedLines,
      glyphs: placed.sort((a, b) => a.offset - b.offset),
      contentBox: box ?? [area[0], area[1], area[0], area[1]],
      area,
      overflow: false,
      fontScale: s,
      reflowMs: 0,
    },
    lines: out,
  };
}
