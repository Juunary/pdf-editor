/**
 * Builds the error detail (after the colon in the status line, notices and the editor error line) in the display language (user decision 2026-10-26).
 *
 * Exception messages produced by the Worker, core and the extension recovery layer are Korean diagnostic sentences (core exceptions alone number 80 or so). Instead of converting every exception to a code,
 * the Korean UI uses the message as is, and the English UI chooses in this order: (1) the error name (`Error.name`, which Comlink carries over from the Worker exception unchanged)
 * (2) the table of known message shapes (3) messages without Hangul (MuPDF/browser English errors) as is (4) anything else gets a generic sentence.
 * The caller records the original message in the diagnostic log.
 */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** Error name → English sentence. */
const EN_BY_NAME: Readonly<Record<string, string>> = {
  WorkerRecoveredError: 'The worker stopped and the document was recovered.',
  RecoveryFailedError: 'Could not recover the document. Reopen the file.',
  StaleRevisionError: 'The document changed. Try again.',
  PathTargetChangedError:
    'The document changed and the selected path is different. Select the path again.',
};

/** Known Korean message shapes → English sentence (the first match from the top). */
const EN_PATTERNS: readonly [RegExp, string | ((m: RegExpExecArray) => string)][] = [
  [/PDF 요청 실패: HTTP (\d+)/, (m) => `PDF request failed: HTTP ${m[1]}`],
  [
    /폴백 폰트를 받지 못했습니다: HTTP (\d+)/,
    (m) => `Could not load the fallback font: HTTP ${m[1]}`,
  ],
  [/문서를 복구하지 못했습니다/, EN_BY_NAME.RecoveryFailedError!],
  [/작업 모듈이 (중단|복구)/, EN_BY_NAME.WorkerRecoveredError!],
  [
    /편집 초안이 열려 있어 저장할 수 없습니다/,
    'An edit is still open, so the document cannot be saved. Finish or cancel the edit first.',
  ],
  [/초안이 손상되어/, 'The edit draft is damaged. Cancel the edit.'],
  [/문서를 다시 열어야 합니다/, 'The edit engine stopped working. Reopen the document.'],
  [/편집할 수 없는 문단입니다/, 'This paragraph cannot be edited.'],
  [/편집할 수 없는 패스입니다/, 'This path cannot be edited.'],
  [/적용된 변경이 없어 커밋할 수 없습니다/, 'There are no changes to apply. Cancel the edit.'],
  [/선택한 패스가 달라졌습니다/, EN_BY_NAME.PathTargetChangedError!],
  [/문서가 바뀌었습니다/, EN_BY_NAME.StaleRevisionError!],
  [/문서가 닫혔습니다/, 'The document was closed.'],
  [/열린 문서 없음/, 'No document is open.'],
  [/PDF 문서가 아님/, 'Not a PDF document.'],
  [/첫 페이지 렌더 실패/, 'Could not render the first page.'],
  [/Worker (메시지 )?오류/, 'Worker error.'],
  [/미구현/, 'not implemented in this build'],
];

const EN_GENERIC = 'An internal error occurred.';

/** Error → message (same rule as classifyFailure). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
}

function errorName(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  // An error that has already been turned into text ("name: message", String(e), save result)
  return typeof error === 'string' ? (/^(\w+Error):/.exec(error)?.[1] ?? null) : null;
}

/** Error detail for the English UI. */
export function errorDetailEn(error: unknown): string {
  const byName = EN_BY_NAME[errorName(error) ?? ''];
  if (byName) return byName;
  const message = errorMessage(error);
  for (const [re, out] of EN_PATTERNS) {
    const m = re.exec(message);
    if (m) return typeof out === 'string' ? out : out(m);
  }
  return HANGUL.test(message) ? EN_GENERIC : message;
}
