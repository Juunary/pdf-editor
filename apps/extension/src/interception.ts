/**
 * PDF 가로채기 경로 결정과 Chrome 128–150 용 DNR 폴백 규칙(PLAN.md 5.1).
 *
 * - Chrome 150+: manifest `mime_types_handler` → `chrome.mimeHandler` (v1 기준 경로. Chrome for Testing
 *   150.0.7871.0 이상에서 API 실측, 2026-10-19)
 * - Chrome 128–149: `declarativeNetRequest` 응답 헤더 조건 리다이렉트(제한적 경로, 보장 아님)
 *   · 원 요청은 이미 서버로 나간 뒤이고, Chrome 이 리다이렉트 URL 로 새 요청을 만든다.
 *     뷰어는 원 URL 을 다시 fetch 하므로 POST 생성 PDF·일회성 URL 은 실패할 수 있다.
 * - 128 미만: 미지원
 *
 * 규칙은 정적 ruleset 이 아니라 dynamic rule 로 등록한다. regexSubstitution 에 확장 ID 가 든
 * 뷰어 URL 이 필요하고, MIME handler 가 있으면 규칙이 그보다 먼저 동작하지 않도록 아예 두지 않는다.
 * 경로 판정은 버전이 아니라 `chrome.mimeHandler` 유무로 한다(상수는 문서·진단용).
 */

export type InterceptionMode = 'mime-handler' | 'dnr-fallback' | 'unsupported';

export const DNR_MIN_CHROME = 128;
export const MIME_HANDLER_MIN_CHROME = 150;

/** 이 확장이 소유하는 dynamic rule ID. 등록·해제 시 이 목록만 건드린다. */
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

/** 리다이렉트 대상: `viewer.html?file=<원 URL 그대로>`. 원 URL 은 인코딩하지 않는다. */
export function buildPdfFallbackRules(viewerUrl: string): chrome.declarativeNetRequest.Rule[] {
  const action = { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl}?file=\\0` } };
  // object: <embed>·<object> 로 넣은 PDF(A5-2). main_frame·sub_frame 만이면 iframe 만 가로챈다.
  const resourceTypes = ['main_frame', 'sub_frame', 'object'];
  const rules = [
    {
      id: DNR_RULE_IDS.http,
      priority: 1,
      action,
      condition: {
        regexFilter: '^https?://.*',
        resourceTypes,
        // GET 만: 리다이렉트 후 뷰어가 GET 으로 다시 받기 때문이다.
        requestMethods: ['get'],
        responseHeaders: [
          { header: 'content-type', values: ['application/pdf', 'application/pdf;*'] },
        ],
        // 다운로드로 내려주는 PDF 는 가로채지 않는다.
        excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
    },
    {
      // file:// 은 응답 헤더가 없으므로 확장자로 판정한다. 동작 여부는 M0 검증 항목
      // ("파일 URL에 대한 액세스 허용" 필요 여부 포함). requestMethods 를 지정하면
      // 비 HTTP 요청이 제외되므로 넣지 않는다.
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
  // @types/chrome 의 DNR 열거형은 ambient enum 이라 Chrome 밖(단위 테스트)에서는 값이 없다.
  // 문자열 리터럴로 만들고 타입만 맞춘다.
  return rules as unknown as chrome.declarativeNetRequest.Rule[];
}

/**
 * `viewer.html?file=...` 에서 원 URL 을 꺼낸다. regexSubstitution 은 인코딩하지 않으므로
 * URLSearchParams 대신 첫 `?file=` 뒤 전체를 쓴다(원 URL 의 `&`, `?` 보존).
 * 직접 연 경우를 위해 퍼센트 인코딩된 `http%3A...` 형태도 허용한다.
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
