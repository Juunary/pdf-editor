/**
 * Viewer UI string tables (Korean and English, user request 2026-10-23). The language is decided by the caller (the extension) and passed in through `ViewerControllerOptions.strings`.
 * Korean if not passed. viewer-ui does not use the extension API (`chrome.i18n`) (so it works as is in the harness and Node tests).
 *
 * Scope: toolbar controls (page navigation, find, layout and edit buttons), search bar, page arrows, toolbar edit notices (2026-10-23), edit UI over the page (editor,
 * non-editable popover, path panel, editability overlay legend, tooltips, tagged notice, edited-page record notice, in-editor recovery notice), edit-limit reasons
 * (30 kinds), edit warnings and error details (2026-10-26). Development displays (the link debug overlay and HUD, `debug-info.ts`) are Korean only.
 */
import type { FeatureName } from './controller.js';
import { errorDetailEn, errorMessage } from './error-text.js';
import {
  EDIT_PAGES_NOTICE,
  LIMIT_LABELS,
  LIMIT_LABELS_EN,
  REDO_DISCARDED_NOTICE,
  TAGGED_BLOCKED_LABEL,
  TAGGED_NOTICE,
  WARNING_TEXTS_EN,
  WARNING_TEXTS_KO,
  type LimitReason,
  type WarningText,
  type WarningTextKey,
} from './labels-data.js';

export type UiLang = 'ko' | 'en';

/**
 * The UI language is decided from the language tag (BCP 47, `chrome.i18n.getUILanguage()`, `navigator.language`). Looks at the first
 * non-empty tag from the front: Korean if the primary language is ko, English otherwise (including no tag).
 */
export function resolveUiLang(...tags: (string | null | undefined)[]): UiLang {
  const tag = tags.find((t) => typeof t === 'string' && t.trim() !== '');
  const primary = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary === 'ko' ? 'ko' : 'en';
}

export interface ViewerStrings {
  lang: UiLang;
  /** Name of the toolbar control group (role=toolbar). */
  controlsLabel: string;
  prevPage: string;
  nextPage: string;
  pageNumber: string;
  /** "/ N" after the page number input. */
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
  /** Editability overlay reason for a host without edit RPCs. */
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
  /** The "비활성: 기능, 기능" text (disabled: feature, feature). */
  disabledList(features: string): string;
  featureLabels: Record<FeatureName, string>;
  // Search bar
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
  // Toolbar edit notices (#pe-edit-notice)
  failureWith(prefix: string, message: string): string;
  editStartFailed: string;
  editSaveFailed: string;
  editCancelFailed: string;
  undoFailed: string;
  redoFailed: string;
  editNotApplied(error: string): string;
  /** Notice that starting a new edit after undoing cleared the redo history (contract D9). */
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
  // Error details (after the colon). Korean uses the message as is; English uses error-text.ts.
  errorDetail(error: unknown): string;
  // Edit-limit reasons and warnings (chosen by edit-labels.ts)
  limitLabels: Record<LimitReason, string>;
  /** Reason code not in the table. */
  limitUnknown(reason: string): string;
  warningTexts: Record<WarningTextKey, WarningText>;
  // Non-editable popover (EditEntry.tsx)
  paragraphNotEditableTitle: string;
  cellNotEditableTitle: string;
  /** One list line when there is no reason. */
  paragraphNotEditable: string;
  popoverClose: string;
  taggedBlocked: string;
  // Editor (EditorLayer.tsx)
  editorLabel: string;
  glyphMissingTitle: string;
  overflowMessage: string;
  revert: string;
  revertTitle: string;
  committingNotice: string;
  previewFailed(error: string): string;
  editWarningsLabel: string;
  taggedNotice: string;
  editPagesNotice: string;
  /** In-editor recovery notice (restart the draft after recovery). */
  sessionRecovered: string;
  sessionClosed: string;
  restartNotEditable: string;
  // Path panel (PathLayer.tsx)
  pathsSelected(count: number): string;
  pathNotEditable: string;
  fillColor: string;
  strokeColor: string;
  lineWidth: string;
  pointEdit: string;
  pointEditTitle: string;
  pointEditNeedsOne: string;
  deletePath: string;
  deletePathTitle: string;
  clearSelection: string;
  // Editability overlay legend and tooltips (EditableMarks.tsx, edit-marks.ts)
  legendEditable: string;
  legendLimited: string;
  legendLines: string;
  legendLayout: string;
  legendSkipped(count: number): string;
  markKinds: { paragraph: string; cell: string; path: string };
  markEditable(kind: string): string;
  markLimited(kind: string, reasons: string): string;
  markNoReason: string;
  // Page surface
  pageRenderFailed(error: string): string;
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
  errorDetail: errorMessage,
  limitLabels: LIMIT_LABELS,
  limitUnknown: (r) => `편집할 수 없습니다 (${r})`,
  warningTexts: WARNING_TEXTS_KO,
  paragraphNotEditableTitle: '이 문단은 편집할 수 없습니다',
  cellNotEditableTitle: '이 셀은 편집할 수 없습니다',
  paragraphNotEditable: '이 문단은 편집할 수 없습니다.',
  popoverClose: '닫기',
  taggedBlocked: TAGGED_BLOCKED_LABEL,
  editorLabel: '문단 편집',
  glyphMissingTitle: '원본·폴백 글꼴 모두 이 글자의 글리프가 없어 쓰지 않습니다',
  overflowMessage: '영역을 넘었습니다(쪽·개체 경계까지 넓혀도 들어가지 않습니다)',
  revert: '되돌리기',
  revertTitle: '이번 편집을 버리고 편집을 시작하기 전 상태로 되돌립니다',
  committingNotice: '편집을 반영하는 중입니다. 끝날 때까지 입력은 받지 않습니다.',
  previewFailed: (e) => `미리보기 갱신 실패: ${e}`,
  editWarningsLabel: '편집 경고',
  taggedNotice: TAGGED_NOTICE,
  editPagesNotice: EDIT_PAGES_NOTICE,
  sessionRecovered:
    '작업 모듈이 중단되어 문서를 복구했습니다. 편집 중이던 문단을 다시 열었고, 복구 전 되돌리기 이력은 사라졌습니다.',
  sessionClosed: '편집 세션이 닫혔습니다',
  restartNotEditable: '복구 뒤 같은 문단을 다시 편집할 수 없습니다',
  pathsSelected: (n) => `패스 ${n}개 선택`,
  pathNotEditable: '이 패스는 편집할 수 없습니다.',
  fillColor: '채움 색',
  strokeColor: '선 색',
  lineWidth: '선 두께(pt)',
  pointEdit: '점 편집',
  pointEditTitle: '꼭짓점·제어점을 끌어 옮깁니다(패스 하나)',
  pointEditNeedsOne: '패스 하나를 선택하면 점 편집을 할 수 있습니다',
  deletePath: '삭제',
  deletePathTitle: '선택한 패스를 지웁니다 (Delete)',
  clearSelection: '선택 해제',
  legendEditable: '편집 가능',
  legendLimited: '제한(점선)',
  legendLines: '굵은 선 = 문단·표 셀, 가는 선 = 패스',
  legendLayout: '레이아웃(색 = 역할, 번호 = 읽기 순서)',
  legendSkipped: (n) => `패스 ${n}개 생략`,
  markKinds: { paragraph: '문단', cell: '표 셀', path: '패스' },
  markEditable: (k) => `${k} · 편집 가능`,
  markLimited: (k, r) => `${k} · 제한: ${r}`,
  markNoReason: '편집할 수 없습니다',
  pageRenderFailed: (e) => `페이지를 그리지 못했습니다: ${e}`,
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
  errorDetail: errorDetailEn,
  limitLabels: LIMIT_LABELS_EN,
  limitUnknown: (r) => `Cannot be edited (${r})`,
  warningTexts: WARNING_TEXTS_EN,
  paragraphNotEditableTitle: 'This paragraph cannot be edited',
  cellNotEditableTitle: 'This cell cannot be edited',
  paragraphNotEditable: 'This paragraph cannot be edited.',
  popoverClose: 'Close',
  taggedBlocked: 'This paragraph is not edited because "Block tagged PDF edits" is turned on.',
  editorLabel: 'Paragraph editor',
  glyphMissingTitle:
    'Not drawn: neither the original nor the fallback font has a glyph for this character',
  overflowMessage:
    'The text does not fit (even when the area is widened to the page or object boundary)',
  revert: 'Revert',
  revertTitle: 'Discard this edit and return to the state before editing started',
  committingNotice: 'Applying the edit. Typing is paused until it finishes.',
  previewFailed: (e) => `Preview update failed: ${e}`,
  editWarningsLabel: 'Edit warnings',
  taggedNotice: 'This is a tagged PDF. The structure (reading order, tags) is not updated.',
  editPagesNotice: 'Saving records the edited page numbers in the file info (PdfEditorEdits).',
  sessionRecovered:
    'The worker stopped and the document was recovered. The paragraph being edited was reopened; undo history from before the recovery is lost.',
  sessionClosed: 'The edit session was closed',
  restartNotEditable: 'The same paragraph cannot be edited again after recovery',
  pathsSelected: (n) => (n === 1 ? '1 path selected' : `${n} paths selected`),
  pathNotEditable: 'This path cannot be edited.',
  fillColor: 'Fill color',
  strokeColor: 'Stroke color',
  lineWidth: 'Line width (pt)',
  pointEdit: 'Edit points',
  pointEditTitle: 'Drag vertices and control points (one path)',
  pointEditNeedsOne: 'Select a single path to edit its points',
  deletePath: 'Delete',
  deletePathTitle: 'Delete the selected paths (Delete)',
  clearSelection: 'Clear selection',
  legendEditable: 'Editable',
  legendLimited: 'Restricted (dotted)',
  legendLines: 'Thick line = paragraph or table cell, thin line = path',
  legendLayout: 'Layout (color = role, number = reading order)',
  legendSkipped: (n) => `${n} path(s) omitted`,
  markKinds: { paragraph: 'Paragraph', cell: 'Table cell', path: 'Path' },
  markEditable: (k) => `${k} · Editable`,
  markLimited: (k, r) => `${k} · Restricted: ${r}`,
  markNoReason: 'Cannot be edited',
  pageRenderFailed: (e) => `Could not draw the page: ${e}`,
};

export const VIEWER_STRINGS: Readonly<Record<UiLang, ViewerStrings>> = { ko: KO, en: EN };
