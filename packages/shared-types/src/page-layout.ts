/**
 * 쪽 레이아웃(M2, PLAN.md 3.4 "논리 문서 모델"). layout-recon 이 PageModel 에서 만든다(docs/m2-contract.md).
 * PLAN.md 의 DocumentModel 은 쪽별 PageLayout 의 모음이다. 모든 기하는 페이지 공간(geometry.ts)이다.
 */
import type { RGB, Rect } from './geometry.js';

export type ParagraphRole =
  | 'body'
  | 'heading'
  | 'list-item'
  | 'caption'
  | 'header' // 쪽 머리(러닝헤드 등)
  | 'footer' // 쪽 꼬리(쪽 번호 등)
  | 'footnote'
  | 'other';

/** 문단 안 같은 모양의 글자 구간. start·end 는 LayoutParagraph.chars 위치 [start, end). */
export interface StyleRun {
  start: number;
  end: number;
  fontId: number;
  size: number;
  bold: boolean;
  italic: boolean;
  color: RGB | null;
}

export interface LayoutParagraph {
  id: number;
  bbox: Rect;
  /** PageModel.lines 인덱스, 읽기 순서. */
  lines: number[];
  /** PageModel.chars 인덱스, 읽기 순서(줄 순서 → 줄 안 순서). */
  chars: number[];
  /**
   * 문단 텍스트. 줄 안은 글자 + spaceAfter 공백, 줄 사이는 공백 하나(줄 끝이 "-" 이면 붙임).
   * 문단 안 줄바꿈은 배치 결과로 보고 남기지 않는다(docs/m2-contract.md 2.3).
   */
  text: string;
  role: ParagraphRole;
  /** PageLayout.columns 인덱스. 머리·꼬리·표 안·도형 라벨 문단은 -1. */
  column: number;
  /** 표 안 문단이면 LayoutTable.id. */
  table: number | null;
  /** 도형 안 글자(축 라벨 등)면 LayoutFigure.id. */
  figure: number | null;
  /** 기준선 간격(pt). 한 줄이면 null. M3 리플로우 입력. */
  lineHeight: number | null;
  /** 첫 줄 들여쓰기(pt, 둘째 줄 이후 왼쪽 기준. 한 줄이면 0). */
  firstLineIndent: number;
  align: 'left' | 'right' | 'center' | 'justify' | 'unknown';
  styleRuns: StyleRun[];
  /** 같은 쪽 다른 열로 이어지는 문단이면 그 문단 id, 아니면 null. */
  continuesTo: number | null;
}

export interface LayoutColumn {
  id: number;
  bbox: Rect;
}

export interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  bbox: Rect;
  /** 셀 안 PageModel.lines 인덱스(읽기 순서). */
  lines: number[];
  /** 셀 안 LayoutParagraph id. */
  paragraphs: number[];
}

export interface LayoutTable {
  id: number;
  bbox: Rect;
  rows: number;
  cols: number;
  /** 행 경계 y(rows+1 개, 위→아래), 열 경계 x(cols+1 개, 왼쪽→오른쪽). */
  rowBounds: number[];
  colBounds: number[];
  cells: TableCell[];
  /** lines: 괘선으로 찾음, text: 글자 정렬로 찾음. */
  strategy: 'lines' | 'text';
}

export interface LayoutFigure {
  id: number;
  bbox: Rect;
  kind: 'image' | 'vector';
  /** PageModel.images·paths 인덱스. */
  images: number[];
  paths: number[];
  /** 도형 안 글자(축 라벨 등) LayoutParagraph id. */
  labels: number[];
}

export interface LayoutItemRef {
  kind: 'paragraph' | 'table' | 'figure';
  id: number;
}

export interface PageLayout {
  pageIndex: number;
  bounds: Rect;
  columns: LayoutColumn[];
  paragraphs: LayoutParagraph[];
  tables: LayoutTable[];
  figures: LayoutFigure[];
  /**
   * 최상위 읽기 순서(머리 → 본문 → 꼬리). 표·도형 안 문단은 넣지 않는다(표는 셀 행 우선, 도형은
   * labels 순서). 머리·꼬리 문단은 role 로 구분한다.
   */
  readingOrder: LayoutItemRef[];
  /** 어떤 문단에도 넣지 않은 줄(보이는 글자가 없는 줄). */
  unassignedLines: number[];
  warnings: string[];
  reconMs: number;
}

/** PLAN.md 의 DocumentModel: 쪽 레이아웃 모음. */
export interface DocumentModel {
  pages: PageLayout[];
}
