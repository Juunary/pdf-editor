// Extension service worker: only handles syncing the interception path (registering/removing the DNR fallback) and the toolbar button.
// MuPDF and document state live in the viewer-owned Worker (PLAN.md 5.2).
import {
  buildPdfFallbackRules,
  decideInterceptionMode,
  DNR_RULE_IDS,
  parseChromeMajor,
} from './interception.js';

async function syncInterception(): Promise<void> {
  // The Web Store build (Chrome 151+) has no DNR permission. It uses only the MIME handler, so it does not manage fallback rules.
  if (!chrome.declarativeNetRequest) {
    console.info('[pdf-editor] interception mode = mime-handler (DNR 권한 없는 빌드)');
    return;
  }
  const mode = decideInterceptionMode({
    hasMimeHandlerApi: 'mimeHandler' in chrome && chrome.mimeHandler !== undefined,
    chromeMajor: parseChromeMajor(navigator.userAgent),
  });
  const addRules =
    mode === 'dnr-fallback' ? buildPdfFallbackRules(chrome.runtime.getURL('viewer.html')) : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: Object.values(DNR_RULE_IDS),
    addRules,
  });
  console.info(`[pdf-editor] interception mode = ${mode}, dynamic rules = ${addRules.length}`);
}

chrome.runtime.onInstalled.addListener(() => void syncInterception());
chrome.runtime.onStartup.addListener(() => void syncInterception());

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});
