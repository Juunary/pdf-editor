/**
 * M5 벤치마크 페이지(계약 4.1). 확장 안 진단 기능이라 압축해제 `dist` 의 `bench.html` 에서 수동으로 실행한다
 * (pnpm·Node 불필요). 서버 Playwright 도 같은 페이지의 `window.__bench` 로 돌린다.
 *
 * 수동: 문서 선택 → 지표 선택 → 실행. 메모리 시나리오는 기준점·종료 시점에 멈추므로 작업 관리자(Shift+Esc)의
 * "메모리 사용 공간"에서 이 확장 뷰어 프레임 행 값을 읽어 넣고 계속한다. 끝나면 결과 JSON 을 내보낸다.
 */
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
} from './bench-run.js';

export const RESULT_SCHEMA = 'm5-bench/1';

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
  /** `<문서>.<지표>` → p95(ms). 직전 기록과 비교하는 키. */
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
const manualInput = byId<HTMLInputElement>('bench-manual-mib');
const filesInput = byId<HTMLInputElement>('bench-files');
const fileList = byId<HTMLSpanElement>('bench-file-list');

function setStatus(state: string, text: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = text;
}

/** 서버 자동화가 `page.exposeFunction('benchTabMemory', ...)` 로 렌더러 VmRSS(MiB)를 돌려준다. */
type AutoMemory = (label: string, docId: string) => Promise<number | null>;

function makeHooks(auto: AutoMemory | null): BenchHooks {
  return {
    progress: (text) => setStatus('running', text),
    tabMemoryMiB: async (label, docId) => {
      if (auto) return auto(label, docId);
      setStatus(
        'waiting',
        `${docId}: 탭 메모리(${label === 'baseline' ? '기준점' : '종료'}) 입력 대기`,
      );
      manualEl.hidden = false;
      continueBtn.hidden = false;
      manualInput.value = '';
      manualInput.focus();
      await new Promise<void>((resolve) =>
        continueBtn.addEventListener('click', () => resolve(), { once: true }),
      );
      manualEl.hidden = true;
      continueBtn.hidden = true;
      const v = manualInput.valueAsNumber;
      return Number.isFinite(v) ? v : null;
    },
    targets: { controls: byId('viewer-controls'), pages: byId('page-container') },
    availableWidth: () => Math.min(document.documentElement.clientWidth, 1100),
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
      f(d.path?.summary),
      f(d.save?.clean.summary),
      d.mem?.wasmHeapDeltaMiB?.toFixed(1) ?? '-',
      d.mem?.tabDeltaMiB?.toFixed(1) ?? '-',
      d.errors.length,
    ].join(' | ');
  });
  return [
    '문서 | 쪽 | 열기 | 넘김 | 판정 | 편집 | 패스 | 저장 (p95 ms) | WASM Δ MiB | 탭 Δ MiB | 오류',
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
  const docs: BenchDoc[] = selected.map((f) => ({
    id: f.name.replace(/\.pdf$/i, ''),
    name: f.name,
    bytes: f.size,
    load: () => f.arrayBuffer(),
  }));
  runBtn.disabled = true;
  exportBtn.disabled = true;
  runBench(docs, { ...DEFAULT_OPTIONS, scenarios }, null)
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
  /** 서버 자동화용. `url` 의 PDF 를 내려받아 실행한다(CORS 허용 서버). */
  run(
    docs: readonly { id: string; name: string; url: string; bytes: number }[],
    options?: Partial<BenchOptions>,
  ): Promise<BenchResult>;
  scenarios: readonly Scenario[];
}

declare global {
  interface Window {
    __bench: BenchApi;
    benchTabMemory?: AutoMemory;
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
