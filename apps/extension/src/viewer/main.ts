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
import { DiagLog, diagRequested, isDiagShortcut } from './diag.js';
import type { CommitResult, JournalAdvice, SaveHeapEstimate } from '@pdf-editor/shared-types';
import { aboutContent } from './about.js';
import { alertDialog, confirmDialog, openDialog } from './dialog.js';
import {
  HeaderZoom,
  chromeTabZoom,
  compensatesZoom,
  viewerTabId,
  watchDevicePixelRatio,
  type HeaderZoomState,
} from './header-zoom.js';
import {
  fileAccessNotice,
  journalNotice,
  recoveredNotice,
  recoveryProgressNotice,
  redactNotice,
  sizeLimitNotice,
  supportedSizeNotice,
} from './notices.js';
import { ResilientPdf, type WorkerHandle } from './recovery.js';
import { setupSaveMenu } from './save-menu.js';
import { SaveTarget, type SaveOutcome, type WritableFileHandle } from './save-target.js';
import { decideSave } from './save-plan.js';
import { resolveViewerSource, type ViewerContextKind, type ViewerSource } from './source.js';
import { APP_STRINGS, applyDomStrings, detectLang, readLanguageSources } from './strings.js';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
}

/** 화면 언어(사용자 요청 2026-10-23): 브라우저 UI 언어가 ko 계열이면 한국어, 그 밖은 영어. */
const lang = detectLang(readLanguageSources());
const t = APP_STRINGS[lang];
document.documentElement.lang = lang;
applyDomStrings(document, t);

const statusEl = byId<HTMLSpanElement>('status');
const openLabel = byId<HTMLLabelElement>('open-label');
const openInput = byId<HTMLInputElement>('open-file');
const diagLogEl = byId<HTMLPreElement>('diag-log');
/** 저장 메뉴 버튼(프린터 아이콘). 문서를 그리기 전에는 비활성(이전 저장 버튼들과 같은 조건). */
const saveMenuButton = byId<HTMLButtonElement>('save-menu-button');

const diag = new DiagLog((log) => {
  diagLogEl.textContent = log.toJSON();
});
byId<HTMLButtonElement>('copy-diag').addEventListener('click', () => {
  void navigator.clipboard.writeText(diag.toJSON());
});

/**
 * 개발 표시(진단 패널·downloads 저장·렌더 경과 상태 줄, 사용자 요청 2026-10-23): 기본은 숨기고 `html[data-diag]` 일 때만
 * 보인다(viewer.css). 개발 빌드에서 주소에 `?diag` 를 붙여 열거나 Ctrl+Alt+Shift+D 로 켜고 끈다. 스토어 빌드에는 이 코드가
 * 없고 진단 패널은 늘 숨긴다(계약 D6). 진단 기록 수집(`diag.add`)과 `#diag-log` 내용은 숨겨져 있어도 그대로다.
 */
if (__BUILD_KIND__ !== 'store') {
  const setDiagVisible = (on: boolean) => {
    document.documentElement.toggleAttribute('data-diag', on);
    diag.add('diag-visible', on);
  };
  if (diagRequested(location.search)) setDiagVisible(true);
  document.addEventListener('keydown', (e) => {
    if (!isDiagShortcut(e)) return;
    e.preventDefault();
    setDiagVisible(!document.documentElement.hasAttribute('data-diag'));
  });
}

/** 상태 줄. `dev` 면 개발 표시(렌더 경과 등)라 진단 표시를 켰을 때만 보인다. */
function setStatus(state: string, text: string, dev = false): void {
  statusEl.dataset.state = state;
  statusEl.toggleAttribute('data-dev', dev);
  statusEl.textContent = text;
}

const noticeBar = byId<HTMLDivElement>('notice-bar');
const pageContainerEl = byId<HTMLElement>('page-container');
const dialogEl = byId<HTMLDialogElement>('app-dialog');

const toolbarEl = byId<HTMLElement>('toolbar');
/** 머리 영역 확대 보정 배율 f(header-zoom.ts). 머리 영역(툴바·알림 줄)의 CSS zoom 은 1/f. */
let headerFactor = 1;

/**
 * 검색창(position: fixed)이 툴바·알림 줄 바로 아래에 오도록, 둘의 실제 높이로 CSS 변수를 갱신한다.
 * 검색창은 툴바 안(CSS zoom 1/f)에 그려지므로 top 은 머리 영역 px(화면 px × f)로 준다.
 */
function syncFindTop(): void {
  const bottom = Math.max(
    toolbarEl.getBoundingClientRect().bottom,
    noticeBar.hidden ? 0 : noticeBar.getBoundingClientRect().bottom,
  );
  document.documentElement.style.setProperty(
    '--pe-find-top',
    `${Math.ceil(bottom * headerFactor) + 4}px`,
  );
}
const toolbarObserver = new ResizeObserver(syncFindTop);
toolbarObserver.observe(toolbarEl);
toolbarObserver.observe(noticeBar);

/** 머리 영역 확대 보정 결과를 반영한다. `data-zoom`·`data-zoom-mode` 는 시험·진단용. */
function applyHeaderZoom(state: HeaderZoomState): void {
  headerFactor = state.factor;
  const root = document.documentElement;
  root.style.setProperty('--pe-header-zoom', String(1 / state.factor));
  root.toggleAttribute('data-narrow', state.narrow);
  root.dataset.zoom = String(Math.round(state.factor * 1e4) / 1e4);
  root.dataset.zoomMode = state.mode;
  syncFindTop();
}

/**
 * 브라우저 확대·축소에도 머리 영역 크기를 100% 때와 같게 둔다(사용자 요청 2026-10-22). 문맥을 알기 전에는 보정 없이
 * 좁은 배치만 판정한다(이전 미디어 쿼리와 같다). resize 와 dpr 변화는 같은 프레임 안에서 바로 반영한다.
 */
const headerZoom = new HeaderZoom({
  cssWidth: () => window.innerWidth,
  devicePixelRatio: () => window.devicePixelRatio || 1,
  apply: applyHeaderZoom,
  log: (event, data) => diag.add(event, data),
});
window.addEventListener('resize', () => headerZoom.onViewportChange());
watchDevicePixelRatio(window, () => headerZoom.onViewportChange());

/** 문맥을 안 뒤: 탭 최상위 뷰어만 탭 배율로 보정하고, 임베디드 문맥은 바깥 페이지 확대를 따른다. */
async function attachHeaderZoom(
  kind: ViewerContextKind,
  streamInfo: chrome.mimeHandler.StreamInfo | null,
): Promise<void> {
  if (!compensatesZoom(kind, window.top === window)) return headerZoom.attach(null, false);
  const tabs = typeof chrome === 'object' ? chrome.tabs : undefined;
  const tabId = await viewerTabId(
    streamInfo,
    typeof tabs?.getCurrent === 'function' ? () => tabs.getCurrent() : null,
  );
  diag.add('header-zoom-tab', { kind, tabId });
  await headerZoom.attach(tabId === null ? null : chromeTabZoom(tabId), true);
}

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
    close.title = t.close;
    close.setAttribute('aria-label', t.close);
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
      setStatus('error', t.statusWorkerError(e.message));
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

byId<HTMLButtonElement>('about').addEventListener('click', () => {
  const about = aboutContent(
    {
      version: __APP_VERSION__,
      sourceUrl: __SOURCE_URL__,
      // 고지 파일은 스토어 빌드 패키지에만 들어간다(scripts/release/package.mjs).
      noticesUrl:
        __BUILD_KIND__ === 'store' ? chrome.runtime.getURL('THIRD_PARTY_NOTICES.txt') : null,
      heap: lastHeap,
    },
    t,
  );
  void openDialog(dialogEl, {
    ...about,
    buttons: [{ id: 'ok', label: t.close, primary: true }],
  });
});

/** 복구용 편집 로그(계약 D6): 커밋한 EditOp 와 지금 문서에 반영된 편집 id. */
const editLog = new EditLog();
/** 최근 저장 전 판정의 힙 추정(지원 크기 안내·정보 대화상자용). */
let lastHeap: SaveHeapEstimate | null = null;
/** 편집이 있는 문서를 저장한 뒤 되돌리기 안내를 문서당 한 번만 보인다. */
let historyNoticeShown = false;
let lastPlanHadEdits = false;
let controllerRef: ViewerController | null = null;

const pdf = new ResilientPdf({
  spawn: spawnWorker,
  transfer: transferBytes,
  editLog: () => editLog.snapshot(),
  log: (event, data) => diag.add(event, data),
  onProgress: (done, total) => {
    // 계약 D4(사용자 결정 2026-10-21): 복구 중 진행 n/N.
    setNotice('recovered', recoveryProgressNotice(done, total, t));
    setStatus('opening', t.statusRecovering(done, total));
  },
  onRecovered: async (info) => {
    setNotice('recovered', recoveredNotice(info.replayedEdits, info.fromSavedBaseline, t));
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
    setStatus('error', t.statusEditNotFinished);
    return false;
  }
  let plan;
  try {
    plan = await pdf.planSave({ changes: [] });
  } catch (e) {
    diag.add('save-plan-error', String(e));
    setStatus('error', t.statusPlanFailed(String(e)));
    return false;
  }
  const journal = await queryJournalAdvice();
  const decision = decideSave(plan, journal, t);
  lastHeap = plan.heap;
  lastPlanHadEdits = plan.edits !== null;
  updateSizeNotice(plan.heap);
  diag.add('save-plan', {
    method: plan.method,
    options: plan.options,
    heap: plan.heap.level,
    grownHeapBasis: plan.heap.grownHeapBasis ?? null,
    journalAdvised: journal?.advised ?? null,
    edits: plan.edits,
    block: decision.block,
    warnings: decision.warnings,
  });
  if (decision.block) {
    await alertDialog(dialogEl, t.cannotSaveTitle, [decision.block], t.dialogOk);
    setStatus('error', t.statusSaveBlocked(decision.block));
    return false;
  }
  if (decision.warnings.length > 0) {
    const ok = await confirmDialog(
      dialogEl,
      t.confirmSaveTitle,
      [...decision.warnings, ...decision.infos],
      decision.confirmLabel ?? t.save,
      t.dialogCancel,
    );
    if (!ok) {
      setStatus('idle', t.statusSaveCancelled);
      return false;
    }
  }
  return true;
}

/**
 * 크기 알림 칸 하나(I3): 저장 전 판정이 warn·over-limit 이면 그 문구로 바꾸고, ok 면 열 때 바이트 기준 안내를 그대로 둔다.
 */
function updateSizeNotice(heap: SaveHeapEstimate): void {
  const text = sizeLimitNotice(heap, t);
  if (text) setNotice('size', text);
}

/** core 저널 상한 판정(계약 D4). 받지 못하면 진단 로그만 남기고 null(권고 없음). */
async function queryJournalAdvice(): Promise<JournalAdvice | null> {
  try {
    return await pdf.journalAdvice();
  } catch (e) {
    diag.add('journal-advice-error', String(e));
    return null;
  }
}

/** 편집 커밋 뒤 저널 상한을 물어 "저장 후 다시 열기" 안내를 갱신한다(계약 D4, docs/m5-heap.md 5.3). */
async function reportJournal(): Promise<void> {
  const advice = await queryJournalAdvice();
  if (!advice) return;
  diag.add('journal-advice', advice);
  setNotice('journal', journalNotice(advice, t));
}

/** 커밋 RPC 결과를 그대로 돌려주고, 저널 판정은 기다리지 않고 뒤에서 한다. */
function afterCommit(result: CommitResult): CommitResult {
  void reportJournal();
  return result;
}

/** 복구 알림 오류(저장 중 Worker 가 죽어 복구됨)인지. 저장 대상이 오류를 문자열로 감싸 돌려주는 경우도 본다. */
function isRecoveredSave(error: unknown): boolean {
  if (classifyFailure(error).kind === 'recovered') return true;
  return typeof error === 'string' && error.includes('WorkerRecoveredError');
}

async function runSave(trigger: SaveTrigger): Promise<void> {
  if (!(await prepareSave())) return;
  setStatus('saving', t.statusSaving);
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
    setStatus('error', t.statusSaveFailed(String(e)));
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
  const where = outcome.channel === 'fsa' ? t.savedToFile(outcome.fileName) : t.savedToDownloads;
  // 계약 D4: 사용자 저장이 성공하면 그 바이트가 복구 기준점이다.
  if (outcome.status === 'saved') pdf.confirmSaved();
  else pdf.discardPendingSave();
  setStatus(
    outcome.status,
    outcome.status === 'saved'
      ? t.statusSaved(where, outcome.reusedHandle)
      : outcome.status === 'cancelled'
        ? t.statusSaveCancelled
        : t.statusSaveFailed(outcome.error ?? where),
  );
  if (outcome.status === 'saved' && lastPlanHadEdits && !historyNoticeShown) {
    historyNoticeShown = true;
    setNotice('history', t.historyAfterSave);
  }
}

/** 저장 중 Worker 가 죽어 복구한 뒤(계약 5.8, A3-3): 다시 저장할지 묻는다. */
async function askSaveAgain(trigger: SaveTrigger): Promise<void> {
  setStatus('error', t.statusRecoveredDuringSave);
  const again = await confirmDialog(
    dialogEl,
    t.saveFailedTitle,
    t.saveFailedLines,
    t.saveAgain,
    t.later,
  );
  if (again) await runSave(trigger);
}

/** M0 진단: 브라우저 Worker 에서 전체 저장 시간·WASM 힙 측정(파일은 저장하지 않음). */
async function benchFullSave(): Promise<void> {
  setStatus('saving', t.statusBenchSaving, true);
  const r = await pdf.save({ changes: ['content-stream'] });
  pdf.discardPendingSave(); // 측정 저장은 복구 기준점이 아니다
  const result = {
    method: r.method,
    options: r.options,
    saveMs: r.saveMs,
    wasmHeapBytes: r.wasmHeapBytes,
    outputBytes: r.bytes.byteLength,
    context: contextKind,
  };
  diag.add('bench-full-save', result);
  setStatus('rendered', t.statusBenchResult(r.saveMs, (r.wasmHeapBytes ?? 0) / 2 ** 20), true);
}

/**
 * 저장 메뉴(사용자 요청 2026-10-22): 저장 / 다른 이름으로 저장 / (개발 빌드만) downloads 저장.
 * downloads 저장(M0 진단)은 스토어 빌드의 viewer.html 에서 빠지고(vite.config.ts), 아래 분기도 스토어 번들에서 사라진다.
 */
const saveMenu = setupSaveMenu({
  button: saveMenuButton,
  menu: byId<HTMLElement>('save-menu'),
  onChoose: (id) => {
    if (id === 'save') void runSave('save');
    else if (id === 'save-as') void runSave('save-as');
    else if (__BUILD_KIND__ !== 'store' && id === 'save-downloads') void runSave('downloads');
  },
});

function enableSave(): void {
  saveMenuButton.disabled = false;
  const bench = byId<HTMLButtonElement>('bench-full-save');
  bench.disabled = false;
  bench.addEventListener('click', () => {
    void benchFullSave().catch((e: unknown) => diag.add('bench-error', String(e)));
  });
  // Ctrl+S 는 메뉴 없이 바로 저장한다(Ctrl+Shift+S 는 다른 이름으로 저장).
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveMenu.close();
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
  // 렌더 경과는 개발 표시다(쪽 수는 툴바 "/ N" 에 있다).
  setStatus('rendered', t.statusRendered(e.pageCount, e.pageIndex + 1), true);
}

async function openBytes(bytes: ArrayBuffer, label: string): Promise<void> {
  setStatus('opening', t.statusOpening(label));
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
  setNotice('size', null);
  setNotice('journal', null);
  setNotice('history', null);
  lastHeap = null;
  lastPlanHadEdits = false;
  historyNoticeShown = false;
  // 원본은 복구 계층이 open 전에 Blob 으로 보관한 뒤 Worker 로 넘긴다(계약 D6).
  const info = await pdf.open(bytes);
  diag.add('open', info);
  // 크기 알림(I3, 사용자 결정 2026-10-21): 열 때 바이트 기준 안내를 한 번 띄우고, 저장 전 판정은 같은 칸을 바꾼다.
  setNotice('size', supportedSizeNotice(info.byteLength, undefined, t));
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
      commitParagraphEdit: (d) => pdf.commitParagraphEdit(d).then(afterCommit),
      cancelParagraphEdit: (d) => pdf.cancelParagraphEdit(d),
      planPathEdit: (i, s) => pdf.planPathEdit(i, s),
      beginPathEdit: (i, s, r) => pdf.beginPathEdit(i, s, r),
      updatePathDraft: (d, e, scale) => pdf.updatePathDraft(d, e, scale),
      commitPathEdit: (d) => pdf.commitPathEdit(d).then(afterCommit),
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
      availableWidth: pageContainerEl.clientWidth - 2 * PAGE_ARROW_GUTTER,
    }),
    onPagePainted,
    editLog,
    strings: t.viewer,
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
  void reportSizeLimit();
}

/** 열기 직후 저장 전 판정으로 지원 크기 안내를 낸다(편집 전 추정). 판정을 못 받으면 진단 로그만 남긴다. */
async function reportSizeLimit(): Promise<void> {
  try {
    const plan = await pdf.planSave({ changes: [] });
    lastHeap = plan.heap;
    diag.add('size-plan', { level: plan.heap.level, model: plan.heap.model ?? null });
    updateSizeNotice(plan.heap);
  } catch (e) {
    diag.add('size-plan-error', String(e));
  }
}

/** 열기 시 Redact 주석 보고(A2-2). 보고를 받지 못하면 진단 로그만 남긴다. */
async function reportRedactAnnots(): Promise<void> {
  const report = await pdf.tryListRedactAnnots();
  if (report === null) {
    diag.add('redact-report-unavailable', 'listRedactAnnots 실패(A2-2)');
    return;
  }
  diag.add('redact-report', report);
  setNotice('redact', redactNotice(report, t));
}

/** DNR 폴백 경로에서 file:// 접근이 꺼져 있으면 안내한다(A5-3). */
async function reportFileAccess(displayUrl: string | null, mode: string): Promise<void> {
  let allowed: boolean | null;
  try {
    allowed = await chrome.extension.isAllowedFileSchemeAccess();
  } catch {
    allowed = null;
  }
  const notice = fileAccessNotice(
    {
      mode: mode === 'mime-handler' || mode === 'dnr-fallback' ? mode : 'unsupported',
      fileAccessAllowed: allowed,
      displayUrl,
      extensionId: chrome.runtime.id,
    },
    t,
  );
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
    // 머리 영역 확대 보정은 문서 수신을 기다리지 않는다.
    onContext: (kind, streamInfo) => {
      attachHeaderZoom(kind, streamInfo).catch((e: unknown) =>
        diag.add('header-zoom-error', String(e)),
      );
    },
  });
  contextKind = source.kind;
  // 문맥 이름은 화면에 보이지 않고 시험·진단용으로 body 에 남긴다.
  document.body.dataset.context = source.kind;
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
      setStatus('error', t.statusOpenFailed(String(e)));
    }
    return;
  }

  openLabel.hidden = false;
  setStatus('idle', t.statusChoosePdf);
  openInput.addEventListener('change', () => {
    const file = openInput.files?.[0];
    if (!file) return;
    void file
      .arrayBuffer()
      .then((bytes) => openBytes(bytes, file.name))
      .catch((e: unknown) => {
        diag.add('open-error', String(e));
        setStatus('error', t.statusOpenFailed(String(e)));
      });
  });
}

main().catch((e: unknown) => {
  diag.add('fatal', String(e));
  setStatus('error', String(e));
});
