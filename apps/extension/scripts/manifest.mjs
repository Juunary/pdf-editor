// Per-build-kind manifests (docs/m5-contract.md D6, D7). The baseline is apps/extension/manifest.json (the dev/legacy form).
// - dev:   Chrome 128 or later. Uses the mimeHandler path if present, otherwise the DNR fallback (keeps permissions, host permissions and WAR). For dist/
// - store: For the Chrome Web Store. Chrome 151 or later (official mimeHandler support). Removes DNR permissions, host permissions and the `<all_urls>` WAR
// The version comes from a single place, the version field of apps/extension/package.json.
// Name, description and toolbar title point to apps/extension/_locales/{en,ko}/messages.json via `__MSG_…__` (default en, user decision
// 2026-10-26). The dev build's " (dev)" is appended not to the manifest but to appName in the messages.json emitted by the build.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Base of the AGPL source link (viewer About dialog, THIRD_PARTY_NOTICES). The version link is `${REPO_URL}/tree/v<version>`. */
export const REPO_URL = 'https://github.com/Juunary/pdf-editor';
export const sourceUrl = (version) => `${REPO_URL}/tree/v${version}`;

export const BUILD_KINDS = ['dev', 'store'];
export const STORE_MIN_CHROME = '151';
export const DEV_NAME_SUFFIX = ' (dev)';
/** Store listing name (same for all languages). */
export const STORE_NAME = 'PDF Editor';
export const DEFAULT_LOCALE = 'en';
export const LOCALES = ['en', 'ko'];
/** Upper limit (in characters) for the Chrome manifest / Web Store short description. */
export const MAX_DESCRIPTION_CHARS = 132;
/** Name message key (`__MSG_appName__`). */
export const NAME_MESSAGE = 'appName';

/** DNR fallback permissions removed in the store build. */
const DNR_PERMISSIONS = ['declarativeNetRequest', 'declarativeNetRequestWithHostAccess'];

/**
 * @param {Record<string, unknown>} base contents of apps/extension/manifest.json
 * @param {'dev' | 'store'} kind
 * @param {string} version version from package.json
 */
export function buildManifest(base, kind, version) {
  if (!BUILD_KINDS.includes(kind)) throw new Error(`알 수 없는 빌드 종류: ${kind}`);
  const manifest = structuredClone(base);
  manifest.version = version;
  if (kind === 'dev') {
    // If the name is a message reference, leave it as is and append the suffix in messages.json (buildLocaleMessages).
    if (messageKey(base.name) === null) manifest.name = `${base.name}${DEV_NAME_SUFFIX}`;
    return manifest;
  }
  manifest.minimum_chrome_version = STORE_MIN_CHROME;
  manifest.permissions = (base.permissions ?? []).filter((p) => !DNR_PERMISSIONS.includes(p));
  delete manifest.host_permissions;
  delete manifest.web_accessible_resources;
  return manifest;
}

/** Returns key for `__MSG_key__`, otherwise null. */
export function messageKey(value) {
  const m = typeof value === 'string' ? /^__MSG_(\w+)__$/.exec(value) : null;
  return m ? m[1] : null;
}

/** Resolves a manifest value against one language's messages (key lookup is case-insensitive, per Chrome rules). Returns null if the key is missing. */
export function resolveMessage(value, messages) {
  const key = messageKey(value);
  if (key === null) return typeof value === 'string' ? value : null;
  const hit = Object.entries(messages).find(([k]) => k.toLowerCase() === key.toLowerCase());
  return hit ? hit[1].message : null;
}

/** Reads every `_locales/<lang>/messages.json`. */
export function readLocales(dir) {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((lang) => [lang, JSON.parse(readFileSync(join(dir, lang, 'messages.json'), 'utf8'))]),
  );
}

/**
 * Per-build-kind messages.json. The dev build appends " (dev)" to the name (appName) so it is distinguishable in chrome://extensions.
 * @param {Record<string, Record<string, { message: string; description?: string }>>} locales language → messages
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
