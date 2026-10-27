import { extractFileParam } from '../interception.js';

/**
 * The context in which the viewer was opened. FSA availability verification (PLAN.md 5.3) is recorded by this distinction.
 * - mime-handler-top / mime-handler-embedded: launched by the Chrome 150+ MIME handler
 * - url-param: DNR fallback redirect or direct access to `viewer.html?file=`
 * - viewer-page: opened directly as an extension page (local file selection)
 */
export type ViewerContextKind =
  'mime-handler-top' | 'mime-handler-embedded' | 'url-param' | 'viewer-page';

export interface ViewerSource {
  kind: ViewerContextKind;
  /** URL for display. For the MIME handler this is originalUrl (do not re-request). */
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
  /** Called right after the context is decided (before the PDF bytes arrive). Keeps header zoom compensation from waiting for the document. */
  onContext?(kind: ViewerContextKind, streamInfo: chrome.mimeHandler.StreamInfo | null): void;
}

/** PDF request failure (HTTP status). The on-screen sentence is built from the name and status (viewer-ui error-text.ts, user decision 2026-10-26). */
export class PdfRequestError extends Error {
  constructor(readonly status: number) {
    super(`PDF 요청 실패: HTTP ${status}`);
    this.name = 'PdfRequestError';
  }
}

async function readAll(env: SourceEnv, url: string, init?: RequestInit): Promise<ArrayBuffer> {
  const res = await env.fetch(url, init);
  if (!res.ok && res.status !== 0) throw new PdfRequestError(res.status);
  return res.arrayBuffer();
}

/**
 * Decides the context and fetches the PDF bytes.
 * In the MIME handler context, fetches `streamUrl` exactly once and reads it entirely, and does
 * not request `originalUrl` again (PLAN.md 5.1).
 */
export async function resolveViewerSource(env: SourceEnv): Promise<ViewerSource> {
  if (env.mimeHandler) {
    let info: chrome.mimeHandler.StreamInfo | null = null;
    try {
      info = await env.mimeHandler.getStreamInfo();
    } catch {
      // Fails unless the page was launched by the MIME handler → classify as another context.
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
