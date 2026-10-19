/**
 * 배치 시간(500자 문단). 결과는 콘솔에 남기고 docs/m3-reflow.md 4절에 기록한다. 판정 기준은 느슨하게 둔다(부하에 흔들림).
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

function make(face: FontFace, overflow: 'shrink' | null, height: number): ReflowInput {
  return {
    text: TEXT,
    segments: [seg(face, 0, TEXT.length)],
    format: format({
      area: [50, 50, 350, 50 + height],
      align: 'justify',
      lineHeight: 14,
      overflow,
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

describe('배치 시간(500자 문단)', () => {
  it('원본 폰트(pdf-widths)·폴백 폰트(harfbuzz)·shrink 최악', () => {
    expect(TEXT.length).toBe(500);
    // 첫 호출: 4 MB 폴백 폰트를 harfbuzz 로 읽고 cmap 조회를 채운다.
    const t0 = now();
    const first = layoutParagraph(make(fallback('bench-cold'), null, 1000));
    const coldMs = now() - t0;

    const orig = measure(make(pdfFace(), null, 1000));
    const fb = measure(make(fallback('bench'), null, 1000));
    // 높이 20pt 에 500자: 1.00 → 0.80 의 21개 배율을 모두 시도한다.
    const shrinkInput = make(fallback('bench'), 'shrink', 20);
    const shrink = measure(shrinkInput, 50);
    const shrinkResult = layoutParagraph(shrinkInput);

    console.log(
      [
        `[reflow bench] 500자, 줄 수 ${first.summary.lines.length}, 클러스터 ${first.summary.glyphs.length}`,
        `  폴백 첫 호출(폰트 적재 포함): ${coldMs.toFixed(1)} ms`,
        `  원본 폰트(pdf-widths): ${fmt(orig)}`,
        `  폴백 폰트(harfbuzz): ${fmt(fb)}`,
        `  폴백 + shrink 21배율: ${fmt(shrink)} (fontScale ${shrinkResult.summary.fontScale})`,
      ].join('\n'),
    );
    expect(shrinkResult.summary).toMatchObject({ fontScale: 0.8, overflow: true });
    expect(fb.median).toBeLessThan(50);
    expect(shrink.median).toBeLessThan(200);
  });
});
