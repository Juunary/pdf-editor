import { transferBytes, wrapPdfWorker } from '@pdf-editor/core/client';
import { ViewerController, mountViewer, type PagePaintedEvent } from '@pdf-editor/viewer-ui';
import '@pdf-editor/viewer-ui/style.css';
import { decideInterceptionMode, parseChromeMajor } from '../interception.js';
import { DiagLog } from './diag.js';
import { SaveTarget, type SaveOutcome, type WritableFileHandle } from './save-target.js';
import { resolveViewerSource, type ViewerContextKind, type ViewerSource } from './source.js';

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
const saveButtons = {
  saveAs: byId<HTMLButtonElement>('save-as'),
  save: byId<HTMLButtonElement>('save'),
  downloads: byId<HTMLButtonElement>('save-downloads'),
};

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

let contextKind: ViewerContextKind = 'viewer-page';
let documentName = 'document.pdf';

type SavePicker = (options: unknown) => Promise<WritableFileHandle>;
const fsaPicker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
const saveTarget = new SaveTarget({
  showSaveFilePicker: fsaPicker ? (options) => fsaPicker.call(window, options) : undefined,
  downloads:
    typeof chrome.downloads?.download === 'function'
      ? { download: (options) => chrome.downloads.download(options) }
      : undefined,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  later: (fn) => setTimeout(fn, 60_000),
  now: () => performance.now(),
});

/** Worker 에서 저장 바이트를 만든다. 아직 편집 기능이 없으므로 변경 유형은 비어 있다. */
async function documentBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const r = await pdf.save({ changes: [] });
  diag.add('worker-save', {
    method: r.method,
    canBeSavedIncrementally: r.canBeSavedIncrementally,
    options: r.options,
    saveMs: r.saveMs,
    wasmHeapBytes: r.wasmHeapBytes,
    bytes: r.bytes.byteLength,
  });
  return r.bytes;
}

type SaveTrigger = 'save-as' | 'save' | 'ctrl+s' | 'downloads';

async function runSave(trigger: SaveTrigger): Promise<void> {
  setStatus('saving', '저장 중');
  let outcome: SaveOutcome;
  try {
    outcome =
      trigger === 'save-as'
        ? await saveTarget.saveAs(documentBytes, documentName)
        : trigger === 'downloads'
          ? await saveTarget.saveViaDownloads(documentBytes, documentName)
          : await saveTarget.save(documentBytes, documentName);
  } catch (e) {
    diag.add('save-error', { trigger, context: contextKind, error: String(e) });
    setStatus('error', `저장 실패: ${String(e)}`);
    return;
  }
  diag.add('save', {
    trigger,
    context: contextKind,
    isTopLevel: window.top === window,
    ...outcome,
  });
  const where = outcome.channel === 'fsa' ? `파일 ${outcome.fileName}` : 'chrome.downloads';
  setStatus(
    outcome.status === 'saved' ? 'saved' : outcome.status,
    `${outcome.status === 'saved' ? '저장됨' : outcome.status}: ${where}${outcome.reusedHandle ? ' (같은 대상 재저장)' : ''}`,
  );
}

/** M0 진단: 브라우저 Worker 에서 전체 저장 시간·WASM 힙 측정(파일은 저장하지 않음). */
async function benchFullSave(): Promise<void> {
  setStatus('saving', '전체 저장 측정 중');
  const r = await pdf.save({ changes: ['content-stream'] });
  const result = {
    method: r.method,
    options: r.options,
    saveMs: r.saveMs,
    wasmHeapBytes: r.wasmHeapBytes,
    outputBytes: r.bytes.byteLength,
    context: contextKind,
  };
  diag.add('bench-full-save', result);
  setStatus(
    'rendered',
    `전체 저장 ${r.saveMs.toFixed(0)} ms, WASM 힙 ${((r.wasmHeapBytes ?? 0) / 2 ** 20).toFixed(1)} MiB`,
  );
}

function enableSave(): void {
  for (const b of Object.values(saveButtons)) b.disabled = false;
  const bench = byId<HTMLButtonElement>('bench-full-save');
  bench.disabled = false;
  bench.addEventListener('click', () => {
    void benchFullSave().catch((e: unknown) => diag.add('bench-error', String(e)));
  });
  saveButtons.saveAs.addEventListener('click', () => void runSave('save-as'));
  saveButtons.save.addEventListener('click', () => void runSave('save'));
  saveButtons.downloads.addEventListener('click', () => void runSave('downloads'));
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void runSave(e.shiftKey ? 'save-as' : 'ctrl+s');
    }
  });
}

let saveEnabled = false;
let firstPaintAnnounced = false;
let unmountViewer: (() => void) | null = null;

/** 첫 페이지가 캔버스에 그려진 뒤: 상태 표시와 저장 활성화. 이후 페이지는 진단 기록만 남긴다. */
function onPagePainted(e: PagePaintedEvent): void {
  diag.add('render', {
    pageIndex: e.pageIndex,
    width: e.width,
    height: e.height,
    scale: e.renderScale,
    renderMs: e.renderMs,
  });
  if (firstPaintAnnounced) return;
  firstPaintAnnounced = true;
  if (!saveEnabled) {
    saveEnabled = true;
    enableSave();
  }
  setStatus('rendered', `${e.pageCount} 페이지 · ${e.pageIndex + 1}페이지 렌더 완료`);
}

async function openBytes(bytes: ArrayBuffer, label: string): Promise<void> {
  setStatus('opening', `여는 중: ${label}`);
  const info = await pdf.open(transferBytes(bytes));
  diag.add('open', info);
  documentName = label;
  document.title = `${label} - PDF Editor`;

  // 이전에 연 문서의 뷰어를 정리하고 새 문서로 다시 마운트한다.
  unmountViewer?.();
  firstPaintAnnounced = false;
  const controller = new ViewerController({
    host: {
      getPageInfo: (i) => pdf.getPageInfo(i),
      renderPage: (r) => pdf.renderPage(r),
      extractPage: (r) => pdf.extractPage(r),
      getSourceMap: (i) => pdf.getSourceMap(i),
      linkPage: (i) => pdf.linkPage(i),
      searchText: (r) => pdf.searchText(r),
      log: (event, data) => diag.add(event, data),
    },
    pageCount: info.pageCount,
    getEnvironment: () => ({
      devicePixelRatio: window.devicePixelRatio || 1,
      availableWidth: document.documentElement.clientWidth,
    }),
    onPagePainted,
  });
  unmountViewer = mountViewer(
    { controls: byId('viewer-controls'), pages: byId('page-container') },
    controller,
  );
  await controller.start();
  const { view, renderError } = controller.getState();
  // 첫 페이지를 그리지 못하면 열기 실패로 본다(MIME handler 에서는 Chrome 기본 뷰어로 넘긴다).
  if (!view) throw new Error(renderError ?? '첫 페이지 렌더 실패');
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
  contextKind = source.kind;
  badgeEl.textContent = source.kind;
  if (source.kind === 'mime-handler-embedded') document.body.classList.add('embedded');
  diag.add('source', describeSource(source));

  if (source.bytes) {
    try {
      await openBytes(source.bytes, fileLabel(source.displayUrl));
      // Chrome 기본 PDF 뷰어처럼 열자마자 Ctrl+A·C·F 가 뷰어로 오게 한다. MIME handler 뷰어는 PDF URL
      // 페이지의 하위 프레임이라 포커스를 직접 가져와야 한다. 임베디드 문맥은 바깥 페이지 포커스를 빼앗지 않는다.
      if (source.kind === 'mime-handler-top') window.focus();
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
