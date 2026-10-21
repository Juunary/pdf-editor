// 확장 서비스 워커: 가로채기 경로 동기화(DNR 폴백 등록/해제)와 툴바 버튼만 담당한다.
// MuPDF·문서 상태는 뷰어 소유 Worker 에 있다(PLAN.md 5.2).
import {
  buildPdfFallbackRules,
  decideInterceptionMode,
  DNR_RULE_IDS,
  parseChromeMajor,
} from './interception.js';

async function syncInterception(): Promise<void> {
  // Web Store 빌드(Chrome 151+)는 DNR 권한이 없다. MIME handler 만 쓰므로 폴백 규칙을 관리하지 않는다.
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
