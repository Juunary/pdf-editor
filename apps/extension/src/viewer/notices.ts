/** 뷰어 알림(문서 열기 직후 보고·안내) 문구 구성(순수). 표시는 main.ts 의 알림 줄이 한다. */

export interface RedactReportLike {
  total: number;
  /** Redact 주석이 있는 쪽(0부터). */
  pages: number[];
}

/** 열기 시 Redact 주석 보고(A2-2): 적용 대기 중인 가림 표시가 있다는 안내. 없으면 null. */
export function redactNotice(report: RedactReportLike | null): string | null {
  if (!report || report.total <= 0) return null;
  const pages = report.pages.map((p) => p + 1).join(', ');
  return `이 문서에는 적용되지 않은 Redact(가림) 주석 ${report.total}개가 있습니다(${pages}쪽). 이 뷰어는 적용하지 않으며, 저장 후에도 표시로 남습니다.`;
}

export interface FileAccessInput {
  /** 가로채기 방식: MIME handler 는 file:// 접근 설정과 무관하다. */
  mode: 'mime-handler' | 'dnr-fallback' | 'unsupported';
  /** `chrome.extension.isAllowedFileSchemeAccess()` 결과. 알 수 없으면 null. */
  fileAccessAllowed: boolean | null;
  /** 열린 문서의 표시 URL(없으면 null: 직접 연 뷰어). */
  displayUrl: string | null;
  extensionId: string;
}

/**
 * DNR 폴백(Chrome 128–149)은 file:// PDF 를 "파일 URL에 대한 액세스 허용" 이 켜져 있어야 가로챈다(A5-3, 코퍼스 C10).
 * 꺼져 있으면 file:// PDF 는 Chrome 기본 뷰어로 열리므로, 이 뷰어에서 안내한다.
 * 직접 연 뷰어이거나 file:// 문서를 열 때 보여 준다. 해당 없으면 null.
 */
export function fileAccessNotice(input: FileAccessInput): string | null {
  if (input.mode !== 'dnr-fallback' || input.fileAccessAllowed !== false) return null;
  if (input.displayUrl !== null && !input.displayUrl.startsWith('file:')) return null;
  return `로컬 파일(file://) PDF 를 이 뷰어로 자동으로 열려면 chrome://extensions/?id=${input.extensionId} 에서 "파일 URL에 대한 액세스 허용" 을 켜세요. 꺼져 있으면 로컬 PDF 는 Chrome 기본 뷰어로 열립니다.`;
}
