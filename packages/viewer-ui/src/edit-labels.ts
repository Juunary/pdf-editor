/** 편집 제한 사유의 사용자 표시 문구(한국어). 키는 계약 5.1 의 문단 사유와 연산 사유 전부다. */
import type {
  EditLimitReason,
  ParagraphLimitReason,
  PathLimitReason,
} from '@pdf-editor/shared-types';

export const LIMIT_LABELS: Record<
  ParagraphLimitReason | EditLimitReason | PathLimitReason,
  string
> = {
  // M4 부터 판정이 붙이지 않는다(도형 라벨·표 셀 모두 편집 가능). 이전 판정 결과 표시용으로 남긴다.
  'not-flow-paragraph': '본문 흐름 밖의 글자는 이 버전에서 편집할 수 없습니다.',
  'vertical-or-rotated': '세로쓰기·회전된 글자는 편집할 수 없습니다.',
  'remove-skipped': '원본 글자를 안전하게 지울 수 없는 연산이 있어 편집할 수 없습니다.',
  'mixed-content-sources': '문단 글자가 쪽 본문과 별도 개체(Form)에 걸쳐 있어 편집할 수 없습니다.',
  'actualtext-partial': '대체 텍스트(ActualText)의 일부만 지우게 되어 편집할 수 없습니다.',
  'singular-ctm': '글자가 놓인 좌표 변환이 특이 행렬이라 편집할 수 없습니다.',
  'insertion-clipped': '글자 위치가 잘림 영역(클립)에 가려져 편집할 수 없습니다.',
  'bt-split-unsupported': '글자 개체를 나눌 수 없는 구조(클립 텍스트 등)라 편집할 수 없습니다.',
  'graphics-state-mismatch':
    '투명도 마스크·패턴 채움이 달라 새 글자를 같은 모양으로 쓸 수 없습니다.',
  unmatched: '원본 PDF 의 글자 연산과 연결하지 못해 편집할 수 없습니다.',
  'tokenizer-error': '콘텐츠 스트림을 해석하지 못해 편집할 수 없습니다.',
  'spans-stream-boundary': '글자 연산이 콘텐츠 스트림 경계에 걸쳐 있어 편집할 수 없습니다.',
  'form-inherits-resources': '개체(Form)가 자체 리소스가 없어 편집할 수 없습니다.',
  'tagged-content': '태그된 구조 안의 글자입니다.',
  'form-bbox-overflow': '새 글자가 개체(Form) 영역을 벗어납니다.',
  'outside-page-content':
    '쪽 본문 밖(주석 외관·패턴·Type3 글리프·SMask 안)의 글자는 편집할 수 없습니다.',
  'form-depth-exceeded': '개체(Form) 중첩이 너무 깊어 편집할 수 없습니다.',
  'optional-content': '선택적 콘텐츠(레이어) 안의 글자입니다.',
  'clip-path': '잘림 영역(클립)을 만드는 패스는 편집할 수 없습니다.',
  'pattern-or-shading': '무늬(패턴)·그러데이션(셰이딩) 채움 패스는 편집할 수 없습니다.',
  'path-op-unparsed': '패스 그리기 연산을 해석하지 못해 편집할 수 없습니다.',
  'path-spans-streams': '패스가 콘텐츠 스트림 경계에 걸쳐 있어 편집할 수 없습니다.',
  'inside-text-object': '글자 개체(BT) 안의 패스는 편집할 수 없습니다.',
  'path-interleaved-ops': '패스 그리기 도중에 다른 연산이 끼어 있어 편집할 수 없습니다.',
  'soft-mask': '투명도 마스크(SMask) 아래의 패스는 편집할 수 없습니다.',
  'type3-font': 'Type3 글꼴은 편집할 수 없습니다.',
  'font-encoding-unresolved': '글꼴 인코딩을 복원하지 못해 편집할 수 없습니다.',
  'clip-text': '클립 텍스트(렌더 모드 4–7)는 편집할 수 없습니다.',
  'invisible-text': '보이지 않는 글자(스캔 문서의 OCR 층)는 편집할 수 없습니다.',
  'inline-image': '인라인 이미지가 섞여 있어 편집할 수 없습니다.',
};

export function limitLabel(reason: string): string {
  return (LIMIT_LABELS as Record<string, string>)[reason] ?? `편집할 수 없습니다 (${reason})`;
}

/** 태그 PDF 편집 차단 설정이 켜져 있을 때의 사유. */
export const TAGGED_BLOCKED_LABEL =
  '설정에서 태그 PDF 편집 막기가 켜져 있어 이 문단은 편집하지 않습니다.';

/** 태그 쪽 편집 안내(계약 D1). */
export const TAGGED_NOTICE = '태그된 PDF 입니다. 구조(읽기 순서·태그)는 갱신하지 않습니다.';

/** 편집한 쪽 번호가 파일에 남는다는 안내(계약 5.6). */
export const EDIT_PAGES_NOTICE =
  '저장하면 편집한 쪽 번호가 파일 정보(PdfEditorEdits)에 기록됩니다.';
