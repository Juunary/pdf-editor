// 빌드 종류별 매니페스트(docs/m5-contract.md D6·D7). 기준은 apps/extension/manifest.json(개발·레거시 형태)이다.
// - dev:   Chrome 128 이상. mimeHandler 가 있으면 그 경로, 없으면 DNR 폴백(권한·호스트 권한·WAR 유지). dist/ 용
// - store: Chrome Web Store 용. Chrome 151 이상(mimeHandler 공식 지원). DNR 권한·호스트 권한·`<all_urls>` WAR 제거
// 버전은 apps/extension/package.json 의 version 한 곳에서 온다.

/** AGPL 소스 링크의 기준(뷰어 정보 대화상자·THIRD_PARTY_NOTICES). 버전 링크는 `${REPO_URL}/tree/v<version>`. */
export const REPO_URL = 'https://github.com/Juunary/pdf-editor';
export const sourceUrl = (version) => `${REPO_URL}/tree/v${version}`;

export const BUILD_KINDS = ['dev', 'store'];
export const STORE_MIN_CHROME = '151';
export const DEV_NAME_SUFFIX = ' (dev)';

/** 스토어 빌드에서 제거하는 DNR 폴백용 권한. */
const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'];

/**
 * @param {Record<string, unknown>} base apps/extension/manifest.json 내용
 * @param {'dev' | 'store'} kind
 * @param {string} version package.json 의 version
 */
export function buildManifest(base, kind, version) {
  if (!BUILD_KINDS.includes(kind)) throw new Error(`알 수 없는 빌드 종류: ${kind}`);
  const manifest = structuredClone(base);
  manifest.version = version;
  if (kind === 'dev') {
    manifest.name = `${base.name}${DEV_NAME_SUFFIX}`;
    return manifest;
  }
  manifest.minimum_chrome_version = STORE_MIN_CHROME;
  manifest.permissions = (base.permissions ?? []).filter((p) => !DNR_PERMISSIONS.includes(p));
  delete manifest.host_permissions;
  delete manifest.web_accessible_resources;
  return manifest;
}
