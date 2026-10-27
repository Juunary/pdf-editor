/**
 * M5 benchmark scenario runner (contract 4.1, D1). Builds the same configuration as the viewer (Worker + ViewerController + mounted viewer UI) and
 * measures time with metric events (`m5:*`). `bench.ts` handles the DOM wiring and file input.
 *
 * Scenarios are independent per document; an error in one scenario is recorded in `errors` and the run moves on to the next.
 */
import { transferBytes, wrapPdfWorker, type PdfWorkerClient } from '@pdf-editor/core/client';
import {
  ViewerController,
  emptyPathEdit,
  flattenPath,
  mountViewer,
  pickPath,
  renderScale,
  PAGE_ARROW_GUTTER,
  STROKE_HIT_PX,
  type PagePaintedEvent,
  type PathCandidate,
  type ViewerHost,
} from '@pdf-editor/viewer-ui';
import type { Matrix, Point } from '@pdf-editor/shared-types';
import { M5_EVENTS, M5_JUDGE_PATHS_READY, mark } from './bench-marks.js';
import {
  MEM_LIMITS_MIB,
  judgeTarget,
  summarize,
  type Summary,
  type TargetKey,
  type Verdict,
} from './bench-stats.js';

export type Scenario = 'open' | 'nav' | 'judge' | 'edit' | 'path' | 'save' | 'mem';
export const ALL_SCENARIOS: readonly Scenario[] = [
  'open',
  'nav',
  'judge',
  'edit',
  'path',
  'save',
  'mem',
];

export interface BenchOptions {
  scenarios: readonly Scenario[];
  /** Number of open and save repetitions. */
  repeats: { open: number; save: number; breakdown: number };
  /** Number of sequential page turns and number of random jumps. */
  nav: { steps: number; jumps: number };
  /** Number of pages to time for page classification (spread evenly across the document). */
  judgePages: number;
  /** Edit response: number of characters typed. */
  editChars: number;
  /** Number of path drag steps. */
  pathSteps: number;
  /**
   * Memory round trip: number of pages turned (round trip), edit count, save count, end tab memory wait (ms, user decision 2026-10-21 = 30 s).
   * `probePhases` is for diagnostics: also measures the in-use heap after clearing the cache after page turns and after edits (the definition of the judged value is unchanged).
   */
  mem: { pages: number; edits: number; saves: number; settleMs: number; probePhases?: boolean };
  /** Override of the render cache limit (for comparison experiments). Defaults to 8 pages, 64 MiB if absent. */
  renderCache?: { maxPages: number; maxBytes: number };
  /** Turn off pre-rendering (for comparison experiments). */
  prefetch?: boolean;
}

export const DEFAULT_OPTIONS: BenchOptions = {
  scenarios: ALL_SCENARIOS,
  repeats: { open: 5, save: 3, breakdown: 3 },
  nav: { steps: 20, jumps: 10 },
  judgePages: 6,
  editChars: 30,
  pathSteps: 40,
  mem: { pages: 50, edits: 20, saves: 2, settleMs: 30_000 },
};

export interface BenchDoc {
  id: string;
  name: string;
  bytes: number;
  /** Pages that must be included in the page classification test (0-based, the page with the largest path, etc.). */
  judgePages?: number[];
  load(): Promise<ArrayBuffer>;
}

export interface BenchHooks {
  /** Progress text. */
  progress(text: string): void;
  /**
   * Receives tab memory (MiB) at a memory sample point. In a manual run the user enters the Task Manager value (and the raw input, unit and warnings are
   * returned together); server automation reads the renderer VmRSS. null if there is no value.
   */
  tabMemoryMiB(
    label: 'baseline' | 'end' | 'end-settled',
    docId: string,
  ): Promise<number | TabReading | null>;
  /** Automatic tab memory sample at an intermediate point (absent in manual runs). */
  samplePhase?(label: string, docId: string): Promise<number | null>;
  /**
   * Tab memory breakdown at an intermediate point (server automation only): renderer VmRSS, page and Worker JS heaps (CDP `Runtime.getHeapUsage`), WASM linear memory,
   * etc. as MiB values. Absent in manual runs.
   */
  sampleDetail?(label: string, docId: string): Promise<Record<string, number | null> | null>;
  /** DOM to mount the viewer on. */
  targets: { controls: HTMLElement; pages: HTMLElement };
  /** Page area width (CSS px). */
  availableWidth(): number;
  /** Creates the work module. */
  spawnWorker(): Worker;
}

export interface Measured {
  samples: number[];
  summary: Summary;
  verdict: Verdict | null;
}

export interface DocResult {
  id: string;
  name: string;
  bytes: number;
  pageCount: number | null;
  open?: Measured & { workerOpenMs: number[] };
  nav?: { seq: Measured; jump: Measured; all: Measured };
  /** Page classification. `pages` and `reusePages` are the pages timed in the order of the first-entry and re-entry samples (0-based). */
  judge?: {
    first: Measured;
    reuse: Measured;
    pages: number[];
    reusePages: number[];
    breakdown: JudgeBreakdown[];
  };
  /**
   * Edit response. For each draft update RPC during that time, `updates` holds the round-trip time (`rpcMs`), the in-Worker update time (`workerMs` = reflow, write and
   * region render, `DraftUpdate.updateMs`) and the region size (px). It is not 1:1 with the response samples (when input piles up, only the last input is sent).
   */
  edit?: Measured & {
    page: number;
    paragraphId: number;
    renderScale: number | null;
    updates: { rpcMs: number; workerMs: number; regionPx: number }[];
  };
  path?: Measured & { page: number; paintSeq: number; serverUpdateMs: number[] };
  save?: { clean: Measured; edited: Measured | null; saveMs: number[]; wasmHeapBytes: number[] };
  mem?: MemResult;
  /** Not applicable (scenario with nothing to measure) and its reason. Distinguished from errors. */
  skipped?: Partial<Record<Scenario, string>>;
  errors: string[];
}

export interface JudgeBreakdown {
  pageIndex: number;
  extractMs: number;
  extractSegmentsMs: number;
  sourceMapMs: number;
  linkMs: number;
  layoutMs: number;
  /** getPageEditability after all of the above caches are warm. */
  judgeWarmMs: number;
  /** All getPageEditability calls on other pages without a cache. */
  judgeColdMs: number;
  /** Classification time reported by core (`PageEditability.ms`, warm call). */
  coreReportedMs: number;
  /** The value is the median of `reps` repetitions (new sessions). */
  reps: number;
}

/** One read of tab memory. A manual run keeps the raw input, unit and warnings. */
export interface TabReading {
  mib: number | null;
  /** Raw manual input (the Task Manager value as is). */
  raw?: string;
  /** Input unit. `K` is the Chrome Task Manager display (1 K = 1024 byte); server automation uses `VmRSS`. */
  unit?: 'K' | 'MiB' | 'VmRSS';
  /** Input warnings (same as previous value, all three values the same, over RAM, 5x or more the previous value, etc.). The user confirmed and proceeded. */
  warnings?: string[];
}

/** One edit in the memory round trip (the target and the journal retention estimate after commit). */
export interface MemEdit {
  pageIndex: number;
  /** Paragraph ids of this page classification list (the list received once per page). Starts with this id even if the layout changes after earlier edits. */
  paragraphId: number;
  /** The target of the started edit was an already-edited block (re-edit). null if the edit could not be started. */
  editedBlock: boolean | null;
  /** Number of characters in the target. null if it could not be started. */
  glyphs: number | null;
  committed: boolean;
  /** Journal retention estimate after commit (byte, `journalAdvice`). null if it cannot be queried. */
  journalBytes: number | null;
  /** Start-to-commit time (ms). */
  ms: number;
}

/**
 * Heap of the first save (the save that becomes the checkpoint). Linear memory does not shrink, so the post-save value is an upper bound of the save peak. If it equals the pre-save value, the save
 * finished inside already-grown linear memory and the peak cannot be seen this way (`grewHeap: false`). The prediction is planSave just before saving (D5).
 */
export interface FirstSaveHeap {
  /** Linear memory just before saving (byte, planSave's in-use heap = the current heap for the first save). */
  heapBeforeBytes: number | null;
  /** Linear memory just after saving (byte). Upper bound of the save peak. */
  heapAfterBytes: number | null;
  /** D5 estimated peak (byte). */
  predictedPeakBytes: number | null;
  /** The save grew linear memory (the peak shows in the post-save value). */
  grewHeap: boolean | null;
  /** Post-save linear memory (peak upper bound) ≤ estimated peak. */
  withinPrediction: boolean | null;
}

/**
 * Memory round-trip result (contract 1.1, D1). End measurement point (user decision 2026-10-21): WASM is the in-use heap after clearing the MuPDF cache (`emptyStore`),
 * and tab memory is judged by the value after a 30 s wait. Values before clearing (linear memory) and before the wait are also kept.
 */
export interface MemResult {
  baseline: {
    /** Linear memory just after the first save (byte). */
    wasmHeapBytes: number | null;
    /** In-use heap after `emptyStore` just after the first save (byte, bench RPC). */
    wasmUsedBytes: number | null;
    tabMiB: number | null;
  };
  end: {
    /** Linear memory after the last save (byte). */
    wasmHeapBytes: number | null;
    /** In-use heap after the end `emptyStore` (byte). */
    wasmUsedBytes: number | null;
    /** Tab memory just after the end (before the wait). */
    tabMiB: number | null;
    /** Tab memory after the 30 s wait at the end (judged value). */
    tabSettledMiB: number | null;
  };
  /** Judged value: increase in in-use heap (after `emptyStore`). */
  wasmHeapDeltaMiB: number | null;
  /** Value before clearing: increase in linear memory (former definition). */
  wasmLinearDeltaMiB: number | null;
  /** Judged value: increase in tab memory after the 30 s wait. */
  tabDeltaMiB: number | null;
  /** Value before the wait: increase in tab memory just after the end (former definition). */
  tabDeltaBeforeWaitMiB: number | null;
  /** Tab memory after a forced GC at the end (server CDP) − checkpoint. Separates collectable garbage from retained memory. Absent in manual runs. */
  tabDeltaAfterGcMiB: number | null;
  /** End wait time (ms). */
  settleMs: number;
  navigations: number;
  edits: number;
  saves: number;
  pass: { wasmHeap: boolean | null; tab: boolean | null };
  /**
   * Linear memory just after the first save (byte) = `firstSave.heapAfterBytes`. The checkpoint is right after the first save, so it always equals `baseline.wasmHeapBytes`
   * (pre-save value and prediction are in `firstSave`).
   */
  firstSavePeakHeapBytes: number | null;
  firstSave: FirstSaveHeap;
  /** Edit target and journal retention estimate after commit. */
  editLog: MemEdit[];
  /** Tab memory reads (checkpoint, right after end, after 30 s). In a manual run, the raw input, unit and warnings. */
  tabInputs: (TabReading & { label: string })[];
  /** Samples for analyzing the cause of growth per phase (tab memory exists only in automated runs). */
  phases: {
    name: string;
    wasmHeapBytes: number | null;
    /** With `probePhases`, the in-use heap after clearing the cache (byte). The checkpoint and end are always measured. */
    wasmUsedBytes?: number | null;
    tabMiB: number | null;
    jsHeapMiB: number | null;
    /** Tab memory breakdown (server automation, `sampleDetail`). */
    detail?: Record<string, number | null> | null;
  }[];
}

/** Bench-only Worker RPC (dev build, `@pdf-editor/core/bench`). null if absent (older build). */
async function probeHeap(pdf: PdfWorkerClient, emptyStore: boolean): Promise<number | null> {
  const remote = pdf as unknown as {
    benchProbeHeap?: (o: { emptyStore: boolean }) => Promise<{ usedBytes: number } | null>;
  };
  try {
    const probe = await remote.benchProbeHeap?.({ emptyStore });
    return probe?.usedBytes ?? null;
  } catch {
    return null;
  }
}

interface Opened {
  worker: Worker;
  pdf: PdfWorkerClient;
  controller: ViewerController;
  pageCount: number;
  firstPaint: Promise<PagePaintedEvent>;
  workerOpenMs: number;
  painted: PaintWaiters;
  /** Record of draft update RPCs sent by the viewer (for building the edit response breakdown). */
  draftUpdates: { rpcMs: number; workerMs: number; regionPx: number }[];
  dispose(): void;
}

class PaintWaiters {
  private waiters = new Map<number, Array<(e: PagePaintedEvent) => void>>();
  onPainted = (e: PagePaintedEvent): void => {
    const list = this.waiters.get(e.pageIndex);
    if (!list) return;
    this.waiters.delete(e.pageIndex);
    for (const fn of list) fn(e);
  };
  wait(pageIndex: number): Promise<PagePaintedEvent> {
    return new Promise((resolve) => {
      const list = this.waiters.get(pageIndex) ?? [];
      list.push(resolve);
      this.waiters.set(pageIndex, list);
    });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doubleRaf = () =>
  new Promise<number>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
  );
const MiB = 2 ** 20;

/** Fixed-seed random numbers (so the random jump order is the same on every run). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function measured(samples: number[], key: TargetKey | null, pageCount: number | null): Measured {
  const summary = summarize(samples);
  return {
    samples,
    summary,
    verdict: key && pageCount !== null ? judgeTarget(key, summary, pageCount) : null,
  };
}

function evenlySpaced(pageCount: number, count: number, skip: number): number[] {
  const n = Math.min(count, Math.max(1, pageCount - skip));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      skip + Math.min(pageCount - skip - 1, Math.floor(((i + 0.5) * (pageCount - skip)) / n)),
    );
  }
  return [...new Set(out)];
}

/** Per-page median across repeated runs. */
function medianBreakdown(runs: readonly JudgeBreakdown[][]): JudgeBreakdown[] {
  const first = runs[0] ?? [];
  const keys = [
    'extractMs',
    'extractSegmentsMs',
    'sourceMapMs',
    'linkMs',
    'layoutMs',
    'judgeWarmMs',
    'judgeColdMs',
    'coreReportedMs',
  ] as const;
  return first.map((row, i) => {
    const out = { ...row, reps: runs.length };
    for (const k of keys) out[k] = summarize(runs.map((r) => r[i]![k])).p50;
    return out;
  });
}

export class BenchRunner {
  constructor(
    private readonly hooks: BenchHooks,
    private readonly options: BenchOptions = DEFAULT_OPTIONS,
  ) {}

  async run(docs: readonly BenchDoc[]): Promise<DocResult[]> {
    const results: DocResult[] = [];
    for (const doc of docs) results.push(await this.runDoc(doc));
    return results;
  }

  private async runDoc(doc: BenchDoc): Promise<DocResult> {
    const result: DocResult = {
      id: doc.id,
      name: doc.name,
      bytes: doc.bytes,
      pageCount: null,
      errors: [],
    };
    const want = (s: Scenario) => this.options.scenarios.includes(s);
    const guard = async (name: string, fn: () => Promise<void>) => {
      this.hooks.progress(`${doc.id}: ${name}`);
      try {
        await fn();
      } catch (e) {
        result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    let bytes: ArrayBuffer;
    try {
      bytes = await doc.load();
    } catch (e) {
      result.errors.push(`load: ${String(e)}`);
      return result;
    }

    if (want('open')) await guard('open', () => this.scenarioOpen(bytes, result));
    // The remaining scenarios share one common session (memory and breakdown use their own sessions).
    const needShared = (['nav', 'edit', 'path', 'save'] as const).some(want);
    if (needShared) {
      let o: Opened | null = null;
      await guard('open-shared', async () => {
        o = await this.openDoc(bytes.slice(0));
        result.pageCount = o.pageCount;
      });
      if (o) {
        const opened: Opened = o;
        if (want('nav')) await guard('nav', () => this.scenarioNav(opened, result));
        if (want('edit')) await guard('edit', () => this.scenarioEdit(opened, result));
        if (want('path')) await guard('path', () => this.scenarioPath(opened, result));
        if (want('save')) await guard('save', () => this.scenarioSave(opened, result));
        opened.dispose();
      }
    }
    if (want('judge')) {
      // First-entry classification needs an empty cache, so it is timed in a new session. The breakdown is also a new session.
      await guard('judge', async () => {
        const o = await this.openDoc(bytes.slice(0));
        try {
          result.pageCount ??= o.pageCount;
          await this.scenarioJudge(o, result, doc.judgePages ?? []);
        } finally {
          o.dispose();
        }
      });
      await guard('judge-breakdown', async () => {
        const reps = this.options.repeats.breakdown;
        const runs: JudgeBreakdown[][] = [];
        for (let r = 0; r < reps; r++) {
          const { pages, cold } = await this.coldPass(bytes, doc.judgePages ?? []);
          const o = await this.openDoc(bytes.slice(0));
          try {
            runs.push(await this.breakdown(o, cold, pages));
          } finally {
            o.dispose();
          }
        }
        if (result.judge) result.judge.breakdown = medianBreakdown(runs);
      });
    }
    if (want('mem')) await guard('mem', () => this.scenarioMem(doc, bytes, result));
    return result;
  }

  // ── Open document (same configuration as the viewer) ──────────────────────────────────────

  private async openDoc(bytes: ArrayBuffer, marks: { onBytes?: () => void } = {}): Promise<Opened> {
    const worker = this.hooks.spawnWorker();
    const pdf = wrapPdfWorker(worker);
    // The viewer starts the Worker before receiving bytes: set the start point after module and WASM loading finish.
    await pdf.close().catch(() => undefined);
    const painted = new PaintWaiters();
    let firstResolve!: (e: PagePaintedEvent) => void;
    const firstPaint = new Promise<PagePaintedEvent>((r) => (firstResolve = r));
    let firstSeen = false;
    marks.onBytes?.();
    const t0 = mark(M5_EVENTS.open.start);
    const info = await pdf.open(transferBytes(bytes));
    const workerOpenMs = performance.now() - t0;
    const draftUpdates: Opened['draftUpdates'] = [];
    const call = (key: string, args: unknown[]) =>
      (pdf as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!(...args);
    const host = new Proxy({} as ViewerHost, {
      get: (_t, key: string) =>
        key === 'log'
          ? () => undefined
          : key === 'updateParagraphDraft'
            ? async (...args: unknown[]) => {
                const t = performance.now();
                const u = (await call(key, args)) as {
                  updateMs: number;
                  region: { width: number; height: number };
                };
                draftUpdates.push({
                  rpcMs: performance.now() - t,
                  workerMs: u.updateMs,
                  regionPx: u.region.width * u.region.height,
                });
                return u;
              }
            : (...args: unknown[]) => call(key, args),
    });
    const controller = new ViewerController({
      host,
      pageCount: info.pageCount,
      renderCacheLimits: this.options.renderCache,
      prefetch: this.options.prefetch,
      getEnvironment: () => ({
        devicePixelRatio: window.devicePixelRatio || 1,
        availableWidth: this.hooks.availableWidth() - 2 * PAGE_ARROW_GUTTER,
      }),
      onPagePainted: (e) => {
        if (!firstSeen) {
          firstSeen = true;
          mark(M5_EVENTS.open.end);
          firstResolve(e);
        }
        painted.onPainted(e);
      },
    });
    const unmount = mountViewer(this.hooks.targets, controller);
    const start = controller.start();
    await firstPaint;
    await start;
    return {
      worker,
      pdf,
      controller,
      pageCount: info.pageCount,
      firstPaint,
      workerOpenMs,
      painted,
      draftUpdates,
      dispose: () => {
        controller.dispose();
        unmount();
        worker.terminate();
      },
    };
  }

  private firstPaintMs(): number {
    const [a] = performance.getEntriesByName(M5_EVENTS.open.start, 'mark').slice(-1);
    const [b] = performance.getEntriesByName(M5_EVENTS.open.end, 'mark').slice(-1);
    return b!.startTime - a!.startTime;
  }

  private async scenarioOpen(bytes: ArrayBuffer, result: DocResult): Promise<void> {
    const samples: number[] = [];
    const workerOpen: number[] = [];
    for (let i = 0; i < this.options.repeats.open; i++) {
      const o = await this.openDoc(bytes.slice(0));
      result.pageCount = o.pageCount;
      samples.push(this.firstPaintMs());
      workerOpen.push(o.workerOpenMs);
      o.dispose();
      await sleep(100);
    }
    result.open = { ...measured(samples, 'open', result.pageCount), workerOpenMs: workerOpen };
  }

  // ── Page turning ──────────────────────────────────────────────────────────

  private async navigate(
    o: Opened,
    pageIndex: number,
  ): Promise<{ ms: number; done: Promise<void> }> {
    const painted = o.painted.wait(pageIndex);
    const t0 = mark(M5_EVENTS.nav.start);
    const done = o.controller.goToPage(pageIndex);
    await painted;
    const t1 = mark(M5_EVENTS.nav.end);
    return { ms: t1 - t0, done };
  }

  private async scenarioNav(o: Opened, result: DocResult): Promise<void> {
    const { steps, jumps } = this.options.nav;
    const seq: number[] = [];
    const jump: number[] = [];
    await o.controller.goToPage(0);
    await sleep(300);
    let p = 0;
    for (let i = 0; i < steps && o.pageCount > 1; i++) {
      const next = (p + 1) % o.pageCount;
      const r = await this.navigate(o, next);
      seq.push(r.ms);
      await r.done;
      // Reading time: during idle, pre-rendering of the next page runs.
      await sleep(300);
      p = next;
    }
    const rand = lcg(20261021);
    for (let i = 0; i < jumps && o.pageCount > 2; i++) {
      let next = Math.floor(rand() * o.pageCount);
      if (Math.abs(next - p) < 2) next = (p + 7) % o.pageCount;
      const r = await this.navigate(o, next);
      jump.push(r.ms);
      await r.done;
      await sleep(100);
      p = next;
    }
    const pc = o.pageCount;
    result.nav = {
      seq: measured(seq, 'nav', pc),
      jump: measured(jump, 'nav', pc),
      all: measured([...seq, ...jump], 'nav', pc),
    };
  }

  // ── Page classification ──────────────────────────────────────────────────────────

  /** Page entry (`judge:page-enter`) → editability check done (`judge:editability-ready`). Timed with the page already visible. */
  private async judgeVisit(o: Opened, pageIndex: number): Promise<number | null> {
    let enter: number | null = null;
    let ready: number | null = null;
    const startView = o.controller.getState().view;
    const done = new Promise<void>((resolve) => {
      const unsub = o.controller.subscribe((s) => {
        if (enter === null && s.view && s.view !== startView && s.view.pageIndex === pageIndex) {
          enter = mark(M5_EVENTS.judge.start);
        }
        const e = s.edit.editability;
        if (enter !== null && ready === null && e.status === 'ready' && e.pageIndex === pageIndex) {
          ready = mark(M5_EVENTS.judge.end);
        }
        const m = s.edit.path.model;
        if (enter !== null && m.status === 'ready' && m.pageIndex === pageIndex) {
          if (
            !performance
              .getEntriesByName(M5_JUDGE_PATHS_READY, 'mark')
              .some((x) => x.startTime >= enter!)
          ) {
            mark(M5_JUDGE_PATHS_READY);
          }
        }
        if (ready !== null || (e.status === 'error' && e.pageIndex === pageIndex)) {
          unsub();
          resolve();
        }
      });
    });
    // When re-entering the same page, clear the page cache (extraction and classification) so it is read again.
    if (o.controller.getState().pageIndex === pageIndex)
      await o.controller.invalidatePages([pageIndex]);
    else await o.controller.goToPage(pageIndex);
    await done;
    return enter !== null && ready !== null ? ready - enter : null;
  }

  private async scenarioJudge(
    o: Opened,
    result: DocResult,
    extra: readonly number[],
  ): Promise<void> {
    const pages = [
      ...new Set([
        ...extra.filter((p) => p < o.pageCount),
        ...evenlySpaced(o.pageCount, this.options.judgePages, o.pageCount > 1 ? 1 : 0),
      ]),
    ];
    const first: number[] = [];
    const reuse: number[] = [];
    const firstPages: number[] = [];
    const away = (p: number) => (p === 0 ? Math.min(1, o.pageCount - 1) : 0);
    for (const p of pages) {
      const ms = await this.judgeVisit(o, p);
      if (ms !== null) {
        first.push(ms);
        firstPages.push(p);
      }
    }
    const reusePages: number[] = [];
    for (const p of pages) {
      await o.controller.goToPage(away(p));
      const ms = await this.judgeVisit(o, p);
      if (ms !== null) {
        reuse.push(ms);
        reusePages.push(p);
      }
    }
    result.judge = {
      first: measured(first, 'judge', o.pageCount),
      reuse: measured(reuse, 'judgeReuse', o.pageCount),
      pages: firstPages,
      reusePages,
      breakdown: [],
    };
  }

  /** Pages to break down: the designated pages + 2 pages spread evenly after the first 8 pages of the document. */
  private breakdownPages(o: Opened, extra: readonly number[]): number[] {
    const total = o.pageCount;
    const even = evenlySpaced(total, 2, Math.min(8, Math.max(0, total - 1)));
    return [...new Set([...extra.filter((p) => p < total), ...even])];
  }

  private async coldPass(
    bytes: ArrayBuffer,
    extra: readonly number[],
  ): Promise<{ pages: number[]; cold: Map<number, number> }> {
    const c = await this.openDoc(bytes.slice(0));
    try {
      const pages = this.breakdownPages(c, extra);
      return { pages, cold: await this.coldJudge(c, pages) };
    } finally {
      c.dispose();
    }
  }

  /** Time of calling `getPageEditability` per page in a new session without a cache (the first time for that page). Common initialization such as font loading is cleared first. */
  private async coldJudge(o: Opened, pages: readonly number[]): Promise<Map<number, number>> {
    await o.pdf.getPageEditability(0).catch(() => undefined);
    const out = new Map<number, number>();
    for (const p of pages) {
      const t0 = performance.now();
      await o.pdf.getPageEditability(p);
      out.set(p, performance.now() - t0);
    }
    return out;
  }

  /**
   * Breakdown of first-entry classification (RPC round-trip times): extraction, SourceMap, linking, layout and classification are timed in order without a cache (new session).
   * The values include the structured clone that returns the result to the main thread (SourceMap and others are large). The pure in-Worker breakdown is
   * measured by `packages/core/bench/judge-breakdown.mjs`.
   * Each step reuses the previous step's result as a cache, so it is "the time that step newly added". `judgeColdMs` is the total time of calling only the classification
   * of the same page for the first time in a separate new session.
   */
  private async breakdown(
    o: Opened,
    cold: Map<number, number>,
    pages: readonly number[],
  ): Promise<JudgeBreakdown[]> {
    const pdf = o.pdf;
    const time = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
      const t0 = performance.now();
      const v = await fn();
      return [v, performance.now() - t0];
    };
    await pdf.getPageEditability(0).catch(() => undefined);
    const out: JudgeBreakdown[] = [];
    for (const p of pages) {
      const [, extractMs] = await time(() => pdf.extractPage({ pageIndex: p }));
      const [, extractSegmentsMs] = await time(() =>
        pdf.extractPage({ pageIndex: p, includePathSegments: true }),
      );
      const [, sourceMapMs] = await time(() => pdf.getSourceMap(p));
      const [, linkMs] = await time(() => pdf.linkPage(p));
      const [, layoutMs] = await time(() => pdf.getPageLayout(p));
      const [e, judgeWarmMs] = await time(() => pdf.getPageEditability(p));
      out.push({
        pageIndex: p,
        extractMs,
        extractSegmentsMs,
        sourceMapMs,
        linkMs,
        layoutMs,
        judgeWarmMs,
        judgeColdMs: cold.get(p) ?? NaN,
        coreReportedMs: e.ms,
        reps: 1,
      });
    }
    return out;
  }

  // ── Edit response and path drag ──────────────────────────────────────────────

  private async findEditableParagraph(
    o: Opened,
    limit = 12,
  ): Promise<{ page: number; paragraphId: number } | null> {
    for (let p = 0; p < Math.min(o.pageCount, limit); p++) {
      const e = await o.pdf.getPageEditability(p);
      const para = e.paragraphs.find((x) => x.editable && !x.cell && x.bbox[2] - x.bbox[0] > 40);
      if (para) return { page: p, paragraphId: para.paragraphId };
    }
    return null;
  }

  private async scenarioEdit(o: Opened, result: DocResult): Promise<void> {
    const target = await this.findEditableParagraph(o);
    if (!target) throw new Error('편집 가능한 문단 없음');
    await o.controller.goToPage(target.page);
    const edit = o.controller.edit;
    if (!edit) throw new Error('편집 호스트 없음');
    const before = performance.getEntriesByName('pe-edit-latency', 'measure').length;
    const updatesFrom = o.draftUpdates.length;
    await edit.begin(target.page, target.paragraphId, null);
    const session = edit.currentSession();
    if (!session) throw new Error('편집 세션이 열리지 않음');
    const text = 'The quick brown fox 다람쥐 헌 쳇바퀴 jumps over 0123456789'.repeat(2);
    for (let i = 0; i < this.options.editChars; i++) {
      session.typeText(text[i % text.length]!);
      await sleep(60);
    }
    await session.settle();
    await sleep(100);
    const samples = performance
      .getEntriesByName('pe-edit-latency', 'measure')
      .slice(before)
      .map((e) => e.duration);
    const layout = o.controller.getState().view?.layout;
    const scale = layout ? renderScale(layout.cssScale, layout.devicePixelRatio) : null;
    await edit.cancelActive();
    result.edit = {
      ...measured(samples, 'edit', o.pageCount),
      page: target.page,
      paragraphId: target.paragraphId,
      renderScale: scale,
      updates: o.draftUpdates.slice(updatesFrom),
    };
  }

  /**
   * Point that selects the target path (page space). The center if it selects that path, otherwise the first outline vertex at which that path is selected.
   * A line path (circle, arc, etc.) has nothing at the center, and at the center of a large path a smaller path overlaps and gets selected (`pickPath`).
   */
  private pathHitPoint(
    cands: readonly PathCandidate[],
    paintSeq: number,
    center: Point,
    tol: number,
  ): Point | null {
    if (pickPath(cands, center, tol)?.paintSeq === paintSeq) return center;
    const target = cands.find((c) => c.paintSeq === paintSeq);
    for (const info of target?.infos ?? []) {
      for (const sub of flattenPath(info)) {
        for (const pt of sub.points) if (pickPath(cands, pt, tol)?.paintSeq === paintSeq) return pt;
      }
    }
    return null;
  }

  private async scenarioPath(o: Opened, result: DocResult): Promise<void> {
    const edit = o.controller.edit;
    const paths = edit?.paths;
    if (!edit || !paths) throw new Error('패스 편집 호스트 없음');
    let found: { page: number; paintSeq: number; center: Point } | null = null;
    for (let p = 0; p < Math.min(o.pageCount, 30) && !found; p++) {
      const e = await o.pdf.getPageEditability(p);
      const area = (b: number[]) => (b[2]! - b[0]!) * (b[3]! - b[1]!);
      const best = e.paths.filter((x) => x.editable).sort((a, b) => area(b.bbox) - area(a.bbox))[0];
      if (best) {
        found = {
          page: p,
          paintSeq: best.paintSeq,
          center: [(best.bbox[0] + best.bbox[2]) / 2, (best.bbox[1] + best.bbox[3]) / 2],
        };
      }
    }
    if (!found) {
      result.skipped = { ...result.skipped, path: '앞 30쪽에 편집 가능한 패스 없음' };
      return;
    }
    await o.controller.goToPage(found.page);
    const view = o.controller.getState().view!;
    await Promise.all([paths.ensureModel(found.page), edit.ensureEditability(found.page)]);
    const point =
      this.pathHitPoint(
        paths.candidates(found.page),
        found.paintSeq,
        found.center,
        STROKE_HIT_PX / view.layout.cssScale,
      ) ?? found.center;
    await paths.selectAt(found.page, point, view.layout.cssScale, false);
    const sel = o.controller.getState().edit.path.selection;
    if (sel?.paintSeqs.length !== 1 || sel.paintSeqs[0] !== found.paintSeq) {
      throw new Error(
        `패스 선택 실패(${found.page}쪽 대상 ${found.paintSeq}, 고른 것 ${sel?.paintSeqs.join(',') ?? '없음'})`,
      );
    }
    if (!sel.plan?.editable) {
      throw new Error(
        `패스 판정 불일치(${found.page}쪽 ${found.paintSeq}: 쪽 판정 편집 가능, 선택 판정 불가)`,
      );
    }
    const g = paths.beginGesture();
    if (!g) throw new Error('패스 편집을 시작하지 못함');
    await g.ready();
    const samples: number[] = [];
    const serverMs: number[] = [];
    for (let i = 1; i <= this.options.pathSteps; i++) {
      const transform: Matrix = [1, 0, 0, 1, i, i / 2];
      const t0 = mark(M5_EVENTS.path.start);
      g.update(emptyPathEdit({ transform }));
      const t1 = await doubleRaf();
      mark(M5_EVENTS.path.end, t1);
      samples.push(t1 - t0);
      // The server preview (debounce after stopping → region render) is timed separately.
      if (i % 10 === 0) {
        const s0 = performance.now();
        await g.flush();
        serverMs.push(performance.now() - s0);
      }
      await sleep(30);
    }
    await paths.cancelGesture();
    result.path = {
      ...measured(samples, 'path', o.pageCount),
      page: found.page,
      paintSeq: found.paintSeq,
      serverUpdateMs: serverMs,
    };
  }

  // ── Full save ────────────────────────────────────────────────────────

  private async saveOnce(
    pdf: PdfWorkerClient,
  ): Promise<{ ms: number; saveMs: number; heap: number | null }> {
    const t0 = mark(M5_EVENTS.save.start);
    await pdf.planSave({ changes: [] });
    const r = await pdf.save({ changes: [] });
    const t1 = mark(M5_EVENTS.save.end);
    return { ms: t1 - t0, saveMs: r.saveMs, heap: r.wasmHeapBytes };
  }

  private async scenarioSave(o: Opened, result: DocResult): Promise<void> {
    const clean: number[] = [];
    const saveMs: number[] = [];
    const heaps: number[] = [];
    for (let i = 0; i < this.options.repeats.save; i++) {
      const s = await this.saveOnce(o.pdf);
      clean.push(s.ms);
      saveMs.push(s.saveMs);
      if (s.heap !== null) heaps.push(s.heap);
    }
    let edited: Measured | null = null;
    const target = await this.findEditableParagraph(o);
    if (target && o.controller.edit) {
      await this.commitEdit(o, target.page, target.paragraphId);
      const xs: number[] = [];
      for (let i = 0; i < this.options.repeats.save; i++) xs.push((await this.saveOnce(o.pdf)).ms);
      edited = measured(xs, 'save', o.pageCount);
    }
    result.save = {
      clean: measured(clean, 'save', o.pageCount),
      edited,
      saveMs,
      wasmHeapBytes: heaps,
    };
  }

  private async commitEdit(o: Opened, page: number, paragraphId: number): Promise<boolean> {
    return (await this.commitEditDetail(o, page, paragraphId)).committed;
  }

  /** Starts one paragraph, types one character and commits. Also returns the target of the started edit (whether it is a re-edit, character count). */
  private async commitEditDetail(
    o: Opened,
    page: number,
    paragraphId: number,
  ): Promise<{ committed: boolean; editedBlock: boolean | null; glyphs: number | null }> {
    const edit = o.controller.edit;
    if (!edit) return { committed: false, editedBlock: null, glyphs: null };
    await o.controller.goToPage(page);
    await edit.begin(page, paragraphId, null);
    const session = edit.currentSession();
    if (!session) return { committed: false, editedBlock: null, glyphs: null };
    const target = session.view().plan.target;
    session.typeText('x');
    await session.settle();
    return {
      committed: await edit.commitActive(),
      editedBlock: target.editedBlock !== null,
      glyphs: target.glyphSeqs.length,
    };
  }

  // ── Memory round trip (1.1) ─────────────────────────────────────────────────

  private async scenarioMem(doc: BenchDoc, bytes: ArrayBuffer, result: DocResult): Promise<void> {
    const o = await this.openDoc(bytes.slice(0));
    try {
      result.pageCount ??= o.pageCount;
      const { pages, edits, saves, settleMs, probePhases = false } = this.options.mem;
      // Checkpoint = right after the first save completes. As the viewer does, call planSave just before saving and keep the linear memory and estimated peak (D5) at that time.
      const firstPlan = await o.pdf.planSave({ changes: [] });
      const first = await o.pdf.save({ changes: [] });
      const baseHeap = first.wasmHeapBytes;
      const heapBefore = firstPlan.heap.usedHeapBytes ?? null;
      const predicted = firstPlan.heap.estimatedPeakBytes;
      const firstSave: FirstSaveHeap = {
        heapBeforeBytes: heapBefore,
        heapAfterBytes: baseHeap,
        predictedPeakBytes: predicted,
        grewHeap: heapBefore !== null && baseHeap !== null ? baseHeap > heapBefore : null,
        withinPrediction: baseHeap !== null ? baseHeap <= predicted : null,
      };
      mark(M5_EVENTS.mem.start);
      const tabInputs: MemResult['tabInputs'] = [];
      const readTab = async (label: 'baseline' | 'end' | 'end-settled'): Promise<number | null> => {
        const v = await this.hooks.tabMemoryMiB(label, doc.id);
        const reading: TabReading = typeof v === 'number' ? { mib: v } : (v ?? { mib: null });
        tabInputs.push({ label, ...reading });
        return reading.mib;
      };
      const baseTab = await readTab('baseline');
      // Measure the checkpoint with the same definition as the end value (in-use heap after clearing the cache). Measurement clears the cache, so read the tab value first.
      const baseUsed = await probeHeap(o.pdf, true);

      const phases: MemResult['phases'] = [];
      const phase = async (
        name: string,
        wasmHeapBytes: number | null,
        wasmUsedBytes?: number | null,
      ) => {
        const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
        phases.push({
          name,
          wasmHeapBytes,
          ...(wasmUsedBytes !== undefined ? { wasmUsedBytes } : {}),
          tabMiB: (await this.hooks.samplePhase?.(name, doc.id)) ?? null,
          jsHeapMiB: perf.memory ? perf.memory.usedJSHeapSize / MiB : null,
          ...(this.hooks.sampleDetail
            ? { detail: await this.hooks.sampleDetail(name, doc.id) }
            : {}),
        });
      };
      await phase('baseline', baseHeap, baseUsed);
      // Linear memory at the end of a phase is not fetched by RPC without saving: per-phase linear memory keeps only the save value, and in-use heap is measured only with `probePhases`
      // (measuring clears the cache, so the default run does not measure it).
      const midProbe = async () => (probePhases ? probeHeap(o.pdf, true) : undefined);

      let navigations = 0;
      const span = Math.min(pages, o.pageCount);
      for (let p = 1; p < span; p++, navigations++) await o.controller.goToPage(p);
      for (let p = span - 2; p >= 0; p--, navigations++) await o.controller.goToPage(p);

      await phase('after-navigation', null, await midProbe());
      let done = 0;
      const editLog: MemEdit[] = [];
      for (let p = 0; p < o.pageCount && done < edits; p++) {
        const e = await o.pdf.getPageEditability(p);
        for (const para of e.paragraphs) {
          if (done >= edits) break;
          if (!para.editable || para.cell || para.editedBlock) continue;
          const t0 = performance.now();
          const r = await this.commitEditDetail(o, p, para.paragraphId);
          const ms = performance.now() - t0;
          let journalBytes: number | null = null;
          if (r.committed) {
            done++;
            journalBytes = await o.pdf
              .journalAdvice()
              .then((a) => a.journalBytes)
              .catch(() => null);
          }
          editLog.push({ pageIndex: p, paragraphId: para.paragraphId, ...r, journalBytes, ms });
        }
      }

      await phase('after-edits', null, await midProbe());
      let endHeap: number | null = null;
      for (let i = 0; i < saves; i++) endHeap = (await o.pdf.save({ changes: [] })).wasmHeapBytes;
      mark(M5_EVENTS.mem.end);
      const endTab = await readTab('end');
      await phase('end', endHeap);
      // Tab judged value: after the 30 s wait (user decision 2026-10-21). No work is done during the wait.
      for (let left = settleMs; left > 0; left -= 1000) {
        this.hooks.progress(`${doc.id}: 메모리 종료 뒤 대기 ${Math.ceil(left / 1000)} s`);
        await new Promise((r) => setTimeout(r, Math.min(1000, left)));
      }
      const settledTab = await readTab('end-settled');
      await phase('end-settled', endHeap);
      // WASM judged value: in-use heap after clearing the cache.
      const endUsed = await probeHeap(o.pdf, true);
      // Forced GC is done after measuring the judged values (to keep a separate value excluding collectable garbage).
      await phase('end-after-gc', endHeap, endUsed);

      const delta = (a: number | null, b: number | null, scale = 1) =>
        a !== null && b !== null ? (b - a) / scale : null;
      const wasmDelta = delta(baseUsed, endUsed, MiB);
      const tabDelta = delta(baseTab, settledTab);
      const gcTab = phases.find((p) => p.name === 'end-after-gc')?.tabMiB ?? null;
      result.mem = {
        baseline: { wasmHeapBytes: baseHeap, wasmUsedBytes: baseUsed, tabMiB: baseTab },
        end: {
          wasmHeapBytes: endHeap,
          wasmUsedBytes: endUsed,
          tabMiB: endTab,
          tabSettledMiB: settledTab,
        },
        wasmHeapDeltaMiB: wasmDelta,
        wasmLinearDeltaMiB: delta(baseHeap, endHeap, MiB),
        tabDeltaMiB: tabDelta,
        tabDeltaBeforeWaitMiB: delta(baseTab, endTab),
        tabDeltaAfterGcMiB: delta(baseTab, gcTab),
        settleMs,
        navigations,
        edits: done,
        saves,
        pass: {
          wasmHeap: wasmDelta === null ? null : wasmDelta <= MEM_LIMITS_MIB.wasmHeap,
          tab: tabDelta === null ? null : tabDelta <= MEM_LIMITS_MIB.tab,
        },
        firstSavePeakHeapBytes: baseHeap,
        firstSave,
        editLog,
        tabInputs,
        phases,
      };
    } finally {
      o.dispose();
    }
  }
}
