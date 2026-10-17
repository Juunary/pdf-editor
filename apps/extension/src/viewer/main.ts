import { transferBytes, wrapPdfWorker } from '@pdf-editor/core/client';
import { decideInterceptionMode, parseChromeMajor } from '../interception.js';
import { DiagLog } from './diag.js';
import { resolveViewerSource, type ViewerSource } from './source.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
}

const statusEl = byId<HTMLSpanElement>('status');
const badgeEl = byId<HTMLSpanElement>('context-badge');
const openLabel = byId<HTMLLabelElement>('open-label');
const openInput = byId<HTMLInputElement>('open-file');
const diagLogEl = byId<HTMLPreElement>('diag-log');
const canvas = byId<HTMLCanvasElement>('page-canvas');

const diag = new DiagLog((log) => {
  diagLogEl.textContent = log.toJSON();
});
byId<HTMLButtonElement>('copy-diag').addEventListener('click', () => {
  void navigator.clipboard.writeText(diag.toJSON());
});

function setStatus(state: string, text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

const worker = new Worker(new URL('../worker/pdf-worker.ts', import.meta.url), { type: 'module' });
const pdf = wrapPdfWorker(worker);
worker.addEventListener('error', (e) => {
  diag.add('worker-error', e.message || 'Worker 스크립트 로드 실패');
  setStatus('error', `Worker 오류: ${e.message}`);
});

interface UADataLike {
  getHighEntropyValues(hints: string[]): Promise<{
    fullVersionList?: { brand: string; version: string }[];
  }>;
}

async function environmentInfo(): Promise<Record<string, unknown>> {
  const chromeMajor = parseChromeMajor(navigator.userAgent);
  const hasMimeHandlerApi = 'mimeHandler' in chrome && chrome.mimeHandler !== undefined;
  let chromeFullVersion: string | null = null;
  try {
    const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
    const values = await uaData?.getHighEntropyValues(['fullVersionList']);
    chromeFullVersion =
      values?.fullVersionList?.find((b) => /Chrom/.test(b.brand))?.version ?? null;
  } catch {
    // 일부 문맥에서는 high entropy 값을 줄 수 없다.
  }
  let dynamicRuleIds: number[] | string;
  try {
    dynamicRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);
  } catch (e) {
    dynamicRuleIds = `조회 실패: ${String(e)}`;
  }
  return {
    userAgent: navigator.userAgent,
    chromeMajor,
    chromeFullVersion,
    hasMimeHandlerApi,
    interceptionMode: decideInterceptionMode({ hasMimeHandlerApi, chromeMajor }),
    dynamicRuleIds,
    isTopLevel: window.top === window,
    isSecureContext: window.isSecureContext,
    hasShowSaveFilePicker: 'showSaveFilePicker' in window,
    hasDownloadsApi: typeof chrome.downloads?.download === 'function',
  };
}

/** CSS 기준 배율. 폭이 좁으면 화면 폭에 맞춘다. */
function cssScaleFor(pageWidthPt: number): number {
  const available = Math.max(320, document.documentElement.clientWidth - 32);
  return Math.min(1.5, available / pageWidthPt);
}

async function renderFirstPage(pageWidthPt: number): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const cssScale = cssScaleFor(pageWidthPt);
  const page = await pdf.renderPage({ pageIndex: 0, scale: cssScale * dpr });
  canvas.width = page.width;
  canvas.height = page.height;
  canvas.style.width = `${page.width / dpr}px`;
  canvas.style.height = `${page.height / dpr}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d 컨텍스트 없음');
  ctx.putImageData(new ImageData(page.rgba, page.width, page.height), 0, 0);
  diag.add('render', {
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    scale: cssScale * dpr,
    renderMs: page.renderMs,
  });
}

async function openBytes(bytes: ArrayBuffer, label: string): Promise<void> {
  setStatus('opening', `여는 중: ${label}`);
  const info = await pdf.open(transferBytes(bytes));
  diag.add('open', info);
  document.title = `${label} - PDF Editor`;
  await renderFirstPage(info.firstPage.width);
  setStatus('rendered', `${info.pageCount} 페이지 · 1페이지 렌더 완료`);
}

function describeSource(source: ViewerSource): Record<string, unknown> {
  const info = source.streamInfo;
  return {
    kind: source.kind,
    displayUrl: source.displayUrl,
    byteLength: source.bytes?.byteLength ?? null,
    fetchMs: source.fetchMs,
    streamInfo: info && {
      mimeType: info.mimeType,
      embedded: info.embedded,
      originalUrl: info.originalUrl,
      streamUrlScheme: new URL(info.streamUrl).protocol,
      tabId: info.tabId,
    },
  };
}

function fileLabel(url: string | null): string {
  if (!url) return 'document.pdf';
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return name || 'document.pdf';
  } catch {
    return 'document.pdf';
  }
}

async function main(): Promise<void> {
  diag.add('env', await environmentInfo());
  const source = await resolveViewerSource({
    href: location.href,
    mimeHandler: 'mimeHandler' in chrome ? chrome.mimeHandler : undefined,
    fetch: (input, init) => fetch(input, init),
    now: () => performance.now(),
  });
  badgeEl.textContent = source.kind;
  if (source.kind === 'mime-handler-embedded') document.body.classList.add('embedded');
  diag.add('source', describeSource(source));

  if (source.bytes) {
    try {
      await openBytes(source.bytes, fileLabel(source.displayUrl));
    } catch (e) {
      diag.add('open-error', String(e));
      if (source.streamInfo) {
        // 지원하지 않는 문서: Chrome 기본 뷰어로 넘긴다. 이후 코드는 실행되지 않는다.
        await chrome.mimeHandler.abortAndFallbackToNativeHandler();
        return;
      }
      setStatus('error', `열기 실패: ${String(e)}`);
    }
    return;
  }

  openLabel.hidden = false;
  setStatus('idle', 'PDF 파일을 선택하세요');
  openInput.addEventListener('change', () => {
    const file = openInput.files?.[0];
    if (!file) return;
    void file
      .arrayBuffer()
      .then((bytes) => openBytes(bytes, file.name))
      .catch((e: unknown) => {
        diag.add('open-error', String(e));
        setStatus('error', `열기 실패: ${String(e)}`);
      });
  });
}

main().catch((e: unknown) => {
  diag.add('fatal', String(e));
  setStatus('error', String(e));
});
