import { extractFileParam } from '../interception.js';

/**
 * 뷰어가 열린 문맥. FSA 가용성 검증(PLAN.md 5.3)을 이 구분으로 기록한다.
 * - mime-handler-top / mime-handler-embedded: Chrome 150+ MIME handler 가 띄운 경우
 * - url-param: DNR 폴백 리다이렉트 또는 `viewer.html?file=` 직접 접근
 * - viewer-page: 확장 페이지로 직접 연 경우(로컬 파일 선택)
 */
export type ViewerContextKind =
  'mime-handler-top' | 'mime-handler-embedded' | 'url-param' | 'viewer-page';

export interface ViewerSource {
  kind: ViewerContextKind;
  /** 표시용 URL. MIME handler 에서는 originalUrl(재요청 금지). */
  displayUrl: string | null;
  bytes: ArrayBuffer | null;
  streamInfo: chrome.mimeHandler.StreamInfo | null;
  fetchMs: number;
}

export interface SourceEnv {
  href: string;
  mimeHandler: Pick<typeof chrome.mimeHandler, 'getStreamInfo'> | undefined;
  fetch: typeof fetch;
  now: () => number;
  /** 문맥을 정한 직후(PDF 바이트를 받기 전) 부른다. 머리 영역 확대 보정이 문서 수신을 기다리지 않게 한다. */
  onContext?(kind: ViewerContextKind, streamInfo: chrome.mimeHandler.StreamInfo | null): void;
}

async function readAll(env: SourceEnv, url: string, init?: RequestInit): Promise<ArrayBuffer> {
  const res = await env.fetch(url, init);
  if (!res.ok && res.status !== 0) throw new Error(`PDF 요청 실패: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * 문맥을 판정하고 PDF 바이트를 받는다.
 * MIME handler 문맥에서는 `streamUrl` 을 정확히 한 번 fetch 해 전체를 읽고, `originalUrl` 은
 * 다시 요청하지 않는다(PLAN.md 5.1).
 */
export async function resolveViewerSource(env: SourceEnv): Promise<ViewerSource> {
  if (env.mimeHandler) {
    let info: chrome.mimeHandler.StreamInfo | null = null;
    try {
      info = await env.mimeHandler.getStreamInfo();
    } catch {
      // MIME handler 가 띄운 페이지가 아니면 실패한다 → 다른 문맥으로 판정.
    }
    if (info) {
      const kind = info.embedded ? 'mime-handler-embedded' : 'mime-handler-top';
      env.onContext?.(kind, info);
      const t0 = env.now();
      const bytes = await readAll(env, info.streamUrl);
      return {
        kind,
        displayUrl: info.originalUrl,
        bytes,
        streamInfo: info,
        fetchMs: env.now() - t0,
      };
    }
  }

  const fileUrl = extractFileParam(env.href);
  if (fileUrl) {
    env.onContext?.('url-param', null);
    const t0 = env.now();
    const bytes = await readAll(env, fileUrl, { credentials: 'include' });
    return {
      kind: 'url-param',
      displayUrl: fileUrl,
      bytes,
      streamInfo: null,
      fetchMs: env.now() - t0,
    };
  }

  env.onContext?.('viewer-page', null);
  return { kind: 'viewer-page', displayUrl: null, bytes: null, streamInfo: null, fetchMs: 0 };
}
