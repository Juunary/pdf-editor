/**
 * 원본 연결 정보(PLAN.md 3.4 "원본에서 그 부분만 바꾸기"). pdf-ops 콘텐츠 스트림 인터프리터가 만든다.
 * 그리고 PageModel 과의 매칭 결과(PageLinkage). 순서 번호 규칙은 page-model.ts 머리말과 같다.
 */
import type { ByteRange, Matrix, Point } from './geometry.js';

/** 콘텐츠 스트림 하나. */
export interface ContentStreamRef {
  /** 스트림 간접 객체 번호. */
  objectNumber: number;
  /** 페이지 /Contents 배열 인덱스(단일 스트림이면 0). Form XObject 스트림이면 null. */
  contentsIndex: number | null;
}

export interface ContentStreamInfo extends ContentStreamRef {
  /** 디코드 후 길이(byte). ByteRange 는 이 바이트 기준이다. */
  decodedLength: number;
  /** /Filter 이름 목록(없으면 빈 배열). */
  filters: string[];
}

/** Form XObject 사용 경로의 한 단계(Do 한 번). */
export interface FormStep {
  /** Do 피연산자 리소스 이름. */
  resourceName: string;
  /** 이 Do 가 있는 스트림 안에서 몇 번째 Do 인지(0부터). */
  doOrdinal: number;
  /** 대상 Form XObject 객체 번호. */
  objectNumber: number;
  /** Do 가 있는 스트림. */
  stream: ContentStreamRef;
  /** Do 의 이름 피연산자 바이트 범위(그 스트림 기준). */
  nameRange: ByteRange;
  /** Do 실행 시점 CTM(Form 공간 진입 전, 사용자 공간 기준). */
  ctm: Matrix;
}

export type SourceOpKind =
  | 'text-show' // Tj TJ ' "
  | 'text-state' // Tc Tw Tz TL Tf Tr Ts Td TD Tm T*
  | 'text-object' // BT ET
  | 'path-construct' // m l c v y h re
  | 'path-paint' // S s f F f* B B* b b* n
  | 'clip' // W W*
  | 'xobject' // Do
  | 'inline-image' // BI … EI
  | 'shading' // sh
  | 'graphics-state' // q Q cm w J j M d ri i gs
  | 'color' // CS cs SC SCN sc scn G g RG rg K k
  | 'marked-content' // BMC BDC EMC MP DP
  | 'compat' // BX EX
  | 'type3' // d0 d1
  | 'other';

/** 편집 제한 사유(docs/m0-dod-xobject-redact-save.md 1.6 L1–L7 + 폰트·텍스트 사유). */
export const EDIT_LIMIT_REASONS = [
  'unmatched', // PageModel 과 매칭 실패
  'tokenizer-error', // L6 토큰 분리 실패
  'spans-stream-boundary', // L6 연산이 /Contents 스트림 경계에 걸침
  'form-inherits-resources', // L1 Form 에 자체 /Resources 없음
  'tagged-content', // L2 /StructParents·MCID(태그 PDF)
  'form-bbox-overflow', // L3 새 텍스트가 Form BBox 초과(편집 시점 판정)
  'outside-page-content', // L4 주석 외관·패턴·Type3 글리프·SMask 안
  'form-depth-exceeded', // L5 Form 재귀 깊이 초과·순환
  'optional-content', // L7 선택적 콘텐츠(경고)
  'type3-font', // Type3 폰트 텍스트
  'font-encoding-unresolved', // 문자 코드 → 유니코드/글리프 매핑 복원 곤란(PLAN.md 3.3)
  'clip-text', // Tr 4–7
  'invisible-text', // Tr 3
  'inline-image', // BI … EI
] as const;

export type EditLimitReason = (typeof EDIT_LIMIT_REASONS)[number];

export interface SourceGlyph {
  /** 문자 코드(폰트 인코딩 기준, 1–4바이트 값). */
  code: number;
  /** 문자열 토큰 안 이 코드의 바이트 범위(16진 문자열이면 16진 숫자 범위). */
  byteRange: ByteRange;
  /** 기준선 원점, 페이지 공간(userToPage 적용 후). 매칭 검증에 쓴다. */
  origin: Point;
  /** glyphSeq. Device 에 오지 않거나 계약 3절 규칙상 세지 않는 글리프(꺼진 /OC 의 표시분 등)는 null. */
  seq: number | null;
}

export interface TextShowInfo {
  /** Tf 리소스 이름. */
  fontResource: string;
  /** 폰트 객체 번호. 직접 객체이면 null. */
  fontObjectNumber: number | null;
  /** /Subtype(Type0·Type1·MMType1·TrueType·Type3). 알 수 없으면 null. */
  fontSubtype: string | null;
  fontSize: number;
  /** 연산자 실행 직전 텍스트 행렬 Tm. */
  tm: Matrix;
  charSpacing: number;
  wordSpacing: number;
  /** Tz/100. */
  horizontalScale: number;
  leading: number;
  rise: number;
  /** Tr 0–7. */
  renderMode: number;
  glyphs: SourceGlyph[];
}

export interface SourceOp {
  /** SourceMap.ops 인덱스. */
  id: number;
  /** 연산자 키워드(인라인 이미지는 "BI"). */
  op: string;
  kind: SourceOpKind;
  /** 연산자가 시작하는 스트림. */
  stream: ContentStreamRef;
  /** 첫 피연산자 시작 ~ 연산자 끝(그 스트림의 디코드 바이트 기준). */
  range: ByteRange;
  /** Form XObject 안이면 페이지에서 이 스트림까지의 Do 경로. 페이지 콘텐츠면 빈 배열. */
  formPath: FormStep[];
  /** 실행 시점 CTM: 이 스트림의 콘텐츠 공간 → 사용자 공간(Form /Matrix 포함). */
  ctm: Matrix;
  /** q 중첩과 무관한 활성 클립 수(W n 누적). */
  clipDepth: number;
  /** 열린 marked content 의 MCID 들(바깥 → 안). 태그 정책(PLAN.md 1.4)용. */
  mcids: number[];
  /** 선택적 콘텐츠(/OC) 안 여부. */
  optionalContent: boolean;
  /** kind = text-show 일 때만. */
  text?: TextShowInfo;
  /**
   * 이 연산 글리프 seq 의 [최솟값, 최댓값 + 1). ET 시점 번호(Tr 7 등) 때문에 연속이 아닐 수 있으므로
   * 글자별 값은 text.glyphs[].seq 를 쓴다. 번호를 받은 글리프가 없으면 생략.
   */
  glyphSeq?: [number, number];
  /**
   * path-paint·inline-image·xobject(이미지·Form BBox 클립)·shading 이 만든 paintSeq 들.
   * 타일링 패턴 직접 실행 경로의 셀 내용 번호는 그 패턴 칠하기 연산에 포함한다(계약 3절 세부 표).
   */
  paintSeq?: number[];
  /** 이 연산을 편집할 때의 제한 사유. 없으면 빈 배열. */
  limits: EditLimitReason[];
}

export interface SourceMapError {
  stream: ContentStreamRef;
  /** 디코드 바이트 오프셋. */
  offset: number;
  message: string;
}

export interface SourceMap {
  pageIndex: number;
  /** 사용자 공간 → 페이지 공간(`PDFPage.getTransform()`). */
  userToPage: Matrix;
  /** 이 페이지가 실행한 스트림(페이지 /Contents 순서, 이어서 Form 스트림 첫 등장 순). */
  streams: ContentStreamInfo[];
  /** 실행 순서. Form XObject 안의 연산은 그 Do 연산 바로 뒤에 펼쳐 넣는다. */
  ops: SourceOp[];
  /** 인터프리터가 센 glyphSeq 총수. PageModel.glyphCount 와 같아야 한다. */
  glyphCount: number;
  /** 인터프리터가 센 paintSeq 총수. PageModel.paintCount 와 같아야 한다. */
  paintCount: number;
  errors: SourceMapError[];
  buildMs: number;
}

export interface LinkStats {
  chars: number;
  matchedChars: number;
  paints: number;
  matchedPaints: number;
  /** 매칭된 글자의 원점 오차 최댓값(pt, 페이지 공간). */
  maxOriginError: number;
  /** PageModel 과 SourceMap 의 총수 차이(모델 − 맵). 0 이 정상. */
  glyphCountDelta: number;
  paintCountDelta: number;
}

/** PageModel ↔ SourceMap 매칭 결과. 배열 인덱스는 PageModel 의 같은 이름 배열과 같다. */
export interface PageLinkage {
  pageIndex: number;
  /** chars[i] → SourceOp.id. 실패 -1. */
  charOp: number[];
  /** chars[i] → 그 연산의 text.glyphs 인덱스. 실패 -1. */
  charGlyph: number[];
  /** paths[i] → SourceOp.id. 실패 -1. */
  pathOp: number[];
  imageOp: number[];
  shadeOp: number[];
  stats: LinkStats;
  linkMs: number;
}
