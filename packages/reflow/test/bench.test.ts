/**
 * Layout time (500-character paragraph). The result is left on the console and recorded in docs/m3-reflow.md section 4. The pass/fail criteria are kept loose (they fluctuate with load).
 */
import { describe, expect, it } from 'vitest';
import { now } from '../src/clock.js';
import { layoutParagraph, type FontFace, type ReflowInput } from '../src/index.js';
import { format, notoBytes, pdfFace, seg } from './helpers.js';

const SENTENCE =
  '편집기는 PDF 문단을 영역 안에서 다시 배치한다. The quick brown fox jumps over the lazy dog. ' +
  '漢字와 숫자 2026-10-19, “따옴표”(괄호)도 섞는다. ';
const TEXT = SENTENCE.repeat(10).slice(0, 500);

function fallback(key: string): FontFace {
  return {
    key,
    kind: 'fallback',
    fontId: null,
    ascent: 1160,
    descent: -288,
    source: { kind: 'opentype', bytes: notoBytes(), pdfWidth: () => 1000 },
  };
}

function make(face: FontFace, height: number): ReflowInput {
  return {
    text: TEXT,
    segments: [seg(face, 0, TEXT.length)],
    format: format({
      area: [50, 50, 350, 50 + height],
      align: 'justify',
      lineHeight: 14,
    }),
    areaLimit: [0, 0, 612, 792],
  };
}

function measure(inp: ReflowInput, runs = 200): { median: number; p95: number; max: number } {
  for (let i = 0; i < 20; i++) layoutParagraph(inp);
  const ms: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    layoutParagraph(inp);
    ms.push(now() - t0);
  }
  ms.sort((a, b) => a - b);
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), max: ms[ms.length - 1] ?? 0 };
}

const fmt = (r: { median: number; p95: number; max: number }) =>
  `median ${r.median.toFixed(3)} ms, p95 ${r.p95.toFixed(3)} ms, max ${r.max.toFixed(3)} ms`;

describe('layout time (500-character paragraph)', () => {
  it('original font (pdf-widths), fallback font (harfbuzz), auto-extend', () => {
    expect(TEXT.length).toBe(500);
    // First call: reads the 4 MB fallback font with harfbuzz and fills the cmap lookups.
    const t0 = now();
    const first = layoutParagraph(make(fallback('bench-cold'), 1000));
    const coldMs = now() - t0;

    const orig = measure(make(pdfFace(), 1000));
    const fb = measure(make(fallback('bench'), 1000));
    // 500 characters in height 20pt: overflows, so the bottom edge is lowered automatically.
    const expandInput = make(fallback('bench'), 20);
    const expand = measure(expandInput, 50);
    const expandResult = layoutParagraph(expandInput);

    console.log(
      [
        `[reflow bench] 500자, 줄 수 ${first.summary.lines.length}, 클러스터 ${first.summary.glyphs.length}`,
        `  폴백 첫 호출(폰트 적재 포함): ${coldMs.toFixed(1)} ms`,
        `  원본 폰트(pdf-widths): ${fmt(orig)}`,
        `  폴백 폰트(harfbuzz): ${fmt(fb)}`,
        `  폴백 + 자동 확장: ${fmt(expand)} (영역 아래 ${expandResult.summary.area[3].toFixed(1)})`,
      ].join('\n'),
    );
    expect(expandResult.summary.overflow).toBe(false);
    expect(expandResult.summary.area[3]).toBeGreaterThan(70);
    expect(fb.median).toBeLessThan(50);
    expect(expand.median).toBeLessThan(50);
  });
});
