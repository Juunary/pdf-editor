/**
 * 문단 편집(M3, docs/m3-contract.md). 편집 계획·리플로우 요약·초안·로그·undo 의 공통 타입.
 * 기하는 페이지 공간(geometry.ts), 길이 pt. 텍스트 위치는 TextRun.text 를 이은 문자열의 UTF-16 위치다.
 */
import type { Matrix, Point, RGB, Rect } from './geometry.js';
import type { PaintColor } from './page-model.js';
import type { RenderedPage } from './rpc.js';
import type { ChangeKind, SaveMethod } from './save.js';
import type { EditLimitReason } from './source-map.js';

/**
 * 편집 대상 문단. 로그 재적용은 같은 순서로 하므로 적용 시점 상태의 glyphSeq 로 가리킨다.
 * 같은 세션에서 편집한 블록을 다시 편집하면 editedBlock 에 그 편집 id 를 둔다(계약 5.2).
 */
export interface ParagraphTarget {
  pageIndex: number;
  /** 적용 시점 PageModel 의 CharInfo.glyphSeq(LayoutParagraph.chars 순서). */
  glyphSeqs: number[];
  editedBlock: string | null;
  /** 원 문단 bbox. */
  bbox: Rect;
  /** 표 셀 안 문단이면 셀 위치(M4, 없거나 null 이면 흐름 문단; M3 로그 호환을 위해 선택 필드). */
  cell?: { table: number; row: number; col: number } | null;
}

/**
 * 글자 모양. M3 는 모양 바꾸기 UI 가 없으므로 "원본 글자 sourceChar 의 모양 복사" 로 나타낸다(계약 D4).
 * 쓰기는 그 글자 연산의 폰트 리소스·채움 색 연산을 가져온다. fontId·size·bold·italic·color 는 표시·판정용 사본이다.
 */
export interface RunStyle {
  /** 적용 시점 PageModel.chars 인덱스. */
  sourceChar: number;
  fontId: number;
  size: number;
  bold: boolean;
  italic: boolean;
  color: RGB | null;
  /**
   * 글리프마다 더하는 자간(pt, 페이지 공간). 시작 상태가 원본 연산의 `Tc` 로 채운다(Tc × Tz × 글자 크기/Tf 크기).
   * 리플로우가 클러스터 전진에 더하고, 쓰기는 위치 차이를 TJ 숫자로 옮긴다. 없으면 0(이전 로그·블록 호환).
   */
  charSpacing?: number;
  /**
   * 가로 비율(원본 `Tz`/100, 장평). 리플로우가 글리프 전진에 곱하고 쓰기가 편집 블록에 `Tz` 로 쓴다. 없으면 1.
   */
  horizontalScale?: number;
}

/** 같은 모양의 텍스트 구간. 강제 줄바꿈은 "\n". */
export interface TextRun {
  text: string;
  style: RunStyle;
}

export type ParagraphAlign = 'left' | 'right' | 'center' | 'justify';

/**
 * 문단 형식. 영역 초과 처리는 선택이 아니라 리플로우 규칙이다(2026-10-20 사용자 결정): 글이 영역 아래로 넘치면
 * 아래 변을 필요한 높이까지(areaLimit 까지) 자동으로 내린다(ReflowSummary.area). 이전 빌드가 쓴 overflow·fontScale
 * 필드(/PdfEditorFormat JSON·EditOp)는 읽을 때 무시한다.
 */
export interface ParagraphFormat {
  /** 사용자가 정한 배치 영역(기본 원 문단 bbox, areaLimit 안). 실제로 쓴 영역은 ReflowSummary.area. */
  area: Rect;
  align: ParagraphAlign;
  /** 첫 줄 들여쓰기(pt, 음수는 내어쓰기). */
  firstLineIndent: number;
  /** 기준선 간격(pt). */
  lineHeight: number;
  /** 첫 줄 기준선 − 영역 위쪽(pt). */
  firstBaselineOffset: number;
}

/** 문단 텍스트 교체. M4 에서 셀·벡터 편집이 더해진다. */
export interface ReplaceParagraphOp {
  kind: 'replace-paragraph';
  /** 편집 id(세션 안 고유). 편집 블록 /PdfEditorEdit 값과 같다. */
  id: string;
  target: ParagraphTarget;
  runs: TextRun[];
  format: ParagraphFormat;
}

/** 편집 대상 벡터 패스(M4). */
/** 패스 대상 확인용 지문(계약 D4). paintSeq 가 밀려도 다른 패스를 고치지 않게 plan·begin·재적용에서 비교한다. */
export interface PathFingerprint {
  /** 칠하기 연산 이름(S·f·B 등). */
  paintOp: string;
  constructOpCount: number;
  /** 쪽 공간 상자(1e-3 pt 반올림). */
  bbox: Rect;
  /** 구성 연산 바이트의 해시(16진). */
  constructHash: string;
}

export interface PathTarget {
  pageIndex: number;
  /** 선택한 칠하기 연산별 첫 paintSeq(적용 시점 PageModel 기준, 순서 재적용에서만 유효). */
  paintSeqs: number[];
  /** paintSeqs 와 같은 순서. */
  fingerprints: PathFingerprint[];
  bbox: Rect;
}

/** 벡터 패스 편집 내용. null 은 "바꾸지 않음". */
export interface PathEdit {
  /** 페이지 공간 아핀(이동·확대축소만). */
  transform: Matrix | null;
  fill: RGB | null;
  stroke: RGB | null;
  /** 페이지 공간 pt. */
  lineWidth: number | null;
  /**
   * 점 단위 편집(한 패스만, 계약 D2): PageModel PathInfo.segments 순서의 점 번호 → 새 위치(페이지 공간).
   * 점 번호는 segments 를 앞에서부터 센 점(M·L 은 1개, C 는 제어점 2개 + 끝점 1개). null 이면 없음.
   */
  points: { index: number; to: Point }[] | null;
  /** 패스 삭제(계약 D2). true 면 다른 필드는 무시한다. */
  delete: boolean;
}

export interface EditPathOp {
  kind: 'edit-path';
  id: string;
  target: PathTarget;
  edit: PathEdit;
}

export type EditOp = ReplaceParagraphOp | EditPathOp;

/** 패스 편집 제한 사유(M4, 연산 단위 사유 EditLimitReason 에 더해). */
export const PATH_LIMIT_REASONS = [
  'clip-path',
  'pattern-or-shading',
  'path-op-unparsed',
  'path-spans-streams',
  'inside-text-object',
  'path-interleaved-ops', // 구성 ~ 칠하기 사이에 다른 연산(M4 검토 H3)
  'soft-mask', // 칠하기 시점 SMask
  'singular-ctm', // 문단 사유와 같은 이름·같은 뜻
] as const;

export type PathLimitReason = (typeof PATH_LIMIT_REASONS)[number];

export interface PathLimit {
  reason: PathLimitReason | EditLimitReason;
  /** 사용자 표시용 설명(한국어). */
  detail: string;
}

/** 문단 단위 편집 제한 사유(연산 단위 사유 EditLimitReason 에 더해, 계약 5.1). */
export const PARAGRAPH_LIMIT_REASONS = [
  'not-flow-paragraph', // M4 부터 판정이 붙이지 않음(도형 라벨 2026-10-21·표 셀 M4 D1). 이전 결과 호환용
  'vertical-or-rotated', // 세로쓰기·회전 줄
  'remove-skipped', // 제거가 건너뛸 연산 포함(detail = RemoveSkipCode)
  'mixed-content-sources', // 쪽 콘텐츠와 Form, 또는 서로 다른 Form 사용 경로에 걸침
  'actualtext-partial', // ActualText MC 의 글리프 일부만 지움
  'singular-ctm', // 삽입점 CTM 이 특이 행렬
  'insertion-clipped', // 삽입점의 직사각형이 아닌 클립이 원 문단 bbox 를 덮지 않음
  'bt-split-unsupported', // BT 를 나눌 수 없음(클립 텍스트 BT·변위 계산 불가·BT 안 q/cm, detail 에 사유)
  'graphics-state-mismatch', // 원 글자와 삽입점의 SMask 가 다름·패턴 채움
] as const;

export type ParagraphLimitReason = (typeof PARAGRAPH_LIMIT_REASONS)[number];

export interface ParagraphLimit {
  reason: ParagraphLimitReason | EditLimitReason;
  /** reason 이 remove-skipped 이면 제거가 건너뛴 사유 코드. */
  code?: RemoveSkipCode;
  /** 사용자 표시용 설명(한국어). */
  detail: string;
  /** 해당 PageModel.chars 인덱스. 문단 전체에 해당하면 빈 배열. */
  chars: number[];
}

/** removeTextShowOps 건너뜀 사유 코드(계약 D2). */
export const REMOVE_SKIP_CODES = [
  'not-text-show',
  'in-form', // Form 안 연산(복제 경로에서 처리)
  'op-limit', // 연산 limits(spans-stream-boundary·tokenizer-error 등)
  'clip-text', // Tr 4–7
  'font-encoding-unresolved',
  'no-font-resource',
  'reread-failed', // 연산 바이트를 다시 읽지 못함
  'quote-operands', // " 피연산자 부족
  'font-size-zero',
  'hscale-zero',
  'fallback-font', // MuPDF 대체 폰트(로드 실패)
  'vertical',
  'type3',
  'width-uncertain',
  'tj-bad-token', // TJ 배열에 문자열·숫자 밖 토큰
  'cid-unmapped', // CID 매핑 없는 코드
  'glyph-count-mismatch',
] as const;

export type RemoveSkipCode = (typeof REMOVE_SKIP_CODES)[number];

export type EditWarningKind =
  | 'font-fallback' // 원본 폰트에 없는 글자를 폴백 폰트로 씀
  | 'glyph-missing' // 원본·폴백 모두 글리프가 없어 쓰지 않은 글자
  | 'synthetic-style' // 폴백 폰트 합성 굵게·기울임
  | 'tagged-structure-kept' // 새 텍스트가 원 MCID 안(구조 트리 불변)
  | 'tagged-structure-unlinked' // 태그 쪽인데 새 텍스트가 구조와 연결되지 않음
  | 'actualtext-cleared' // 지운 MC 의 ActualText 를 뺌
  | 'reading-order-approximate' // 삽입점을 MC 바깥으로 옮겨 원래 자리와 어긋남(계약 D3 규칙 3)
  | 'link-overlap' // 편집 문단과 겹치는 링크(유지)
  | 'redact-overlap' // 겹치는 기존 Redact 주석(나중에 적용하면 새 텍스트도 지워짐)
  | 'optional-content' // 선택적 콘텐츠 안(L7)
  | 'area-overlaps-content' // (자동으로) 넓힌 영역이 다른 글자·도형과 겹침
  | 'overflow-clipped' // 영역 상한에 막혀 넘친 줄이 CropBox·상위 Form BBox 에서 잘림
  | 'color-space-changed' // 새 색을 쓰려고 색공간을 바꿈(M4 D3)
  | 'shared-form' // 여러 곳이 쓰는 Form 안의 패스, 이 위치만 바뀜(M4)
  | 'path-clipped' // 편집 후 패스 상자가 칠하기 시점 클립·Form BBox 밖(M4)
  | 'table-rule-removed'; // 표 괘선으로 쓰인 패스를 지움(표 감지가 바뀔 수 있음, M4)

export interface EditWarning {
  kind: EditWarningKind;
  message: string;
  /** 관련 영역(링크·Redact 주석·겹침 상자). */
  rects: Rect[];
}

/** 새 텍스트 삽입 방식(계약 D3). */
export interface InsertionInfo {
  /** 편집 블록 호출을 넣는 스트림: 쪽 콘텐츠 또는 복제한 Form. */
  container: 'page' | 'form-clone';
  /** before-bt: BT 바로 앞, split-bt: BT 를 나눔, rewrite-block: 기존 편집 블록만 다시 씀. */
  mode: 'before-bt' | 'split-bt' | 'rewrite-block';
  /** 새 텍스트가 원 MCID 의 marked content 안에 들어가는지. MCID 가 없으면 null. */
  mcidKept: boolean | null;
}

/** 편집 시작 전 판정(문서를 바꾸지 않는다, 계약 5.1·5.3). */
export interface ParagraphEditPlan {
  pageIndex: number;
  /** 판정 시점 PageLayout 의 문단 id. */
  paragraphId: number;
  /** 판정 시점 문서 revision. beginParagraphEdit 에 그대로 넘긴다. */
  revision: number;
  target: ParagraphTarget;
  editable: boolean;
  limits: ParagraphLimit[];
  warnings: EditWarning[];
  /** 편집기 시작 텍스트·모양(계약 5.3). */
  runs: TextRun[];
  /** 텍스트 위치 → PageModel.chars 인덱스. 합성 공백은 -1. 길이 = 텍스트 길이. */
  charIndexOfOffset: number[];
  format: ParagraphFormat;
  /** 영역 상한: CropBox ∩ (Form 안이면 BBox)(A7-4). */
  areaLimit: Rect;
  /** editable 이 false 이면 null. */
  insertion: InsertionInfo | null;
  /** 지울 연산 수(일부만 지우는 연산 포함)·복제할 Form 인스턴스 수. */
  removal: { ops: number; partialOps: number; formInstances: number };
  save: { method: SaveMethod; changes: ChangeKind[] };
  planMs: number;
}

/** 마우스 오버 표시용 문단별 판정(getPageEditability). */
export interface ParagraphEditability {
  paragraphId: number;
  bbox: Rect;
  editable: boolean;
  /** 편집 블록이면 그 편집 id. */
  editedBlock: string | null;
  reasons: (ParagraphLimitReason | EditLimitReason)[];
  /** 표 셀 안 문단이면 셀 위치, 아니면 null(M4). */
  cell: { table: number; row: number; col: number } | null;
}

/** 패스별 판정(M4). */
export interface PathEditability {
  /** PageModel.paths 인덱스. */
  pathIndex: number;
  paintSeq: number;
  bbox: Rect;
  editable: boolean;
  reasons: (PathLimitReason | EditLimitReason)[];
}

export interface PageEditability {
  pageIndex: number;
  revision: number;
  paragraphs: ParagraphEditability[];
  paths: PathEditability[];
  ms: number;
}

/** 패스 편집 시작 전 판정(M4, 문서를 바꾸지 않는다). */
export interface PathEditPlan {
  pageIndex: number;
  revision: number;
  target: PathTarget;
  editable: boolean;
  limits: PathLimit[];
  warnings: EditWarning[];
  fill: PaintColor | null;
  stroke: PaintColor | null;
  lineWidth: number | null;
  planMs: number;
}

export interface PathDraftUpdate {
  draftId: string;
  target: PathTarget;
  bbox: Rect;
  warnings: EditWarning[];
  region: RenderedPage;
  updateMs: number;
}

export interface BeginPathEditResult {
  draftId: string;
  plan: PathEditPlan;
}

/** 배치된 글리프(클러스터 단위). */
export interface PlacedGlyph {
  /** 클러스터 시작 텍스트 위치. */
  offset: number;
  /** 클러스터 길이(UTF-16). */
  length: number;
  /** missing: 원본·폴백 모두 글리프가 없어 쓰지 않음(폭 0, 캐럿 위치용). */
  font: { kind: 'original'; fontId: number } | { kind: 'fallback' } | { kind: 'missing' };
  /** 기준선 원점(페이지 공간). */
  x: number;
  y: number;
  /** 전진량(pt, 조정 포함). */
  advance: number;
  /** 글자 크기(pt). */
  size: number;
}

export interface PlacedLine {
  /** 기준선 y. */
  baseline: number;
  /** 줄 내용의 왼쪽·오른쪽(줄 끝 공백 제외). 빈 줄은 정렬 기준점. */
  x0: number;
  x1: number;
  /** 올림(양수)·내림(음수), pt. 줄 상자 = [baseline − ascent, baseline − descent]. */
  ascent: number;
  descent: number;
  /** 이 줄 텍스트 위치 [start, end). 줄들이 텍스트를 빈틈 없이 덮고, 줄 끝 공백·강제 줄바꿈 문자를 포함한다. */
  start: number;
  end: number;
  /** 강제 줄바꿈으로 끝남. */
  hardBreak: boolean;
}

export interface ReflowSummary {
  /** 1개 이상(빈 텍스트도 캐럿용 줄 1개). */
  lines: PlacedLine[];
  glyphs: PlacedGlyph[];
  /** 배치한 글자 상자의 합집합(넘친 줄 포함). */
  contentBox: Rect;
  /** 실제로 쓴 영역: 입력 영역(상한 안), 글이 넘치면 아래 변을 필요한 높이까지 내린 영역(상한까지). */
  area: Rect;
  /** 상한에 막혀 자동 확장 뒤에도 넘침. */
  overflow: boolean;
  reflowMs: number;
}

export interface DraftInput {
  runs: TextRun[];
  format: ParagraphFormat;
  /** IME 조합 중인 텍스트 위치 [start, end). 조합 중이 아니면 null. 조합 문자열은 runs 에 들어 있다. */
  composition: [number, number] | null;
  /** 변경 영역 렌더 배율(뷰어 scale × devicePixelRatio). */
  renderScale: number;
}

export interface DraftUpdate {
  draftId: string;
  reflow: ReflowSummary;
  /** 그 시점의 전체 경고(계획 경고 포함, 같은 종류는 하나). */
  warnings: EditWarning[];
  /** 변경 영역 렌더(clip 이 채워져 있다). */
  region: RenderedPage;
  updateMs: number;
}

export interface BeginEditResult {
  draftId: string;
  plan: ParagraphEditPlan;
  /** 시작 상태(원 텍스트) 미리보기. */
  first: DraftUpdate;
}

export interface EditHistoryState {
  /** 문서가 바뀔 때마다 오른다(커밋·undo·redo·재적용). 오래된 문단 id 방지. */
  revision: number;
  /** 지금 문서에 반영된 편집 id(로그 순서). 뷰어는 여기 없는 EditOp 를 복구 로그에서 버린다. */
  activeEditIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  /** 커밋된 편집 수(undo 한 것 제외). */
  edits: number;
  /** 직전 동작으로 바뀐 쪽(0부터). */
  affectedPages: number[];
}

export interface CommitResult {
  op: EditOp;
  history: EditHistoryState;
}

/** 쪽의 편집 블록(같은 세션에서 편집한 문단). */
export interface EditedBlock {
  editId: string;
  contentBox: Rect;
  area: Rect;
}

export interface PageEditInfo {
  pageIndex: number;
  blocks: EditedBlock[];
}
