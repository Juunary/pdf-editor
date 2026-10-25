/**
 * 편집 제한 사유·편집 경고의 사용자 표시 문구 표(한국어·영어). 고르는 함수는 edit-labels.ts. 키는 계약 5.1 의 문단 사유·연산 사유·패스 사유 전부와
 * 편집 경고 종류 전부다. 화면 언어 표는 strings.ts(`ViewerStrings.limitLabels`·`warningTexts`)가 고른다.
 *
 * core·pdf-ops 가 만드는 사유 설명(`ParagraphLimit.detail`·`PathLimit.detail`)과 경고 문장(`EditWarning.message`)은
 * 한국어다. 한국어 화면은 그 문장을 그대로 쓰고(더 구체적인 진단 정보 포함), 영어 화면은 사유 코드·경고 종류·수치로 이
 * 표에서 문장을 만든다(사용자 결정 2026-10-26).
 */
import type {
  EditLimitReason,
  EditWarningKind,
  ParagraphLimitReason,
  PathLimitReason,
} from '@pdf-editor/shared-types';

export type LimitReason = ParagraphLimitReason | EditLimitReason | PathLimitReason;

export const LIMIT_LABELS: Record<LimitReason, string> = {
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

export const LIMIT_LABELS_EN: Record<LimitReason, string> = {
  'not-flow-paragraph': 'Text outside the body flow cannot be edited in this version.',
  'vertical-or-rotated': 'Vertical or rotated text cannot be edited.',
  'remove-skipped': 'It contains an operation whose original text cannot be removed safely.',
  'mixed-content-sources':
    'The paragraph text spans the page content and a separate object (Form).',
  'actualtext-partial': 'Only part of the replacement text (ActualText) would be removed.',
  'singular-ctm': 'The coordinate transform of the text is a singular matrix.',
  'insertion-clipped': 'The text position is hidden by a clipping area.',
  'bt-split-unsupported': 'The text object cannot be split (for example, clipping text).',
  'graphics-state-mismatch':
    'A different transparency mask or pattern fill prevents drawing the new text the same way.',
  unmatched: 'The text could not be linked to the text operations in the original PDF.',
  'tokenizer-error': 'The content stream could not be parsed.',
  'spans-stream-boundary': 'The text operation spans a content stream boundary.',
  'form-inherits-resources': 'The object (Form) has no resources of its own.',
  'tagged-content': 'The text is inside a tagged structure.',
  'form-bbox-overflow': 'The new text extends outside the object (Form) area.',
  'outside-page-content':
    'Text outside the page content (annotation appearance, pattern, Type3 glyph, SMask) cannot be edited.',
  'form-depth-exceeded': 'Objects (Forms) are nested too deeply.',
  'optional-content': 'The text is inside optional content (a layer).',
  'clip-path': 'A path that defines a clipping area cannot be edited.',
  'pattern-or-shading': 'A path filled with a pattern or shading cannot be edited.',
  'path-op-unparsed': 'The path drawing operations could not be parsed.',
  'path-spans-streams': 'The path spans a content stream boundary.',
  'inside-text-object': 'A path inside a text object (BT) cannot be edited.',
  'path-interleaved-ops': 'Other operations are mixed into the path drawing.',
  'soft-mask': 'A path under a transparency mask (SMask) cannot be edited.',
  'type3-font': 'Type3 fonts cannot be edited.',
  'font-encoding-unresolved': 'The font encoding could not be recovered.',
  'clip-text': 'Clipping text (render modes 4–7) cannot be edited.',
  'invisible-text': 'Invisible text (the OCR layer of a scanned document) cannot be edited.',
  'inline-image': 'It is mixed with an inline image.',
};

/** 경고 종류(+ 경우)별 문구 키. */
export type WarningTextKey =
  | EditWarningKind
  | 'tagged-structure-unlinked:form-clone'
  | 'tagged-structure-unlinked:path-removed';

/** 경고 문구 함수: count 는 개수(없으면 rects 수), chars 는 해당 글자. */
export type WarningText = (count: number, chars: string) => string;

const withChars = (chars: string) => (chars ? `: ${chars}` : '');

export const WARNING_TEXTS_KO: Record<WarningTextKey, WarningText> = {
  'font-fallback': (n, c) => `원본 폰트에 없는 글자 ${n}종을 폴백 폰트로 씁니다${withChars(c)}`,
  'glyph-missing': (_n, c) => `원본·폴백 폰트 모두 글리프가 없어 쓰지 않는 글자${withChars(c)}`,
  'synthetic-style': () => '폴백 폰트로 쓴 굵게·기울임 구간은 합성(선 두께·기울기)으로 표시합니다.',
  'tagged-structure-kept': () =>
    '새 텍스트가 원 문단의 marked content(MCID) 안에 들어가 구조 연결이 유지됩니다.',
  'tagged-structure-unlinked': () =>
    '태그 PDF 구조(읽기 순서·태그)와 새 텍스트가 연결되지 않습니다. 구조는 갱신하지 않습니다.',
  'tagged-structure-unlinked:form-clone': () =>
    'Form 을 복제하면서 /StructParents 를 지웁니다. 태그 PDF 구조와 이 위치의 연결이 끊깁니다.',
  'tagged-structure-unlinked:path-removed': () =>
    '태그(MCID)된 콘텐츠 안의 패스를 지웁니다. 태그 PDF 구조 트리에 내용 없는 항목이 남을 수 있습니다.',
  'actualtext-cleared': (n) => `지운 문단의 /ActualText ${n}개를 뺍니다.`,
  'reading-order-approximate': () =>
    'BT 안 marked content 때문에 새 텍스트를 원래 자리보다 앞에 넣습니다. 복사·읽기 순서가 원래와 조금 다를 수 있습니다.',
  'link-overlap': (n) =>
    `편집 문단과 겹치는 링크 ${n}개는 그대로 남습니다(영역을 다시 계산하지 않음).`,
  'redact-overlap': (n) =>
    `편집 문단이 적용되지 않은 Redact 표시 ${n}개와 겹칩니다. 나중에 적용하면 새 텍스트도 지워집니다.`,
  'optional-content': () =>
    '선택적 콘텐츠(/OC) 안입니다. 레이어 설정에 따라 보이지 않을 수 있습니다.',
  'area-overlaps-content': () => '편집 영역이 다른 글자·표·도형과 겹칩니다.',
  'overflow-clipped': () => '영역 상한(쪽·Form 경계) 밖으로 나간 글자는 표시되지 않습니다.',
  'color-space-changed': () => '원래 색공간으로 고른 색을 나타낼 수 없어 DeviceRGB 로 씁니다.',
  'shared-form': () => '여러 곳에서 쓰는 Form 안의 패스입니다. 이 사용 위치만 바뀝니다.',
  'path-clipped': () =>
    '편집한 패스가 칠하기 시점 클립·Form BBox 밖으로 나가 일부가 보이지 않습니다.',
  'table-rule-removed': () => '표 괘선으로 쓰인 패스를 지웁니다. 표 감지가 바뀔 수 있습니다.',
};

export const WARNING_TEXTS_EN: Record<WarningTextKey, WarningText> = {
  'font-fallback': (n, c) =>
    `${n} character(s) missing from the original font are drawn with the fallback font${withChars(c)}`,
  'glyph-missing': (_n, c) =>
    `Not drawn because neither the original nor the fallback font has a glyph${withChars(c)}`,
  'synthetic-style': () =>
    'Bold and italic runs in the fallback font are simulated (stroke width, slant).',
  'tagged-structure-kept': () =>
    "The new text stays inside the paragraph's marked content (MCID), so the structure link is kept.",
  'tagged-structure-unlinked': () =>
    'The new text is not linked to the tagged PDF structure (reading order, tags). The structure is not updated.',
  'tagged-structure-unlinked:form-clone': () =>
    'Cloning the Form removes /StructParents. This location loses its link to the tagged PDF structure.',
  'tagged-structure-unlinked:path-removed': () =>
    'Deletes a path inside tagged (MCID) content. Empty entries may remain in the tagged PDF structure tree.',
  'actualtext-cleared': (n) => `Removes ${n} /ActualText entry(ies) of the deleted paragraph.`,
  'reading-order-approximate': () =>
    'Marked content inside BT puts the new text before its original position. Copy and reading order may differ slightly.',
  'link-overlap': (n) =>
    `${n} link(s) overlapping the edited paragraph stay as they are (their areas are not recalculated).`,
  'redact-overlap': (n) =>
    `The edited paragraph overlaps ${n} unapplied Redact mark(s). Applying them later also removes the new text.`,
  'optional-content': () =>
    'Inside optional content (/OC). It may be hidden depending on layer settings.',
  'area-overlaps-content': () => 'The edit area overlaps other text, tables or shapes.',
  'overflow-clipped': () => 'Text outside the area limit (page or Form boundary) is not displayed.',
  'color-space-changed': () =>
    'The chosen color cannot be expressed in the original color space, so DeviceRGB is used.',
  'shared-form': () =>
    'This path is inside a Form used in several places. Only this location changes.',
  'path-clipped': () =>
    'The edited path extends outside the clip or Form BBox at paint time, so part of it is hidden.',
  'table-rule-removed': () => 'Deletes a path used as a table rule. Table detection may change.',
};

/** 태그 PDF 편집 차단 설정이 켜져 있을 때의 사유. */
export const TAGGED_BLOCKED_LABEL =
  '설정에서 태그 PDF 편집 막기가 켜져 있어 이 문단은 편집하지 않습니다.';

/** 태그 쪽 편집 안내(계약 D1). */
export const TAGGED_NOTICE = '태그된 PDF 입니다. 구조(읽기 순서·태그)는 갱신하지 않습니다.';

/** 편집한 쪽 번호가 파일에 남는다는 안내(계약 5.6). */
export const EDIT_PAGES_NOTICE =
  '저장하면 편집한 쪽 번호가 파일 정보(PdfEditorEdits)에 기록됩니다.';

/** 되돌린 뒤 새 편집을 시작할 때 보이는 안내(core 가 다시 실행 단계를 버린다, 계약 D9). */
export const REDO_DISCARDED_NOTICE =
  '새 편집을 시작해 다시 실행(redo) 기록이 사라졌습니다. 이 편집을 취소해도 돌아오지 않습니다.';
