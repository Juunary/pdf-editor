/**
 * 추출 모델(PLAN.md 3.4 "어디에 무엇이 그려져 있는가"). core 가 만든다.
 *
 * 순서 번호(seq) 규칙 — SourceMap 매칭 키(docs/m1-contract.md 3절):
 * - `runPageContents`(주석 제외)를 항등 행렬로 실행할 때 Device 콜백이 오는 순서로 센다.
 * - glyphSeq: 표시 글리프마다 1. 처음 Device 에 도착한 텍스트 콜백(fillText·strokeText·clipText·
 *   clipStrokeText·ignoreText)에서 센다. fill→stroke(Tr 2·6, 포인터 동일 연속)는 1회, Tr 4–7 클립의
 *   ET 재전송은 세지 않는다. gid -1 보조 글리프(ToUnicode 1코드→여러 코드포인트)는 세지 않고 직전
 *   글리프의 text 에 붙인다. 재전송 판정 키는 (폰트, gid, trm, ctm) 비트 동일. 판정 규칙: docs/m1-contract.md 3.1.
 * - paintSeq: 텍스트 외 그리기 콜백(fillPath·strokePath·clipPath·clipStrokePath·fillShade·
 *   fillImage·fillImageMask·clipImageMask)마다 1씩. 채움+선(B 등)은 콜백 2개 = 번호 2개다.
 *   Form `Do` 의 BBox clipPath 도 1. beginMask~endMask 사이 콜백은 세지 않는다(계약 3절 세부 표).
 */
import type { Matrix, Point, Quad, RGB, Rect } from './geometry.js';

export interface FontInfo {
  /** PageModel.fonts 인덱스. */
  id: number;
  /** MuPDF `Font.getName()`(서브셋 태그 포함, 예: "ABCDEF+NotoSansKR"). */
  name: string;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

/** 텍스트 렌더 방식. 클립 여부는 CharInfo.clip 으로 따로 둔다. */
export type TextRender = 'fill' | 'stroke' | 'fill-stroke' | 'invisible';

export interface CharInfo {
  /** 콘텐츠 실행 순서의 글리프 번호(0부터, 위 규칙). SourceMap 매칭 키. */
  glyphSeq: number;
  /**
   * 유니코드. 합자·ToUnicode 다중 매핑은 여러 코드포인트(gid -1 보조 글리프를 붙인 결과)일 수 있다.
   * 매핑이 없으면 U+FFFD.
   */
  text: string;
  /** 폰트 글리프 ID(Device showGlyph). gid -1 보조 글리프는 별도 CharInfo 가 되지 않는다. */
  gid: number;
  /** PageModel.fonts 인덱스. */
  fontId: number;
  /** 페이지 공간 글자 크기(pt). */
  size: number;
  /** 기준선 원점, 페이지 공간. */
  origin: Point;
  /**
   * 글자 사각형, 페이지 공간. 구조화 텍스트 값이며, 없으면 core 가 폰트 크기로 근사한다.
   * 보조 글리프가 붙은 글자는 구조화 텍스트의 해당 글자들을 합친 사각형.
   */
  quad: Quad;
  /** 채움(stroke 전용이면 선) 색. 패턴 색이거나 알 수 없으면 null. */
  color: RGB | null;
  /** Tr 7·꺼진 /OC 재전송 글리프는 invisible, 패턴 색 텍스트는 fill(계약 3.1 표기 표). */
  render: TextRender;
  /** 클립 텍스트(Tr 4–7) 여부. core 판정은 계약 3.1 표기 표를 따른다. */
  clip: boolean;
  /** 0 가로, 1 세로. */
  wmode: 0 | 1;
  /** PageModel.lines 인덱스. 구조화 텍스트에 없는 글자(예: 일부 숨김 텍스트)는 -1. */
  line: number;
}

/** 구조화 텍스트의 줄. 배열 순서 = 읽기 순서(MuPDF 기준). */
export interface LineInfo {
  bbox: Rect;
  wmode: 0 | 1;
  /** 줄 진행 방향 단위 벡터. */
  dir: Point;
  /** PageModel.blocks 인덱스. */
  block: number;
  /** 이 줄의 글자(PageModel.chars 인덱스), 줄 안 순서. */
  chars: number[];
}

export interface BlockInfo {
  bbox: Rect;
  /** PageModel.lines 인덱스. */
  lines: number[];
}

/** 원래 색공간 값과 sRGB 근사를 함께 둔다(M4 에서 원래 색공간으로 되써야 한다). */
export interface PaintColor {
  /** MuPDF 색공간 이름(예: "DeviceRGB", "DeviceCMYK", "ICCBased(...)" 등 core 가 얻은 값). */
  space: string;
  values: number[];
  rgb: RGB | null;
}

export type PathSegment =
  | { type: 'M'; p: Point }
  | { type: 'L'; p: Point }
  | { type: 'C'; p1: Point; p2: Point; p3: Point }
  | { type: 'Z' };

export interface PathInfo {
  paintSeq: number;
  op: 'fill' | 'stroke' | 'clip' | 'clip-stroke';
  evenOdd: boolean;
  /** 페이지 공간 경계(선 폭 포함). */
  bbox: Rect;
  /** 경로 좌표 → 페이지 공간. */
  ctm: Matrix;
  /** clip 이면 null. */
  color: PaintColor | null;
  alpha: number;
  /** stroke 계열만. 경로 공간 단위. */
  lineWidth: number | null;
  /** `ExtractRequest.includePathSegments` 일 때만, 경로 공간 좌표. 아니면 null. */
  segments: PathSegment[] | null;
}

export interface ImageInfo {
  paintSeq: number;
  op: 'image' | 'image-mask' | 'clip-image-mask';
  /** 페이지 공간 경계. */
  bbox: Rect;
  /** 단위 사각형 → 페이지 공간. */
  ctm: Matrix;
  /** 픽셀 크기. */
  width: number;
  height: number;
  alpha: number;
}

export interface ShadeInfo {
  paintSeq: number;
  /** 페이지 공간 경계. */
  bbox: Rect;
  alpha: number;
}

export interface PageModel {
  pageIndex: number;
  /** `Page.getBounds()`, 페이지 공간. */
  bounds: Rect;
  /** 사용자 공간 → 페이지 공간(`PDFPage.getTransform()`). */
  userToPage: Matrix;
  /** 상속 반영한 /Rotate(0·90·180·270). */
  rotation: number;
  fonts: FontInfo[];
  /** glyphSeq 오름차순. */
  chars: CharInfo[];
  lines: LineInfo[];
  blocks: BlockInfo[];
  /** paintSeq 오름차순(각 배열 안에서). */
  paths: PathInfo[];
  images: ImageInfo[];
  shades: ShadeInfo[];
  /** 센 글리프 총수(= chars.length 가 정상). */
  glyphCount: number;
  /** 센 그리기 콜백 총수(= paths + images + shades 길이 합이 정상). */
  paintCount: number;
  /** 추출 중 경고(MuPDF 경고, 근사값 사용 등). */
  warnings: string[];
  extractMs: number;
}

export interface ExtractRequest {
  pageIndex: number;
  /** 경로 세그먼트까지 담을지(차트 등에서 커질 수 있어 기본 false). */
  includePathSegments?: boolean;
}
