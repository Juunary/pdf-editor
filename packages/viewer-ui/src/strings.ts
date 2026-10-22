/**
 * 뷰어 UI 문자열 표(한국어·영어, 사용자 요청 2026-10-23). 언어는 호출자(확장)가 정해 `ViewerControllerOptions.strings` 로
 * 넣는다. 넣지 않으면 한국어. viewer-ui 는 확장 API(`chrome.i18n`)를 쓰지 않는다(하니스·Node 시험에서 그대로 동작).
 *
 * 범위: 툴바 컨트롤(쪽 이동·찾기·레이아웃·편집 버튼)·검색창·쪽 화살표·툴바 편집 알림. 쪽 위 편집 UI(편집기·팝오버·패스
 * 패널·범례)와 편집 제한 사유(`edit-labels.ts`)는 한국어만 있다.
 */
import type { FeatureName } from './controller.js';
import { REDO_DISCARDED_NOTICE } from './edit-labels.js';

export type UiLang = 'ko' | 'en';

/**
 * 언어 태그(BCP 47, `chrome.i18n.getUILanguage()`·`navigator.language`)로 UI 언어를 정한다. 앞에서부터 비어 있지 않은
 * 첫 태그를 보고, 주 언어가 ko 이면 한국어, 그 밖(태그 없음 포함)은 영어.
 */
export function resolveUiLang(...tags: (string | null | undefined)[]): UiLang {
  const tag = tags.find((t) => typeof t === 'string' && t.trim() !== '');
  const primary = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary === 'ko' ? 'ko' : 'en';
}

export interface ViewerStrings {
  lang: UiLang;
  /** 툴바 컨트롤 묶음(role=toolbar)의 이름. */
  controlsLabel: string;
  prevPage: string;
  nextPage: string;
  pageNumber: string;
  /** 쪽 번호 입력 뒤 "/ N". */
  pageCount(n: number): string;
  find: string;
  findTitle: string;
  overlay: string;
  overlayIntro: string;
  overlayPathSelect: string;
  overlayLayoutReason(reason: string): string;
  overlayMarksReason(reason: string): string;
  overlayMarksOnly(layoutReason: string): string;
  overlayLayoutOnly(marksReason: string): string;
  /** 편집 RPC 가 없는 호스트의 편집 가능 표시 사유. */
  noEditHost: string;
  undo: string;
  undoTitle: string;
  redo: string;
  redoTitle: string;
  editCancel: string;
  editCancelTitle: string;
  fallback: string;
  fallbackTitle: string;
  blockTagged: string;
  blockTaggedTitle: string;
  dismissTitle: string;
  /** "비활성: 기능, 기능". */
  disabledList(features: string): string;
  featureLabels: Record<FeatureName, string>;
  // 검색창
  findPlaceholder: string;
  findPrev: string;
  findPrevTitle: string;
  findNext: string;
  findNextTitle: string;
  matchCase: string;
  findClose: string;
  findCloseTitle: string;
  findSearching: string;
  findUnavailable: string;
  findFailed: string;
  findNoResults: string;
  findUnavailableWith(message: string): string;
  findFailedWith(message: string): string;
  // 툴바 편집 알림(#pe-edit-notice)
  failureWith(prefix: string, message: string): string;
  editStartFailed: string;
  editSaveFailed: string;
  editCancelFailed: string;
  undoFailed: string;
  redoFailed: string;
  editNotApplied(error: string): string;
  /** 되돌린 뒤 새 편집을 시작해 다시 실행 기록이 사라졌다는 안내(계약 D9). */
  redoDiscarded: string;
  editRecoveredRestart: string;
  editRecoveredContinue: string;
  recoveredPathCancelled: string;
  recoveredParagraphReopened: string;
  recoveredHistoryLost: string;
  restartAfterRecoveryFailed: string;
  pathPlanFailed: string;
  pathStartFailed: string;
  pathApplyFailed: string;
  pathRecoveredReselect: string;
}

const KO: ViewerStrings = {
  lang: 'ko',
  controlsLabel: '페이지 이동',
  prevPage: '이전 페이지',
  nextPage: '다음 페이지',
  pageNumber: '페이지 번호',
  pageCount: (n) => `/ ${n}`,
  find: '찾기',
  findTitle: '문서에서 찾기 (Ctrl+F)',
  overlay: '레이아웃·편집 표시',
  overlayIntro: '레이아웃(문단·표·도형·읽기 순서)과 편집 가능 테두리를 함께 표시합니다',
  overlayPathSelect: '켜 두면 클릭으로 패스를 선택합니다',
  overlayLayoutReason: (r) => `레이아웃: ${r}`,
  overlayMarksReason: (r) => `편집 가능 표시: ${r}`,
  overlayMarksOnly: (r) => `레이아웃을 쓸 수 없어 편집 가능 표시만 켭니다: ${r}`,
  overlayLayoutOnly: (r) => `편집 가능 표시를 쓸 수 없어 레이아웃만 켭니다: ${r}`,
  noEditHost: '편집 기능 없음',
  undo: '되돌리기',
  undoTitle: '편집 되돌리기 (Ctrl+Z). 작업 모듈이 복구되면 되돌리기 기록이 사라집니다',
  redo: '다시 실행',
  redoTitle:
    '다시 실행 (Ctrl+Shift+Z, Ctrl+Y). 새 편집을 시작하거나 복구되면 다시 실행 기록이 사라집니다',
  editCancel: '편집 취소',
  editCancelTitle: '이 문단의 편집을 버리고 원래대로 되돌립니다',
  fallback: '폴백 표시',
  fallbackTitle: '원본 글꼴에 없어 폴백 글꼴로 쓴 글자에 점선 밑줄 표시',
  blockTagged: '태그 PDF 편집 막기',
  blockTaggedTitle:
    '태그된 PDF 쪽의 문단은 편집하지 않습니다. 저장하면 편집한 쪽 번호가 파일 정보(PdfEditorEdits)에 기록됩니다.',
  dismissTitle: '클릭하면 닫습니다',
  disabledList: (f) => `비활성: ${f}`,
  featureLabels: {
    text: '텍스트 선택',
    search: '검색',
    debug: '연결 디버그',
    layout: '레이아웃',
    edit: '문단 편집',
    path: '벡터 편집',
  },
  findPlaceholder: '문서에서 찾기',
  findPrev: '이전 결과',
  findPrevTitle: '이전 결과 (Shift+Enter)',
  findNext: '다음 결과',
  findNextTitle: '다음 결과 (Enter)',
  matchCase: '대소문자 구분',
  findClose: '검색창 닫기',
  findCloseTitle: '닫기 (Esc)',
  findSearching: '검색 중',
  findUnavailable: '검색을 사용할 수 없습니다',
  findFailed: '검색 실패',
  findNoResults: '결과 없음',
  findUnavailableWith: (m) => `검색을 사용할 수 없습니다 (${m})`,
  findFailedWith: (m) => `검색 실패: ${m}`,
  failureWith: (prefix, m) => `${prefix}: ${m}`,
  editStartFailed: '편집을 시작하지 못했습니다',
  editSaveFailed: '편집을 저장하지 못했습니다',
  editCancelFailed: '편집을 취소하지 못했습니다',
  undoFailed: '되돌리지 못했습니다',
  redoFailed: '다시 실행하지 못했습니다',
  editNotApplied: (e) => `편집을 반영하지 못했습니다: ${e}`,
  redoDiscarded: REDO_DISCARDED_NOTICE,
  editRecoveredRestart: '문서를 복구했습니다. 편집을 다시 시작하세요.',
  editRecoveredContinue: '문서를 복구했습니다. 편집을 계속하세요.',
  recoveredPathCancelled:
    '작업 모듈이 중단되어 문서를 복구했습니다. 진행 중이던 패스 편집은 취소했습니다.',
  recoveredParagraphReopened:
    '작업 모듈이 중단되어 문서를 복구했습니다. 편집 중이던 문단을 다시 열었습니다.',
  recoveredHistoryLost:
    '작업 모듈이 중단되어 문서를 복구했습니다. 복구 전 되돌리기 이력은 사라졌습니다.',
  restartAfterRecoveryFailed: '복구 뒤 편집을 다시 시작하지 못했습니다',
  pathPlanFailed: '패스를 판정하지 못했습니다',
  pathStartFailed: '패스 편집을 시작하지 못했습니다',
  pathApplyFailed: '패스 편집을 반영하지 못했습니다',
  pathRecoveredReselect: '문서를 복구했습니다. 패스를 다시 선택하세요.',
};

const EN: ViewerStrings = {
  lang: 'en',
  controlsLabel: 'Page navigation',
  prevPage: 'Previous page',
  nextPage: 'Next page',
  pageNumber: 'Page number',
  pageCount: (n) => `/ ${n}`,
  find: 'Find',
  findTitle: 'Find in document (Ctrl+F)',
  overlay: 'Layout & editable marks',
  overlayIntro:
    'Shows the layout (paragraphs, tables, figures, reading order) together with editable outlines',
  overlayPathSelect: 'While on, click to select a path',
  overlayLayoutReason: (r) => `Layout: ${r}`,
  overlayMarksReason: (r) => `Editable marks: ${r}`,
  overlayMarksOnly: (r) => `Layout is unavailable, so only editable marks are shown: ${r}`,
  overlayLayoutOnly: (r) => `Editable marks are unavailable, so only the layout is shown: ${r}`,
  noEditHost: 'Editing not available',
  undo: 'Undo',
  undoTitle: 'Undo edit (Ctrl+Z). Undo history is lost if the worker is recovered',
  redo: 'Redo',
  redoTitle:
    'Redo (Ctrl+Shift+Z, Ctrl+Y). Redo history is lost when you start a new edit or after recovery',
  editCancel: 'Cancel edit',
  editCancelTitle: 'Discard the changes to this paragraph',
  fallback: 'Show fallback',
  fallbackTitle:
    'Dotted underline under characters drawn with the fallback font (missing from the original font)',
  blockTagged: 'Block tagged PDF edits',
  blockTaggedTitle:
    'Paragraphs on tagged PDF pages are not edited. Saving records the edited page numbers in the file info (PdfEditorEdits).',
  dismissTitle: 'Click to dismiss',
  disabledList: (f) => `Unavailable: ${f}`,
  featureLabels: {
    text: 'Text selection',
    search: 'Search',
    debug: 'Linkage debug',
    layout: 'Layout',
    edit: 'Paragraph editing',
    path: 'Vector editing',
  },
  findPlaceholder: 'Find in document',
  findPrev: 'Previous match',
  findPrevTitle: 'Previous match (Shift+Enter)',
  findNext: 'Next match',
  findNextTitle: 'Next match (Enter)',
  matchCase: 'Match case',
  findClose: 'Close find bar',
  findCloseTitle: 'Close (Esc)',
  findSearching: 'Searching…',
  findUnavailable: 'Search is not available',
  findFailed: 'Search failed',
  findNoResults: 'No results',
  findUnavailableWith: (m) => `Search is not available (${m})`,
  findFailedWith: (m) => `Search failed: ${m}`,
  failureWith: (prefix, m) => `${prefix}: ${m}`,
  editStartFailed: 'Could not start editing',
  editSaveFailed: 'Could not apply the edit',
  editCancelFailed: 'Could not cancel the edit',
  undoFailed: 'Could not undo',
  redoFailed: 'Could not redo',
  editNotApplied: (e) => `Could not apply the edit: ${e}`,
  redoDiscarded:
    'Starting a new edit cleared the redo history. Cancelling this edit will not bring it back.',
  editRecoveredRestart: 'The document was recovered. Start editing again.',
  editRecoveredContinue: 'The document was recovered. Continue editing.',
  recoveredPathCancelled:
    'The worker stopped and the document was recovered. The path edit in progress was cancelled.',
  recoveredParagraphReopened:
    'The worker stopped and the document was recovered. The paragraph being edited was reopened.',
  recoveredHistoryLost:
    'The worker stopped and the document was recovered. Undo history from before the recovery is lost.',
  restartAfterRecoveryFailed: 'Could not resume editing after recovery',
  pathPlanFailed: 'Could not check the path',
  pathStartFailed: 'Could not start the path edit',
  pathApplyFailed: 'Could not apply the path edit',
  pathRecoveredReselect: 'The document was recovered. Select the path again.',
};

export const VIEWER_STRINGS: Readonly<Record<UiLang, ViewerStrings>> = { ko: KO, en: EN };
