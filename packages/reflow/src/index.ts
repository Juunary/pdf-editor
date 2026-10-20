/**
 * 문단 리플로우(M3, docs/m3-contract.md 5.4·D5). 텍스트 셰이핑과 줄·글리프 배치만 하고 PDF 직렬화는 하지 않는다
 * (PLAN.md 4절). MuPDF·DOM 에 의존하지 않는다. 폰트 배정(원본/폴백)은 pdf-ops FontManager 가 정해 넘긴다.
 */
import type { ParagraphFormat, Rect, ReflowSummary } from '@pdf-editor/shared-types';
import { layout, OVERFLOW_TOLERANCE } from './layout.js';

export { KINSOKU_HEAD, KINSOKU_TAIL } from './text.js';
export { OPENTYPE_FEATURES_OFF } from './opentype.js';

/** 원본 폰트에서 한 클러스터를 쓰는 글리프(들). 단위 1/1000 em. */
export interface EncodedGlyph {
  /** 쓰기용 문자 코드 바이트(폰트 인코딩·CMap 기준). */
  code: Uint8Array;
  gid: number;
  /** PDF 명세 폭(/Widths·/W, 실수). */
  width: number;
}

/**
 * 폰트 원천. pdf-widths: 원본 폰트, PDF 폭으로 배치하고 커닝 없음.
 * opentype: 폴백 폰트, harfbuzz 로 kern 만 켜고 셰이핑한다(계약 D5). 출력 gid 가 cmap 역상에 없으면 그 클러스터는
 * cmap gid + hmtx 폭으로 대신한다(모든 gid 가 ToUnicode 를 가진다). pdfWidth(MuPDF addFont 가 쓴 /W)와의 차이는 쓰기에서
 * TJ 로 보정한다.
 */
export type FaceSource =
  | {
      kind: 'pdf-widths';
      /** 클러스터를 이 폰트로 쓸 글리프. 쓸 수 없으면 null(FontManager 가 미리 걸러야 한다). */
      encode(cluster: string): EncodedGlyph[] | null;
    }
  | {
      kind: 'opentype';
      bytes: Uint8Array;
      /** gid 의 PDF 폭(/W, 1/1000 em). */
      pdfWidth(gid: number): number;
    };

export interface FontFace {
  /** 같은 폰트면 같은 키(셰이퍼 캐시·쓰기 리소스 묶음). */
  key: string;
  kind: 'original' | 'fallback';
  /** 원본 폰트면 PageModel FontInfo.id, 폴백이면 null. */
  fontId: number | null;
  /** 1/1000 em, 위 양수·아래 음수. */
  ascent: number;
  descent: number;
  source: FaceSource;
}

/** 폰트가 정해진 텍스트 구간 [start, end). runIndex 는 TextRun 인덱스. */
export interface FontSegment {
  start: number;
  end: number;
  face: FontFace | null;
  /** 글자 크기(pt). */
  size: number;
  runIndex: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  /** 글리프마다 더하는 자간(pt, RunStyle.charSpacing). 없으면 0. 줄 끝 글리프 뒤 자간은 줄 폭에 넣지 않는다. */
  charSpacing?: number;
}

export interface ReflowInput {
  /** TextRun.text 를 이은 문자열(NFC). 강제 줄바꿈 "\n". */
  text: string;
  /** text 를 빈틈 없이 덮는다. face 가 null 이면 원본·폴백 모두 글리프가 없는 구간(glyph-missing, 쓰지 않음). */
  segments: FontSegment[];
  format: ParagraphFormat;
  /** 영역 상한(A7-4). */
  areaLimit: Rect;
}

/** 쓰기용 글리프. 위치는 페이지 공간 기준선 원점(쓰기가 TJ 조정을 위치 차이로 계산한다). */
export interface WritableGlyph {
  offset: number;
  length: number;
  faceKey: string;
  code: Uint8Array;
  gid: number;
  x: number;
  y: number;
  /** 글자 크기(pt). */
  size: number;
  /** PDF 폭(1/1000 em). 뷰어가 이 값으로 다음 글리프를 놓는다. */
  pdfWidth: number;
  syntheticBold: boolean;
  syntheticItalic: boolean;
  runIndex: number;
}

export interface ReflowResult {
  summary: ReflowSummary;
  /** 줄 순서, 줄 안은 왼쪽 → 오른쪽. 줄 끝 공백 글리프를 포함한다(추출 시 단어 분리, 계약 5.4). glyph-missing 은 없다. */
  lines: WritableGlyph[][];
}

/** 같은 입력이면 같은 결과(계약 5.4 결정성, summary.reflowMs 제외). 규칙은 docs/m3-reflow.md. */
export function layoutParagraph(input: ReflowInput): ReflowResult {
  return layout(input);
}

/**
 * 배치 상자가 영역 상한 밖으로 나가 잘리는지(상한에 막힌 초과의 overflow-clipped 경고 판단, 계약 5.4). 여유는 초과 판정과 같은 0.5pt.
 */
export function isOverflowClipped(summary: ReflowSummary, areaLimit: Rect): boolean {
  const [x0, y0, x1, y1] = summary.contentBox;
  const t = OVERFLOW_TOLERANCE;
  return (
    x0 < areaLimit[0] - t || y0 < areaLimit[1] - t || x1 > areaLimit[2] + t || y1 > areaLimit[3] + t
  );
}
