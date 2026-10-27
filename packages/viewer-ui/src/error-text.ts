/**
 * 오류 상세(상태 줄·알림·편집기 오류 줄의 콜론 뒤)를 화면 언어로 만든다(사용자 결정 2026-10-26).
 *
 * Worker·core·확장 복구 계층이 내는 예외 메시지는 한국어 진단 문장이다(core 예외만 80여 곳). 예외를 모두 코드로 바꾸는 대신
 * 한국어 화면은 메시지를 그대로 쓰고, 영어 화면은 (1) 오류 이름(`Error.name`, Comlink 가 Worker 예외의 name 을 그대로 옮김)
 * (2) 알려진 메시지 형태 표 (3) 한글이 없는 메시지(MuPDF·브라우저 영어 오류)는 그대로 (4) 그 밖은 일반 문장 순으로 고른다.
 * 원래 메시지는 호출자가 진단 기록에 남긴다.
 */

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

/** 오류 이름 → 영어 문장. */
const EN_BY_NAME: Readonly<Record<string, string>> = {
  WorkerRecoveredError: 'The worker stopped and the document was recovered.',
  RecoveryFailedError: 'Could not recover the document. Reopen the file.',
  StaleRevisionError: 'The document changed. Try again.',
  PathTargetChangedError:
    'The document changed and the selected path is different. Select the path again.',
};

/** 알려진 한국어 메시지 형태 → 영어 문장(앞에서부터 처음 맞는 것). */
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

/** 오류 → 메시지(classifyFailure 와 같은 규칙). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
}

function errorName(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  // 이미 글자로 바뀐 오류("이름: 메시지", String(e)·저장 결과)
  return typeof error === 'string' ? (/^(\w+Error):/.exec(error)?.[1] ?? null) : null;
}

/** 영어 화면의 오류 상세. */
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
