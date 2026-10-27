/**
 * PDF interception path decision and DNR fallback rules for Chrome 128–150 (PLAN.md 5.1).
 *
 * - Chrome 150+: manifest `mime_types_handler` → `chrome.mimeHandler` (v1 baseline path. API measured on Chrome for Testing
 *   150.0.7871.0 or later, 2026-10-19)
 * - Chrome 128–149: `declarativeNetRequest` response-header conditional redirect (limited path, not guaranteed)
 *   · The original request has already gone out to the server, and Chrome makes a new request to the redirect URL.
 *     The viewer re-fetches the original URL, so POST-generated PDFs and one-time URLs may fail.
 * - Below 128: unsupported
 *
 * Rules are registered as dynamic rules, not as a static ruleset. regexSubstitution needs a viewer URL containing the
 * extension ID, and when a MIME handler exists no rules are kept at all, so they never run ahead of it.
 * The path is decided by the presence of `chrome.mimeHandler`, not by version (the constants are for docs and diagnostics).
 */

export type InterceptionMode = 'mime-handler' | 'dnr-fallback' | 'unsupported';

export const DNR_MIN_CHROME = 128;
export const MIME_HANDLER_MIN_CHROME = 150;

/** Dynamic rule IDs owned by this extension. Only this list is touched on register/remove. */
export const DNR_RULE_IDS = { http: 1001, file: 1002 } as const;

export function parseChromeMajor(userAgent: string): number | null {
  const m = /Chrom(?:e|ium)\/(\d+)\./.exec(userAgent);
  return m?.[1] ? Number(m[1]) : null;
}

export function decideInterceptionMode(env: {
  hasMimeHandlerApi: boolean;
  chromeMajor: number | null;
}): InterceptionMode {
  if (env.hasMimeHandlerApi) return 'mime-handler';
  if (env.chromeMajor !== null && env.chromeMajor >= DNR_MIN_CHROME) return 'dnr-fallback';
  return 'unsupported';
}

/** Redirect target: `viewer.html?file=<original URL as is>`. The original URL is not encoded. */
export function buildPdfFallbackRules(viewerUrl: string): chrome.declarativeNetRequest.Rule[] {
  const action = { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl}?file=\\0` } };
  // object: PDFs embedded via <embed>/<object> (A5-2). With only main_frame and sub_frame, only iframes would be intercepted.
  const resourceTypes = ['main_frame', 'sub_frame', 'object'];
  const rules = [
    {
      id: DNR_RULE_IDS.http,
      priority: 1,
      action,
      condition: {
        regexFilter: '^https?://.*',
        resourceTypes,
        // GET only: after the redirect the viewer fetches again with GET.
        requestMethods: ['get'],
        responseHeaders: [
          { header: 'content-type', values: ['application/pdf', 'application/pdf;*'] },
        ],
        // PDFs served as a download are not intercepted.
        excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
    },
    {
      // file:// has no response headers, so classify by extension. Whether this works is an M0 verification item
      // (including whether "파일 URL에 대한 액세스 허용" (Allow access to file URLs) is required). Specifying requestMethods would
      // exclude non-HTTP requests, so it is left out.
      id: DNR_RULE_IDS.file,
      priority: 1,
      action,
      condition: {
        regexFilter: '^file://.*\\.pdf$',
        isUrlFilterCaseSensitive: false,
        resourceTypes,
      },
    },
  ];
  // The DNR enums in @types/chrome are ambient enums, so they have no values outside Chrome (in unit tests).
  // Build them as string literals and match only the types.
  return rules as unknown as chrome.declarativeNetRequest.Rule[];
}

/**
 * Extracts the original URL from `viewer.html?file=...`. regexSubstitution does not encode,
 * so use everything after the first `?file=` instead of URLSearchParams (preserves `&` and `?` of the original URL).
 * For the direct-open case, the percent-encoded `http%3A...` form is also accepted.
 */
export function extractFileParam(href: string): string | null {
  const marker = '?file=';
  const i = href.indexOf(marker);
  if (i < 0) return null;
  const raw = href.slice(i + marker.length);
  if (raw === '') return null;
  if (/^(https?|file):/i.test(raw)) return raw;
  try {
    const decoded = decodeURIComponent(raw);
    return /^(https?|file):/i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
