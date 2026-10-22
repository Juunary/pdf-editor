/**
 * M5 벤치마크 시나리오 실행기(계약 4.1·D1). 뷰어와 같은 구성(Worker + ViewerController + 마운트된 뷰어 UI)을 만들어
 * 지표 이벤트(`m5:*`)로 시간을 잰다. DOM 연결과 파일 입력은 `bench.ts` 가 맡는다.
 *
 * 시나리오는 문서마다 독립이며, 한 시나리오의 오류는 `errors` 에 남기고 다음으로 넘어간다.
 */
import { transferBytes, wrapPdfWorker, type PdfWorkerClient } from '@pdf-editor/core/client';
import {
  ViewerController,
  emptyPathEdit,
  flattenPath,
  mountViewer,
  pickPath,
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
  /** 열기·저장 반복 횟수. */
  repeats: { open: number; save: number; breakdown: number };
  /** 순차 쪽 넘김 횟수와 임의 이동 횟수. */
  nav: { steps: number; jumps: number };
  /** 쪽 판정을 잴 쪽 수(문서 전체에 고르게 배치). */
  judgePages: number;
  /** 편집 반응: 입력 글자 수. */
  editChars: number;
  /** 패스 끌기 단계 수. */
  pathSteps: number;
  /**
   * 메모리 왕복: 넘김 쪽 수(왕복)·편집 횟수·저장 횟수·끝 탭 메모리 대기(ms, 사용자 결정 2026-10-21 = 30 s).
   * `probePhases` 는 진단용: 넘김 뒤·편집 뒤에도 캐시를 비운 뒤 사용 중 힙을 잰다(판정값의 정의는 그대로).
   */
  mem: { pages: number; edits: number; saves: number; settleMs: number; probePhases?: boolean };
  /** 렌더 캐시 상한 재정의(비교 실험용). 없으면 기본 8쪽·64 MiB. */
  renderCache?: { maxPages: number; maxBytes: number };
  /** 미리 렌더 끄기(비교 실험용). */
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
  /** 쪽 판정 시험에 꼭 넣을 쪽(0부터, 최대 패스 쪽 등). */
  judgePages?: number[];
  load(): Promise<ArrayBuffer>;
}

export interface BenchHooks {
  /** 진행 문구. */
  progress(text: string): void;
  /**
   * 메모리 표본점에서 탭 메모리(MiB)를 받는다. 수동 실행은 사용자가 작업 관리자 값을 넣고(입력 원문·단위·경고를 함께
   * 돌려준다), 서버 자동화는 렌더러 VmRSS 를 읽는다. 값이 없으면 null.
   */
  tabMemoryMiB(
    label: 'baseline' | 'end' | 'end-settled',
    docId: string,
  ): Promise<number | TabReading | null>;
  /** 중간 지점의 탭 메모리 자동 표본(수동 실행에는 없다). */
  samplePhase?(label: string, docId: string): Promise<number | null>;
  /**
   * 중간 지점의 탭 메모리 구성(서버 자동화만): 렌더러 VmRSS, 페이지·Worker JS 힙(CDP `Runtime.getHeapUsage`), WASM 선형 메모리
   * 등 MiB 값. 수동 실행에는 없다.
   */
  sampleDetail?(label: string, docId: string): Promise<Record<string, number | null> | null>;
  /** 뷰어를 올릴 DOM. */
  targets: { controls: HTMLElement; pages: HTMLElement };
  /** 쪽 영역 폭(CSS px). */
  availableWidth(): number;
  /** 작업 모듈을 만든다. */
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
  /** 쪽 판정. `pages`·`reusePages` 는 첫 진입·재진입 표본 순서대로 잰 쪽(0부터). */
  judge?: {
    first: Measured;
    reuse: Measured;
    pages: number[];
    reusePages: number[];
    breakdown: JudgeBreakdown[];
  };
  edit?: Measured & { page: number; paragraphId: number };
  path?: Measured & { page: number; paintSeq: number; serverUpdateMs: number[] };
  save?: { clean: Measured; edited: Measured | null; saveMs: number[]; wasmHeapBytes: number[] };
  mem?: MemResult;
  /** 해당 없음(측정 대상이 없는 시나리오)과 그 사유. 오류와 구분한다. */
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
  /** 위 캐시가 모두 따뜻한 뒤의 getPageEditability. */
  judgeWarmMs: number;
  /** 다른 쪽에서 캐시 없이 부른 getPageEditability 전체. */
  judgeColdMs: number;
  /** 코어가 보고한 판정 시간(`PageEditability.ms`, 따뜻한 호출). */
  coreReportedMs: number;
  /** 값은 `reps` 번 반복(새 세션)의 중앙값. */
  reps: number;
}

/** 탭 메모리 한 번 읽기. 수동 실행은 입력 원문·단위·경고를 남긴다. */
export interface TabReading {
  mib: number | null;
  /** 수동 입력 원문(작업 관리자 값 그대로). */
  raw?: string;
  /** 입력 단위. `K` 는 Chrome 작업 관리자 표시(1 K = 1024 byte), 서버 자동화는 `VmRSS`. */
  unit?: 'K' | 'MiB' | 'VmRSS';
  /** 입력 경고(직전 값과 같음·세 값이 모두 같음·RAM 초과·직전 값의 5배 이상 등). 사용자가 확인하고 넘겼다. */
  warnings?: string[];
}

/** 메모리 왕복의 편집 한 번(대상과 커밋 뒤 저널 보유 추정). */
export interface MemEdit {
  pageIndex: number;
  /** 이 쪽 판정 목록(쪽마다 한 번 받은 목록)의 문단 id. 앞 편집 뒤 레이아웃이 바뀌어도 이 id 로 시작한다. */
  paragraphId: number;
  /** 시작한 편집의 대상이 이미 편집한 블록이었다(재편집). 편집을 시작하지 못했으면 null. */
  editedBlock: boolean | null;
  /** 대상 글자 수. 시작하지 못했으면 null. */
  glyphs: number | null;
  committed: boolean;
  /** 커밋 뒤 저널 보유 추정(byte, `journalAdvice`). 물을 수 없으면 null. */
  journalBytes: number | null;
  /** 시작~커밋 시간(ms). */
  ms: number;
}

/**
 * 첫 저장(기준점이 되는 저장)의 힙. 선형 메모리는 줄지 않아 저장 뒤 값은 저장 피크의 상한이다. 저장 전 값과 같으면 저장이
 * 이미 늘어난 선형 메모리 안에서 끝나 피크를 이 방식으로 볼 수 없다(`grewHeap: false`). 예측은 저장 직전 planSave(D5).
 */
export interface FirstSaveHeap {
  /** 저장 직전 선형 메모리(byte, planSave 의 사용 중 힙 = 첫 저장이면 현재 힙). */
  heapBeforeBytes: number | null;
  /** 저장 직후 선형 메모리(byte). 저장 피크의 상한. */
  heapAfterBytes: number | null;
  /** D5 예상 피크(byte). */
  predictedPeakBytes: number | null;
  /** 저장이 선형 메모리를 늘렸다(피크가 저장 뒤 값에 드러남). */
  grewHeap: boolean | null;
  /** 저장 뒤 선형 메모리(피크 상한) ≤ 예상 피크. */
  withinPrediction: boolean | null;
}

/**
 * 메모리 왕복 결과(계약 1.1·D1). 끝 측정 시점(사용자 결정 2026-10-21): WASM 은 MuPDF 캐시를 비운(`emptyStore`) 뒤 사용 중 힙,
 * 탭은 30 s 대기 뒤 값으로 판정한다. 비우기 전(선형 메모리)·대기 전 값도 남긴다.
 */
export interface MemResult {
  baseline: {
    /** 첫 저장 직후 선형 메모리(byte). */
    wasmHeapBytes: number | null;
    /** 첫 저장 직후 `emptyStore` 뒤 사용 중 힙(byte, 벤치 RPC). */
    wasmUsedBytes: number | null;
    tabMiB: number | null;
  };
  end: {
    /** 마지막 저장 뒤 선형 메모리(byte). */
    wasmHeapBytes: number | null;
    /** 끝 `emptyStore` 뒤 사용 중 힙(byte). */
    wasmUsedBytes: number | null;
    /** 끝 직후 탭 메모리(대기 전). */
    tabMiB: number | null;
    /** 끝 30 s 대기 뒤 탭 메모리(판정값). */
    tabSettledMiB: number | null;
  };
  /** 판정값: 사용 중 힙(`emptyStore` 뒤) 증가. */
  wasmHeapDeltaMiB: number | null;
  /** 비우기 전 값: 선형 메모리 증가(이전 정의). */
  wasmLinearDeltaMiB: number | null;
  /** 판정값: 30 s 대기 뒤 탭 메모리 증가. */
  tabDeltaMiB: number | null;
  /** 대기 전 값: 끝 직후 탭 메모리 증가(이전 정의). */
  tabDeltaBeforeWaitMiB: number | null;
  /** 종료 뒤 강제 GC(서버 CDP) 후 탭 메모리 − 기준점. 수거 가능한 쓰레기와 잔류분을 가른다. 수동 실행에는 없다. */
  tabDeltaAfterGcMiB: number | null;
  /** 끝 대기 시간(ms). */
  settleMs: number;
  navigations: number;
  edits: number;
  saves: number;
  pass: { wasmHeap: boolean | null; tab: boolean | null };
  /**
   * 첫 저장 직후 선형 메모리(byte) = `firstSave.heapAfterBytes`. 기준점이 첫 저장 직후라 `baseline.wasmHeapBytes` 와 늘 같다
   * (저장 전 값·예측은 `firstSave`).
   */
  firstSavePeakHeapBytes: number | null;
  firstSave: FirstSaveHeap;
  /** 편집 대상·커밋 뒤 저널 보유 추정. */
  editLog: MemEdit[];
  /** 탭 메모리 읽기(기준점·종료 직후·30 s 뒤). 수동 실행은 입력 원문·단위·경고. */
  tabInputs: (TabReading & { label: string })[];
  /** 구간별 증가 원인 분석용 표본(자동 실행에서만 탭 메모리가 있다). */
  phases: {
    name: string;
    wasmHeapBytes: number | null;
    /** `probePhases` 일 때 캐시를 비운 뒤 사용 중 힙(byte). 기준점·끝은 늘 잰다. */
    wasmUsedBytes?: number | null;
    tabMiB: number | null;
    jsHeapMiB: number | null;
    /** 탭 메모리 구성(서버 자동화, `sampleDetail`). */
    detail?: Record<string, number | null> | null;
  }[];
}

/** 벤치 전용 Worker RPC(dev 빌드, `@pdf-editor/core/bench`). 없으면(이전 빌드) null. */
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

/** 고정 시드 난수(임의 이동 순서를 실행마다 같게). */
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

/** 반복 실행의 쪽별 중앙값. */
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
    // 나머지 시나리오는 공용 세션 하나를 쓴다(메모리·breakdown 은 자기 세션).
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
      // 첫 진입 판정은 캐시가 비어 있어야 하므로 새 세션에서 잰다. 구성 분해도 새 세션이다.
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

  // ── 문서 열기(뷰어와 같은 구성) ──────────────────────────────────────

  private async openDoc(bytes: ArrayBuffer, marks: { onBytes?: () => void } = {}): Promise<Opened> {
    const worker = this.hooks.spawnWorker();
    const pdf = wrapPdfWorker(worker);
    // 뷰어는 Worker 를 바이트 수신 전에 띄운다: 모듈·WASM 적재를 끝낸 뒤 시작점을 잡는다.
    await pdf.close().catch(() => undefined);
    const painted = new PaintWaiters();
    let firstResolve!: (e: PagePaintedEvent) => void;
    const firstPaint = new Promise<PagePaintedEvent>((r) => (firstResolve = r));
    let firstSeen = false;
    marks.onBytes?.();
    const t0 = mark(M5_EVENTS.open.start);
    const info = await pdf.open(transferBytes(bytes));
    const workerOpenMs = performance.now() - t0;
    const host = new Proxy({} as ViewerHost, {
      get: (_t, key: string) =>
        key === 'log'
          ? () => undefined
          : (...args: unknown[]) =>
              (pdf as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!(...args),
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

  // ── 쪽 넘김 ──────────────────────────────────────────────────────────

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
      // 읽는 시간: 유휴 때 다음 쪽 미리 렌더가 돈다.
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

  // ── 쪽 판정 ──────────────────────────────────────────────────────────

  /** 쪽 진입(`judge:page-enter`) → 편집 가능 판정 완료(`judge:editability-ready`). 쪽은 이미 보이는 상태에서 잰다. */
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
    // 같은 쪽을 다시 진입시킬 때는 쪽 캐시(추출·판정)를 비워 다시 읽게 한다.
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

  /** 분해할 쪽: 지정한 쪽 + 문서 앞쪽 8쪽 뒤로 고르게 2쪽. */
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

  /** 새 세션에서 쪽마다 `getPageEditability` 를 캐시 없이(그 쪽 처음) 부른 시간. 폰트 적재 같은 공통 초기화는 먼저 치운다. */
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
   * 첫 진입 판정의 구성(RPC 왕복 시각): 추출·SourceMap·연결·레이아웃·판정을 캐시 없이 순서대로 잰다(새 세션).
   * 값에는 결과를 메인 스레드로 돌려주는 구조화 복제가 들어 있다(SourceMap 등은 큼). Worker 안 순수 구성은
   * `packages/core/bench/judge-breakdown.mjs` 가 잰다.
   * 각 단계는 앞 단계 결과를 캐시로 재사용하므로 "그 단계가 새로 더한 시간"이다. `judgeColdMs` 는 별도 새 세션에서
   * 같은 쪽의 판정만 처음 부른 전체 시간이다.
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

  // ── 편집 반응·패스 끌기 ──────────────────────────────────────────────

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
    await edit.cancelActive();
    result.edit = {
      ...measured(samples, 'edit', o.pageCount),
      page: target.page,
      paragraphId: target.paragraphId,
    };
  }

  /**
   * 대상 패스를 고르는 점(쪽 공간). 가운데가 그 패스를 고르면 가운데, 아니면 윤곽 꼭짓점 중 그 패스가 골라지는 첫 점.
   * 선 패스(원·호 등)는 가운데에 아무것도 없고, 큰 패스 가운데에는 더 작은 패스가 겹쳐 그것이 골라진다(`pickPath`).
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
      // 서버 미리보기(정지 뒤 디바운스 → 영역 렌더)는 따로 잰다.
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

  // ── 전체 저장 ────────────────────────────────────────────────────────

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

  /** 문단 하나를 시작해 한 글자 넣고 커밋한다. 시작한 편집의 대상(재편집 여부·글자 수)을 함께 돌려준다. */
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

  // ── 메모리 왕복(1.1) ─────────────────────────────────────────────────

  private async scenarioMem(doc: BenchDoc, bytes: ArrayBuffer, result: DocResult): Promise<void> {
    const o = await this.openDoc(bytes.slice(0));
    try {
      result.pageCount ??= o.pageCount;
      const { pages, edits, saves, settleMs, probePhases = false } = this.options.mem;
      // 기준점 = 첫 저장 완료 직후. 뷰어처럼 저장 직전 planSave 를 불러 그때의 선형 메모리·예상 피크(D5)를 함께 남긴다.
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
      // 끝 값과 같은 정의(캐시 비운 뒤 사용 중 힙)로 기준점도 잰다. 측정이 캐시를 비우므로 탭 값을 먼저 읽는다.
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
      // 구간 끝의 선형 메모리는 저장 없이 RPC 로 받지 않는다: 구간별 선형 메모리는 저장 값만 두고, 사용 중 힙은 `probePhases`
      // 일 때만 잰다(잴 때 캐시를 비우므로 기본 실행에서는 재지 않는다).
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
      // 탭 판정값: 30 s 대기 뒤(사용자 결정 2026-10-21). 대기 중에는 아무 작업도 하지 않는다.
      for (let left = settleMs; left > 0; left -= 1000) {
        this.hooks.progress(`${doc.id}: 메모리 종료 뒤 대기 ${Math.ceil(left / 1000)} s`);
        await new Promise((r) => setTimeout(r, Math.min(1000, left)));
      }
      const settledTab = await readTab('end-settled');
      await phase('end-settled', endHeap);
      // WASM 판정값: 캐시를 비운 뒤 사용 중 힙.
      const endUsed = await probeHeap(o.pdf, true);
      // 강제 GC 는 판정값을 잰 뒤에 한다(수거 가능한 쓰레기를 뺀 값을 따로 남기려고).
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
