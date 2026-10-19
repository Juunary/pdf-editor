import { readFileSync } from 'node:fs';
import type { ParagraphFormat, Rect } from '@pdf-editor/shared-types';
import type {
  EncodedGlyph,
  FontFace,
  FontSegment,
  ReflowInput,
  ReflowResult,
} from '../src/index.js';

/** 시험용 원본 폰트 폭(1/1000 em): 공백 250, U+1100 이상(한글·CJK) 1000, 그 밖 500. null 이면 글리프 없음. */
export function defaultWidth(ch: string): number | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === ' ') return 250;
  return cp >= 0x1100 ? 1000 : 500;
}

/** 원본 폰트(pdf-widths). 클러스터의 코드 포인트마다 글리프 하나. */
export function pdfFace(
  key = 'orig',
  width: (ch: string) => number | null = defaultWidth,
  calls?: string[],
): FontFace {
  return {
    key,
    kind: 'original',
    fontId: 7,
    ascent: 800,
    descent: -200,
    source: {
      kind: 'pdf-widths',
      encode(cluster: string): EncodedGlyph[] | null {
        calls?.push(cluster);
        const out: EncodedGlyph[] = [];
        for (const ch of cluster) {
          const w = width(ch);
          if (w === null) return null;
          const cp = ch.codePointAt(0) ?? 0;
          out.push({ code: Uint8Array.of(cp & 0xff), gid: cp, width: w });
        }
        return out;
      },
    },
  };
}

export const FONT_PATH = new URL(
  '../../../assets/fonts/NotoSansKR-Regular-subset.ttf',
  import.meta.url,
);

let fontBytes: Uint8Array | null = null;
export function notoBytes(): Uint8Array {
  fontBytes ??= new Uint8Array(readFileSync(FONT_PATH));
  return fontBytes;
}

/** 폴백 폰트(opentype). pdfWidth 는 기본으로 hmtx 와 같다고 둔다(V6 에서 /W 와 같음을 확인). */
export function notoFace(pdfWidth?: (gid: number) => number): FontFace {
  return {
    key: 'fallback',
    kind: 'fallback',
    fontId: null,
    ascent: 1160,
    descent: -288,
    source: { kind: 'opentype', bytes: notoBytes(), pdfWidth: pdfWidth ?? (() => 0) },
  };
}

export function seg(
  face: FontFace | null,
  start: number,
  end: number,
  extra: Partial<Omit<FontSegment, 'face' | 'start' | 'end'>> = {},
): FontSegment {
  return {
    start,
    end,
    face,
    size: 10,
    runIndex: 0,
    syntheticBold: false,
    syntheticItalic: false,
    ...extra,
  };
}

export function format(over: Partial<ParagraphFormat> = {}): ParagraphFormat {
  return {
    area: [0, 0, 100, 1000],
    align: 'left',
    firstLineIndent: 0,
    lineHeight: 12,
    firstBaselineOffset: 8,
    overflow: null,
    ...over,
  };
}

/** text 전체를 한 구간(face, 크기 10)으로 덮는 입력. */
export function input(
  text: string,
  fmt: Partial<ParagraphFormat> = {},
  face: FontFace = pdfFace(),
  areaLimit: Rect = [0, 0, 1000, 1000],
): ReflowInput {
  return {
    text,
    segments: text.length === 0 ? [] : [seg(face, 0, text.length)],
    format: format(fmt),
    areaLimit,
  };
}

/** 줄별 텍스트 [start, end). */
export function lineTexts(r: ReflowResult, text: string): string[] {
  return r.summary.lines.map((l) => text.slice(l.start, l.end));
}

/** reflowMs 를 뺀 결과(결정성 비교용). */
export function stable(r: ReflowResult): unknown {
  const summary = { ...r.summary, reflowMs: 0 };
  return { summary, lines: r.lines.map((l) => l.map((g) => ({ ...g, code: [...g.code] }))) };
}
