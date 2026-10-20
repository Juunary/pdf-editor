import { transferBytes, wrapPdfWorker } from '@pdf-editor/core/client';
import {
  EditLog,
  ViewerController,
  classifyFailure,
  PAGE_ARROW_GUTTER,
  mountViewer,
  type PagePaintedEvent,
} from '@pdf-editor/viewer-ui';
import '@pdf-editor/viewer-ui/style.css';
import { decideInterceptionMode, parseChromeMajor } from '../interception.js';
import { DiagLog } from './diag.js';
import { alertDialog, confirmDialog } from './dialog.js';
import { fileAccessNotice, redactNotice } from './notices.js';
import { ResilientPdf, type WorkerHandle } from './recovery.js';
import { SaveTarget, type SaveOutcome, type WritableFileHandle } from './save-target.js';
import { decideSave } from './save-plan.js';
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

const noticeBar = byId<HTMLDivElement>('notice-bar');
const dialogEl = byId<HTMLDialogElement>('app-dialog');

/** 알림 줄(열기 시 보고·안내·복구). text 가 null 이면 그 id 의 알림을 지운다. */
function setNotice(id: string, text: string | null): void {
  noticeBar.querySelector(`[data-notice="${id}"]`)?.remove();
  if (text) {
    const row = document.createElement('div');
    row.className = 'notice';
    row.dataset.notice = id;
    const span = document.createElement('span');
    span.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.title = '닫기';
    close.addEventListener('click', () => setNotice(id, null));
    row.append(span, close);
    noticeBar.append(row);
  }
  noticeBar.hidden = noticeBar.childElementCount === 0;
}

/** 뷰어 소유 module Worker 하나를 만든다. 죽으면(`error`·`messageerror`) `dead` 가 reject 된다(복구 계층이 감지). */
function spawnWorker(): WorkerHandle {
  const worker = new Worker(new URL('../worker/pdf-worker.ts', import.meta.url), {
    type: 'module',
  });
  const api = wrapPdfWorker(worker);
  const dead = new Promise<never>((_, reject) => {
    const fail = (message: string) => {
      const e = new Error(message);
      e.name = 'WorkerCrash';
      reject(e);
    };
    worker.addEventListener('error', (e) => {
      diag.add('worker-error', e.message || 'Worker 스크립트 로드 실패');
      setStatus('error', `Worker 오류: ${e.message}`);
      fail(e.message || 'Worker 오류');
    });
    worker.addEventListener('messageerror', () => {
      diag.add('worker-messageerror', 'Worker 메시지 역직렬화 실패');
      fail('Worker 메시지 오류');
    });
  });
  dead.catch(() => undefined);
  return { api, dead, terminate: () => worker.terminate() };
}

/** 복구용 편집 로그(계약 D6): 커밋한 EditOp 와 지금 문서에 반영된 편집 id. */
const editLog = new EditLog();
let controllerRef: ViewerController | null = null;

const pdf = new ResilientPdf({
  spawn: spawnWorker,
  transfer: transferBytes,
  editLog: () => editLog.snapshot(),
  log: (event, data) => diag.add(event, data),
  onRecovered: async (info) => {
    setNotice(
      'recovered',
      `작업 모듈이 중단되어 문서를 복구했습니다(편집 ${info.replayedEdits}건 다시 적용). 복구 전 되돌리기 이력은 사라졌습니다.`,
    );
    await controllerRef?.handleWorkerRecovered();
  },
});

// e2e 시험 이음매: `viewer.html?e2e` 로 열었을 때만 내부 객체를 노출한다(저장 판정·복구 오류 주입용).
if (new URLSearchParams(location.search).has('e2e')) {
  Object.assign(window, {
    __pe: {
      pdf,
      editLog,
      get controller() {
        return controllerRef;
      },
    },
  });
}

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

/** Worker 에서 저장 바이트를 만든다. 변경 유형은 core 가 편집 로그에서 더한다(계약 D9). */
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

/**
 * 저장 전 준비(계약 5.8): 초안이 있으면 먼저 커밋 → planSave → over-limit 은 중단 안내, 경고는 확인 창.
 * 저장해도 되면 true.
 */
async function prepareSave(): Promise<boolean> {
  const edit = controllerRef?.edit;
  if (edit && !(await edit.commitActive())) {
    setStatus('error', '편집을 마치지 못해 저장하지 않았습니다');
    return false;
  }
  let plan;
  try {
    plan = await pdf.planSave({ changes: [] });
  } catch (e) {
    diag.add('save-plan-error', String(e));
    setStatus('error', `저장 전 판정 실패: ${String(e)}`);
    return false;
  }
  const decision = decideSave(plan);
  diag.add('save-plan', {
    method: plan.method,
    options: plan.options,
    heap: plan.heap.level,
    edits: plan.edits,
    block: decision.block,
    warnings: decision.warnings,
  });
  if (decision.block) {
    await alertDialog(dialogEl, '저장할 수 없습니다', [decision.block]);
    setStatus('error', `저장 중단: ${decision.block}`);
    return false;
  }
  if (decision.warnings.length > 0) {
    const ok = await confirmDialog(
      dialogEl,
      '저장 전 확인',
      [...decision.warnings, ...decision.infos],
      '저장',
      '취소',
    );
    if (!ok) {
      setStatus('idle', '저장을 취소했습니다');
      return false;
    }
  }
  return true;
}

/** 복구 알림 오류(저장 중 Worker 가 죽어 복구됨)인지. 저장 대상이 오류를 문자열로 감싸 돌려주는 경우도 본다. */
function isRecoveredSave(error: unknown): boolean {
  if (classifyFailure(error).kind === 'recovered') return true;
  return typeof error === 'string' && error.includes('WorkerRecoveredError');
}

async function runSave(trigger: SaveTrigger): Promise<void> {
  if (!(await prepareSave())) return;
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
    if (isRecoveredSave(e)) return askSaveAgain(trigger);
    setStatus('error', `저장 실패: ${String(e)}`);
    return;
  }
  if (outcome.status === 'failed' && isRecoveredSave(outcome.error)) {
    diag.add('save-error', { trigger, context: contextKind, error: outcome.error });
    return askSaveAgain(trigger);
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

/** 저장 중 Worker 가 죽어 복구한 뒤(계약 5.8, A3-3): 다시 저장할지 묻는다. */
async function askSaveAgain(trigger: SaveTrigger): Promise<void> {
  setStatus('error', '저장 중 작업 모듈이 중단되어 문서를 복구했습니다');
  const again = await confirmDialog(
    dialogEl,
    '저장하지 못했습니다',
    [
      '저장하는 동안 작업 모듈이 중단되어 문서를 복구했습니다. 편집 내용은 복구되었지만 복구 전 되돌리기 이력은 사라졌습니다.',
      '다시 저장할까요?',
    ],
    '다시 저장',
    '나중에',
  );
  if (again) await runSave(trigger);
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
  // 이전에 연 문서의 뷰어를 먼저 정리한다. Worker 세션은 open 에서 이전 문서를 닫으므로, 그 사이 이전 뷰어가
  // 렌더·추출을 요청하면 새 문서(또는 닫힌 문서)에 대한 호출이 된다.
  if (unmountViewer) {
    unmountViewer();
    unmountViewer = null;
    diag.add('viewer-unmount', { reason: 'open' });
  }
  firstPaintAnnounced = false;
  editLog.reset();
  setNotice('recovered', null);
  setNotice('redact', null);
  // 원본은 복구 계층이 open 전에 Blob 으로 보관한 뒤 Worker 로 넘긴다(계약 D6).
  const info = await pdf.open(bytes);
  diag.add('open', info);
  documentName = label;
  document.title = `${label} - PDF Editor`;

  const controller = new ViewerController({
    host: {
      getPageInfo: (i) => pdf.getPageInfo(i),
      renderPage: (r) => pdf.renderPage(r),
      extractPage: (r) => pdf.extractPage(r),
      getSourceMap: (i) => pdf.getSourceMap(i),
      linkPage: (i) => pdf.linkPage(i),
      searchText: (r) => pdf.searchText(r),
      getPageLayout: (i) => pdf.getPageLayout(i),
      getPageEditability: (i) => pdf.getPageEditability(i),
      planParagraphEdit: (i, p) => pdf.planParagraphEdit(i, p),
      beginParagraphEdit: (i, p, r, scale) => pdf.beginParagraphEdit(i, p, r, scale),
      updateParagraphDraft: (d, input) => pdf.updateParagraphDraft(d, input),
      commitParagraphEdit: (d) => pdf.commitParagraphEdit(d),
      cancelParagraphEdit: (d) => pdf.cancelParagraphEdit(d),
      planPathEdit: (i, s) => pdf.planPathEdit(i, s),
      beginPathEdit: (i, s, r) => pdf.beginPathEdit(i, s, r),
      updatePathDraft: (d, e, scale) => pdf.updatePathDraft(d, e, scale),
      commitPathEdit: (d) => pdf.commitPathEdit(d),
      cancelPathEdit: (d) => pdf.cancelPathEdit(d),
      undo: () => pdf.undo(),
      redo: () => pdf.redo(),
      getEditHistory: () => pdf.getEditHistory(),
      log: (event, data) => diag.add(event, data),
    },
    pageCount: info.pageCount,
    getEnvironment: () => ({
      devicePixelRatio: window.devicePixelRatio || 1,
      // 쪽 좌우 화살표 칸을 뺀 너비에 맞춘다(화살표가 쪽을 가리지 않게).
      availableWidth: document.documentElement.clientWidth - 2 * PAGE_ARROW_GUTTER,
    }),
    onPagePainted,
    editLog,
  });
  controllerRef = controller;
  unmountViewer = mountViewer(
    { controls: byId('viewer-controls'), pages: byId('page-container') },
    controller,
  );
  await controller.start();
  const { view, renderError } = controller.getState();
  // 첫 페이지를 그리지 못하면 열기 실패로 본다(MIME handler 에서는 Chrome 기본 뷰어로 넘긴다).
  if (!view) throw new Error(renderError ?? '첫 페이지 렌더 실패');
  void reportRedactAnnots();
}

/** 열기 시 Redact 주석 보고(A2-2). 보고를 받지 못하면 진단 로그만 남긴다. */
async function reportRedactAnnots(): Promise<void> {
  const report = await pdf.tryListRedactAnnots();
  if (report === null) {
    diag.add('redact-report-unavailable', 'listRedactAnnots 실패(A2-2)');
    return;
  }
  diag.add('redact-report', report);
  setNotice('redact', redactNotice(report));
}

/** DNR 폴백 경로에서 file:// 접근이 꺼져 있으면 안내한다(A5-3). */
async function reportFileAccess(displayUrl: string | null, mode: string): Promise<void> {
  let allowed: boolean | null;
  try {
    allowed = await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    allowed = null;
  }
  const notice = fileAccessNotice({
    mode: mode === 'mime-handler' || mode === 'dnr-fallback' ? mode : 'unsupported',
    fileAccessAllowed: allowed,
    displayUrl,
    extensionId: chrome.runtime.id,
  });
  diag.add('file-access', { mode, allowed, displayUrl, notice: notice !== null });
  setNotice('file-access', notice);
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
  void reportFileAccess(
    source.displayUrl,
    decideInterceptionMode({
      hasMimeHandlerApi: 'mimeHandler' in chrome && chrome.mimeHandler !== undefined,
      chromeMajor: parseChromeMajor(navigator.userAgent),
    }),
  );
  if (source.kind === 'mime-handler-embedded') document.body.classList.add('embedded');
  diag.add('source', describeSource(source));

  if (source.bytes) {
    // Chrome 기본 PDF 뷰어처럼 열자마자 Ctrl+A·C·F 가 뷰어로 오게 한다. MIME handler 뷰어는 PDF URL
    // 페이지의 하위 프레임이라 포커스를 직접 가져와야 한다. 임베디드 문맥은 바깥 페이지 포커스를 빼앗지 않는다.
    // 열기 전에 가져온다: controller.start() 는 편집 가능 판정(폴백 폰트 적재 포함)까지 기다려 늦게 끝나므로,
    // 그 뒤에 포커스를 가져오면 텍스트 층이 뜬 직후의 단축키를 놓친다(M3 통합 e2e, 2026-10-20).
    if (source.kind === 'mime-handler-top') window.focus();
    try {
      await openBytes(source.bytes, fileLabel(source.displayUrl));
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
