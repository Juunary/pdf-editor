/**
 * M5 benchmark page (contract 4.1). As an in-extension diagnostic feature, it is run manually from `bench.html` in the unpacked `dist`
 * (no pnpm or Node needed). Server-side Playwright also drives the same page via `window.__bench`.
 *
 * Manual: select documents → select metrics → run. The memory scenario pauses at the checkpoint and end points, so read this extension's viewer frame row value from Task Manager (Shift+Esc)
 * "메모리 사용 공간" (Memory footprint), enter it and continue. When finished, export the result JSON.
 */
import { benchDocOfFile, parseTabInput, tabInputWarnings, type TabUnit } from './bench-input.js';
import { M5_EVENTS } from './bench-marks.js';
import { TARGETS_MS, type Summary } from './bench-stats.js';
import {
  ALL_SCENARIOS,
  BenchRunner,
  DEFAULT_OPTIONS,
  type BenchDoc,
  type BenchHooks,
  type BenchOptions,
  type DocResult,
  type Scenario,
  type TabReading,
} from './bench-run.js';

export const RESULT_SCHEMA = 'm5-bench/2';

export interface BenchResult {
  schema: typeof RESULT_SCHEMA;
  startedAt: string;
  finishedAt: string;
  mode: 'manual' | 'auto';
  env: Record<string, unknown>;
  options: BenchOptions;
  targetsMs: typeof TARGETS_MS;
  events: typeof M5_EVENTS;
  docs: DocResult[];
  /** `<document>.<metric>` → p95 (ms). Key for comparison with the previous record. */
  p95: Record<string, number>;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 없음`);
  return el as T;
}

function p95Map(docs: readonly DocResult[]): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (id: string, key: string, s: Summary | undefined) => {
    if (s && s.n > 0) out[`${id}.${key}`] = s.p95;
  };
  for (const d of docs) {
    put(d.id, 'open', d.open?.summary);
    put(d.id, 'nav', d.nav?.all.summary);
    put(d.id, 'judge', d.judge?.first.summary);
    put(d.id, 'judgeReuse', d.judge?.reuse.summary);
    put(d.id, 'edit', d.edit?.summary);
    put(d.id, 'path', d.path?.summary);
    put(d.id, 'save', d.save?.clean.summary);
  }
  return out;
}

function environment(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: nav.deviceMemory ?? null,
    devicePixelRatio: window.devicePixelRatio,
    viewport: [window.innerWidth, window.innerHeight],
    extensionVersion: chrome.runtime.getManifest().version,
  };
}

function spawnWorker(): Worker {
  return new Worker(new URL('../worker/pdf-worker.ts', import.meta.url), { type: 'module' });
}

const statusEl = byId<HTMLSpanElement>('bench-status');
const summaryEl = byId<HTMLPreElement>('bench-summary');
const runBtn = byId<HTMLButtonElement>('bench-run');
const exportBtn = byId<HTMLButtonElement>('bench-export');
const continueBtn = byId<HTMLButtonElement>('bench-continue');
const manualEl = byId<HTMLParagraphElement>('bench-manual');
const manualInput = byId<HTMLInputElement>('bench-manual-value');
const manualUnit = byId<HTMLSelectElement>('bench-manual-unit');
const manualWarn = byId<HTMLSpanElement>('bench-manual-warning');
const manualLabel = byId<HTMLSpanElement>('bench-manual-label');
const filesInput = byId<HTMLInputElement>('bench-files');
const fileList = byId<HTMLSpanElement>('bench-file-list');

function setStatus(state: string, text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

/** Server automation returns the renderer VmRSS (MiB) via `page.exposeFunction('benchTabMemory', ...)`. */
type AutoMemory = (label: string, docId: string) => Promise<number | null>;
/** Server automation returns the tab memory breakdown (MiB) via `page.exposeFunction('benchTabDetail', ...)`. */
type AutoDetail = (label: string, docId: string) => Promise<Record<string, number | null> | null>;

/** RAM (MiB) reported by the browser. null if unknown. */
function ramMiB(): number | null {
  const gib = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof gib === 'number' && gib > 0 ? gib * 1024 : null;
}

/** One manual input: takes the Task Manager value and converts it to MiB. If there is a warning, the same value must be submitted once more to proceed. */
async function readManualTab(
  docId: string,
  name: string,
  previous: readonly number[],
): Promise<TabReading> {
  setStatus('waiting', `${docId}: 탭 메모리(${name}) 입력 대기`);
  manualLabel.textContent = name;
  manualEl.hidden = false;
  continueBtn.hidden = false;
  manualInput.value = '';
  manualWarn.textContent = '';
  manualInput.focus();
  let confirmed: string | null = null;
  try {
    for (;;) {
      await new Promise<void>((resolve) =>
        continueBtn.addEventListener('click', () => resolve(), { once: true }),
      );
      const parsed = parseTabInput(manualInput.value, manualUnit.value as TabUnit);
      if (parsed.mib === null) {
        manualWarn.textContent =
          '숫자를 읽지 못했습니다. 작업 관리자 값(예: 272,940K)을 넣어 주세요.';
        confirmed = null;
        continue;
      }
      const warnings = tabInputWarnings(parsed.mib, previous, ramMiB());
      const key = `${parsed.raw}|${parsed.unit}`;
      if (warnings.length > 0 && confirmed !== key) {
        // Pressing again with the same value records the warning and proceeds.
        confirmed = key;
        manualWarn.textContent = `${parsed.mib.toFixed(1)} MiB: ${warnings.join(' / ')}. 맞으면 그대로 다시 "입력했음, 계속".`;
        continue;
      }
      return { mib: parsed.mib, raw: parsed.raw, unit: parsed.unit, warnings };
    }
  } finally {
    manualEl.hidden = true;
    continueBtn.hidden = true;
  }
}

/** Collects manual input values (MiB) per document and uses them as the baseline for warnings on the next input. */
const manualHistory = new Map<string, number[]>();

function makeHooks(auto: AutoMemory | null): BenchHooks {
  return {
    progress: (text) => setStatus('running', text),
    tabMemoryMiB: async (label, docId) => {
      if (auto) return auto(label, docId);
      const name =
        label === 'baseline' ? '기준점' : label === 'end' ? '종료 직후' : '종료 30초 뒤(판정값)';
      const previous = label === 'baseline' ? [] : (manualHistory.get(docId) ?? []);
      const reading = await readManualTab(docId, name, previous);
      if (reading.mib !== null) manualHistory.set(docId, [...previous, reading.mib]);
      return reading;
    },
    samplePhase: auto ? (label, docId) => auto(`phase:${label}`, docId) : undefined,
    sampleDetail:
      auto && window.benchTabDetail
        ? (label, docId) => window.benchTabDetail!(label, docId)
        : undefined,
    targets: { controls: byId('viewer-controls'), pages: byId('page-container') },
    // Use the scroll box (#page-container) width as the viewer (main.ts) does (the width excluding the document-area scrollbar, not the window scrollbar).
    availableWidth: () => Math.min(byId('page-container').clientWidth, 1100),
    spawnWorker,
  };
}

async function runBench(
  docs: readonly BenchDoc[],
  options: BenchOptions,
  auto: AutoMemory | null,
): Promise<BenchResult> {
  const startedAt = new Date().toISOString();
  const results = await new BenchRunner(makeHooks(auto), options).run(docs);
  return {
    schema: RESULT_SCHEMA,
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: auto ? 'auto' : 'manual',
    env: environment(),
    options,
    targetsMs: TARGETS_MS,
    events: M5_EVENTS,
    docs: results,
    p95: p95Map(results),
  };
}

function render(result: BenchResult): string {
  const rows = result.docs.map((d) => {
    const f = (s: Summary | undefined) => (s && s.n > 0 ? `${s.p95.toFixed(0)}` : '-');
    return [
      d.id,
      d.pageCount ?? '-',
      f(d.open?.summary),
      f(d.nav?.all.summary),
      f(d.judge?.first.summary),
      f(d.edit?.summary),
      d.skipped?.path ? '해당 없음' : f(d.path?.summary),
      f(d.save?.clean.summary),
      d.mem?.wasmHeapDeltaMiB?.toFixed(1) ?? '-',
      d.mem?.tabDeltaMiB?.toFixed(1) ?? '-',
      d.errors.length,
    ].join(' | ');
  });
  return [
    '문서 | 쪽 | 열기 | 넘김 | 판정 | 편집 | 패스 | 저장 (p95 ms) | WASM Δ MiB(캐시 비운 뒤) | 탭 Δ MiB(30초 뒤) | 오류',
    ...rows,
  ].join('\n');
}

let lastResult: BenchResult | null = null;
let selected: File[] = [];

filesInput.addEventListener('change', () => {
  selected = [...(filesInput.files ?? [])];
  fileList.textContent = selected
    .map((f) => `${f.name} (${(f.size / 2 ** 20).toFixed(1)} MiB)`)
    .join(', ');
  runBtn.disabled = selected.length === 0;
});

runBtn.addEventListener('click', () => {
  const scenarios = [...document.querySelectorAll<HTMLInputElement>('[data-scenario]')]
    .filter((c) => c.checked)
    .map((c) => c.dataset.scenario as Scenario);
  // For a bench-set document, pass the same designated pages as the server run (e.g. the largest-path page of kogl-mods-cpi-202609) to page classification and breakdown.
  const docs: BenchDoc[] = selected.map((f) => ({
    ...benchDocOfFile(f.name),
    name: f.name,
    bytes: f.size,
    load: () => f.arrayBuffer(),
  }));
  runBtn.disabled = true;
  exportBtn.disabled = true;
  // For tests: `bench.html?settle=<ms>` changes the wait after memory end (manual input flow e2e). Actual measurement defaults to 30 s.
  const settle = Number(new URLSearchParams(location.search).get('settle') ?? NaN);
  const mem =
    Number.isFinite(settle) && settle >= 0
      ? { ...DEFAULT_OPTIONS.mem, settleMs: settle }
      : DEFAULT_OPTIONS.mem;
  runBench(docs, { ...DEFAULT_OPTIONS, scenarios, mem }, null)
    .then((r) => {
      lastResult = r;
      summaryEl.textContent = render(r);
      exportBtn.disabled = false;
      setStatus('done', '완료. 결과 JSON 을 내보내 회신하세요');
    })
    .catch((e: unknown) => setStatus('error', String(e)))
    .finally(() => (runBtn.disabled = selected.length === 0));
});

exportBtn.addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `m5-bench-${lastResult.startedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

setStatus('idle', 'PDF 파일을 선택하세요');

export interface BenchApi {
  /** For server automation. Downloads the PDF at `url` and runs (server must allow CORS). */
  run(
    docs: readonly {
      id: string;
      name: string;
      url: string;
      bytes: number;
      judgePages?: number[];
    }[],
    options?: Partial<BenchOptions>,
  ): Promise<BenchResult>;
  scenarios: readonly Scenario[];
}

declare global {
  interface Window {
    __bench: BenchApi;
    benchTabMemory?: AutoMemory;
    benchTabDetail?: AutoDetail;
  }
}

window.__bench = {
  scenarios: ALL_SCENARIOS,
  run: async (docs, options) => {
    const merged: BenchOptions = { ...DEFAULT_OPTIONS, ...options };
    const list: BenchDoc[] = docs.map((d) => ({
      id: d.id,
      name: d.name,
      bytes: d.bytes,
      judgePages: d.judgePages,
      load: async () => (await fetch(d.url)).arrayBuffer(),
    }));
    const auto: AutoMemory = (label, docId) =>
      window.benchTabMemory ? window.benchTabMemory(label, docId) : Promise.resolve(null);
    lastResult = await runBench(list, merged, auto);
    summaryEl.textContent = render(lastResult);
    exportBtn.disabled = false;
    setStatus('done', '완료');
    return lastResult;
  },
};
