import { transferBytes, wrapPdfWorker } from '@pdf-editor/core/client';
import {
  EditLog,
  ViewerController,
  classifyFailure,
  mountViewer,
  pageArrowLayout,
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

/** Display language (user request 2026-10-23): Korean if the browser UI language is in the ko family, otherwise English. */
const lang = detectLang(readLanguageSources());
const t = APP_STRINGS[lang];
document.documentElement.lang = lang;
applyDomStrings(document, t);

const statusEl = byId<HTMLSpanElement>('status');
const openLabel = byId<HTMLLabelElement>('open-label');
const openInput = byId<HTMLInputElement>('open-file');
const diagLogEl = byId<HTMLPreElement>('diag-log');
/** Save menu button (printer icon). Disabled until a document has been drawn (same condition as the former save buttons). */
const saveMenuButton = byId<HTMLButtonElement>('save-menu-button');

const diag = new DiagLog((log) => {
  diagLogEl.textContent = log.toJSON();
});
byId<HTMLButtonElement>('copy-diag').addEventListener('click', () => {
  void navigator.clipboard.writeText(diag.toJSON());
});

/**
 * Dev indicators (diagnostics panel, downloads save, render-elapsed status line; user request 2026-10-23): hidden by default and shown only when `html[data-diag]`
 * is set (viewer.css). In dev builds, open with `?diag` in the address or toggle with Ctrl+Alt+Shift+D. The store build does not contain this code
 * and always hides the diagnostics panel (contract D6). Collection of diagnostic records (`diag.add`) and the `#diag-log` content are unchanged even while hidden.
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

/** Status line. If `dev`, it is a dev indicator (render elapsed, etc.), so it shows only when diagnostics display is on. */
function setStatus(state: string, text: string, dev = false): void {
  statusEl.dataset.state = state;
  statusEl.toggleAttribute('data-dev', dev);
  statusEl.textContent = text;
}

const noticeBar = byId<HTMLDivElement>('notice-bar');
const pageContainerEl = byId<HTMLElement>('page-container');
const dialogEl = byId<HTMLDialogElement>('app-dialog');

const toolbarEl = byId<HTMLElement>('toolbar');
/** Header zoom compensation factor f (header-zoom.ts). The CSS zoom of the header (toolbar and notice row) is 1/f. */
let headerFactor = 1;

/**
 * Updates the CSS variable with the actual heights of the toolbar and notice row so that the search box (position: fixed) sits right below them.
 * The search box is drawn inside the toolbar (CSS zoom 1/f), so top is given in header px (screen px × f).
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

/** Applies the header zoom compensation result. `data-zoom` and `data-zoom-mode` are for tests and diagnostics. */
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
 * Keeps the header size the same as at 100% even under browser zoom in/out (user request 2026-10-22). Before the context is known, only the narrow layout
 * is decided, without compensation (same as the former media query). resize and dpr changes are applied immediately within the same frame.
 */
const headerZoom = new HeaderZoom({
  cssWidth: () => window.innerWidth,
  devicePixelRatio: () => window.devicePixelRatio || 1,
  apply: applyHeaderZoom,
  log: (event, data) => diag.add(event, data),
});
window.addEventListener('resize', () => headerZoom.onViewportChange());
watchDevicePixelRatio(window, () => headerZoom.onViewportChange());

/** After the context is known: only the tab's top-level viewer is compensated with the tab zoom; embedded contexts follow the outer page's zoom. */
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

/** Notice row (reports, guidance and recovery on open). If text is null, clears the notice with that id. */
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

/** Creates one viewer-owned module Worker. If it dies (`error`, `messageerror`), `dead` rejects (detected by the recovery layer). */
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
      // The notices file is included only in the store build package (scripts/release/package.mjs).
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

/** Edit log for recovery (contract D6): committed EditOps and the edit ids reflected in the current document. */
const editLog = new EditLog();
/** Heap estimate from the latest pre-save check (for the supported-size notice and the About dialog). */
let lastHeap: SaveHeapEstimate | null = null;
/** After saving a document with edits, shows the undo notice only once per document. */
let historyNoticeShown = false;
let lastPlanHadEdits = false;
let controllerRef: ViewerController | null = null;

const pdf = new ResilientPdf({
  spawn: spawnWorker,
  transfer: transferBytes,
  editLog: () => editLog.snapshot(),
  log: (event, data) => diag.add(event, data),
  onProgress: (done, total) => {
    // Contract D4 (user decision 2026-10-21): progress n/N during recovery.
    setNotice('recovered', recoveryProgressNotice(done, total, t));
    setStatus('opening', t.statusRecovering(done, total));
  },
  onRecovered: async (info) => {
    setNotice('recovered', recoveredNotice(info.replayedEdits, info.fromSavedBaseline, t));
    await controllerRef?.handleWorkerRecovered();
  },
});

// e2e test seam: exposes internal objects only when opened as `viewer.html?e2e` (for injecting save checks and recovery errors).
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
    // Some contexts cannot provide high entropy values.
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

/** Builds the bytes to save in the Worker. The change type is added by core from the edit log (contract D9). */
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
 * Pre-save preparation (contract 5.8): commit the draft first if there is one → planSave → abort notice for over-limit, confirmation dialog for warnings.
 * Returns true if saving may proceed.
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
    setStatus('error', t.statusPlanFailed(t.errorText(e)));
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
 * One size notice slot (I3): if the pre-save check is warn or over-limit, replace with that text; if ok, keep the byte-based notice from open as is.
 */
function updateSizeNotice(heap: SaveHeapEstimate): void {
  const text = sizeLimitNotice(heap, t);
  if (text) setNotice('size', text);
}

/** core journal limit check (contract D4). If not received, only a diagnostic log is left and null is returned (no recommendation). */
async function queryJournalAdvice(): Promise<JournalAdvice | null> {
  try {
    return await pdf.journalAdvice();
  } catch (e) {
    diag.add('journal-advice-error', String(e));
    return null;
  }
}

/** After an edit commit, queries the journal limit and updates the "저장 후 다시 열기" (save and reopen) notice (contract D4, docs/m5-heap.md 5.3). */
async function reportJournal(): Promise<void> {
  const advice = await queryJournalAdvice();
  if (!advice) return;
  diag.add('journal-advice', advice);
  setNotice('journal', journalNotice(advice, t));
}

/** Returns the commit RPC result as is, and does the journal check afterward without waiting for it. */
function afterCommit(result: CommitResult): CommitResult {
  void reportJournal();
  return result;
}

/** Whether this is a recovery notice error (the Worker died during a save and was recovered). Also handles the save target returning the error wrapped in a string. */
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
    setStatus('error', t.statusSaveFailed(t.errorText(e)));
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
  // Contract D4: if the user save succeeds, those bytes become the recovery checkpoint.
  if (outcome.status === 'saved') pdf.confirmSaved();
  else pdf.discardPendingSave();
  setStatus(
    outcome.status,
    outcome.status === 'saved'
      ? t.statusSaved(where, outcome.reusedHandle)
      : outcome.status === 'cancelled'
        ? t.statusSaveCancelled
        : t.statusSaveFailed(
            outcome.errorCode
              ? t.saveErrors[outcome.errorCode]
              : outcome.error !== null
                ? t.errorText(outcome.error)
                : where,
          ),
  );
  if (outcome.status === 'saved' && lastPlanHadEdits && !historyNoticeShown) {
    historyNoticeShown = true;
    setNotice('history', t.historyAfterSave);
  }
}

/** After recovery from a Worker dying during a save (contract 5.8, A3-3): asks whether to save again. */
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

/** M0 diagnostics: measures full-save time and WASM heap in the browser Worker (the file is not saved). */
async function benchFullSave(): Promise<void> {
  setStatus('saving', t.statusBenchSaving, true);
  const r = await pdf.save({ changes: ['content-stream'] });
  pdf.discardPendingSave(); // the measurement save is not a recovery checkpoint
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
 * Save menu (user request 2026-10-22): "저장" (Save) / "다른 이름으로 저장" (Save As) / (dev builds only) downloads save.
 * The downloads save (M0 diagnostics) is dropped from the store build's viewer.html (vite.config.ts), and the branch below also disappears from the store bundle.
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
  // Ctrl+S saves directly without the menu (Ctrl+Shift+S is Save As).
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

/** After the first page is drawn on the canvas: status display and enabling save. Later pages only leave diagnostic records. */
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
  // Render elapsed is a dev indicator (the page count is in the toolbar "/ N").
  setStatus('rendered', t.statusRendered(e.pageCount, e.pageIndex + 1), true);
}

async function openBytes(bytes: ArrayBuffer, label: string): Promise<void> {
  setStatus('opening', t.statusOpening(label));
  // Clean up the previous document's viewer first. The Worker session closes the previous document in open, so if the previous viewer
  // requests render or extract in between, the call targets the new document (or a closed one).
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
  // The original is kept as a Blob by the recovery layer before open, then handed to the Worker (contract D6).
  const info = await pdf.open(bytes);
  diag.add('open', info);
  // Size notice (I3, user decision 2026-10-21): show the byte-based notice once on open; the pre-save check changes the same slot.
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
      // Fit to the width minus the left/right page arrow slots (so arrows do not cover the page). In a narrow window the arrows overlap the page edge and
      // the slot share is not subtracted (viewer-ui `pageArrowLayout`, same decision as data-pe-arrows on the mount).
      availableWidth: pageArrowLayout(pageContainerEl.clientWidth).availableWidth,
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
  // If the first page cannot be drawn, treat it as an open failure (in the MIME handler, hand off to Chrome's default viewer).
  if (!view) throw new Error(renderError ?? '첫 페이지 렌더 실패');
  void reportRedactAnnots();
  void reportSizeLimit();
}

/** Right after open, issues the supported-size notice from the pre-save check (pre-edit estimate). If the check is not received, only a diagnostic log is left. */
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

/** Redact annotation report on open (A2-2). If the report is not received, only a diagnostic log is left. */
async function reportRedactAnnots(): Promise<void> {
  const report = await pdf.tryListRedactAnnots();
  if (report === null) {
    diag.add('redact-report-unavailable', 'listRedactAnnots 실패(A2-2)');
    return;
  }
  diag.add('redact-report', report);
  setNotice('redact', redactNotice(report, t));
}

/** If file:// access is off on the DNR fallback path, shows guidance (A5-3). */
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
    // Header zoom compensation does not wait for the document to arrive.
    onContext: (kind, streamInfo) => {
      attachHeaderZoom(kind, streamInfo).catch((e: unknown) =>
        diag.add('header-zoom-error', String(e)),
      );
    },
  });
  contextKind = source.kind;
  // The context name is not shown on screen; it is left on body for tests and diagnostics.
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
    // Like Chrome's default PDF viewer, make Ctrl+A, C and F reach the viewer right after opening. The MIME handler viewer is a child frame of the PDF URL
    // page, so it must take focus directly. Embedded contexts do not steal the outer page's focus.
    // Take it before opening: controller.start() waits for the editability check (including fallback font loading) and finishes late,
    // so taking focus after that would miss shortcuts pressed right after the text layer appears (M3 integration e2e, 2026-10-20).
    if (source.kind === 'mime-handler-top') window.focus();
    try {
      await openBytes(source.bytes, fileLabel(source.displayUrl));
      if (source.kind === 'mime-handler-top') window.focus();
    } catch (e) {
      diag.add('open-error', String(e));
      if (source.streamInfo) {
        // Unsupported document: hand off to Chrome's default viewer. Later code is not executed.
        await chrome.mimeHandler.abortAndFallbackToNativeHandler();
        return;
      }
      setStatus('error', t.statusOpenFailed(t.errorText(e)));
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
        setStatus('error', t.statusOpenFailed(t.errorText(e)));
      });
  });
}

main().catch((e: unknown) => {
  diag.add('fatal', String(e));
  setStatus('error', t.errorText(e));
});
