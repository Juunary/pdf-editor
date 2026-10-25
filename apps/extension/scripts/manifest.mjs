// 빌드 종류별 매니페스트(docs/m5-contract.md D6·D7). 기준은 apps/extension/manifest.json(개발·레거시 형태)이다.
// - dev:   Chrome 128 이상. mimeHandler 가 있으면 그 경로, 없으면 DNR 폴백(권한·호스트 권한·WAR 유지). dist/ 용
// - store: Chrome Web Store 용. Chrome 151 이상(mimeHandler 공식 지원). DNR 권한·호스트 권한·`<all_urls>` WAR 제거
// 버전은 apps/extension/package.json 의 version 한 곳에서 온다.
// 이름·설명·툴바 제목은 `__MSG_…__` 로 apps/extension/_locales/{en,ko}/messages.json 을 가리킨다(기본 en, 사용자 결정
// 2026-10-26). 개발 빌드의 " (dev)" 는 매니페스트가 아니라 빌드가 내보내는 messages.json 의 appName 에 붙인다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** AGPL 소스 링크의 기준(뷰어 정보 대화상자·THIRD_PARTY_NOTICES). 버전 링크는 `${REPO_URL}/tree/v<version>`. */
export const REPO_URL = 'https://github.com/Juunary/pdf-editor';
export const sourceUrl = (version) => `${REPO_URL}/tree/v${version}`;

export const BUILD_KINDS = ['dev', 'store'];
export const STORE_MIN_CHROME = '151';
export const DEV_NAME_SUFFIX = ' (dev)';
/** 스토어 등록 이름(모든 언어 같음). */
export const STORE_NAME = 'PDF Editor';
export const DEFAULT_LOCALE = 'en';
export const LOCALES = ['en', 'ko'];
/** Chrome 매니페스트·Web Store 요약 설명 상한(글자 수). */
export const MAX_DESCRIPTION_CHARS = 132;
/** 이름 메시지 키(`__MSG_appName__`). */
export const NAME_MESSAGE = 'appName';

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
    // 이름이 메시지 참조면 그대로 두고 messages.json(buildLocaleMessages)에서 붙인다.
    if (messageKey(base.name) === null) manifest.name = `${base.name}${DEV_NAME_SUFFIX}`;
    return manifest;
  }
  manifest.minimum_chrome_version = STORE_MIN_CHROME;
  manifest.permissions = (base.permissions ?? []).filter((p) => !DNR_PERMISSIONS.includes(p));
  delete manifest.host_permissions;
  delete manifest.web_accessible_resources;
  return manifest;
}

/** `__MSG_key__` 이면 key, 아니면 null. */
export function messageKey(value) {
  const m = typeof value === 'string' ? /^__MSG_(\w+)__$/.exec(value) : null;
  return m ? m[1] : null;
}

/** 매니페스트 값을 한 언어의 messages 로 푼다(키는 대소문자 무시, Chrome 규칙). 없는 키면 null. */
export function resolveMessage(value, messages) {
  const key = messageKey(value);
  if (key === null) return typeof value === 'string' ? value : null;
  const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return hit ? hit[1].message : null;
}

/** `_locales/<lang>/messages.json` 을 모두 읽는다. */
export function readLocales(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((lang) => [lang, JSON.parse(readFileSync(join(dir, lang, 'messages.json'), 'utf8'))]),
  );
}

/**
 * 빌드 종류별 messages.json. dev 는 이름(appName)에 " (dev)" 를 붙여 chrome://extensions 에서 구별되게 한다.
 * @param {Record<string, Record<string, { message: string; description?: string }>>} locales 언어 → messages
 * @param {'dev' | 'store'} kind
 */
export function buildLocaleMessages(locales, kind) {
  if (!BUILD_KINDS.includes(kind)) throw new Error(`알 수 없는 빌드 종류: ${kind}`);
  const out = structuredClone(locales);
  if (kind === 'dev') {
    for (const messages of Object.values(out)) {
      const name = messages[NAME_MESSAGE];
      if (name) name.message = `${name.message}${DEV_NAME_SUFFIX}`;
    }
  }
  return out;
}
