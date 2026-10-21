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
  mountViewer,
  PAGE_ARROW_GUTTER,
  type PagePaintedEvent,
  type ViewerHost,
} from '@pdf-editor/viewer-ui';
import type { Matrix } from '@pdf-editor/shared-types';
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
  /** 메모리 왕복: 넘김 쪽 수(왕복)·편집 횟수·저장 횟수. */
  mem: { pages: number; edits: number; saves: number };
}

export const DEFAULT_OPTIONS: BenchOptions = {
  scenarios: ALL_SCENARIOS,
  repeats: { open: 5, save: 3, breakdown: 3 },
  nav: { steps: 20, jumps: 10 },
  judgePages: 6,
  editChars: 30,
  pathSteps: 40,
  mem: { pages: 50, edits: 20, saves: 2 },
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
   * 메모리 표본점에서 탭 메모리(MiB)를 받는다. 수동 실행은 사용자가 작업 관리자 값을 넣고, 서버 자동화는 렌더러 VmRSS 를 읽는다.
   * 값이 없으면 null.
   */
  tabMemoryMiB(label: 'baseline' | 'end', docId: string): Promise<number | null>;
  /** 중간 지점의 탭 메모리 자동 표본(수동 실행에는 없다). */
  samplePhase?(label: string, docId: string): Promise<number | null>;
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
  judge?: { first: Measured; reuse: Measured; breakdown: JudgeBreakdown[] };
  edit?: Measured & { page: number; paragraphId: number };
  path?: Measured & { page: number; paintSeq: number; serverUpdateMs: number[] };
  save?: { clean: Measured; edited: Measured | null; saveMs: number[]; wasmHeapBytes: number[] };
  mem?: MemResult;
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

export interface MemResult {
  baseline: { wasmHeapBytes: number | null; tabMiB: number | null };
  end: { wasmHeapBytes: number | null; tabMiB: number | null };
  wasmHeapDeltaMiB: number | null;
  tabDeltaMiB: number | null;
  navigations: number;
  edits: number;
  saves: number;
  pass: { wasmHeap: boolean | null; tab: boolean | null };
  firstSavePeakHeapBytes: number | null;
  /** 구간별 증가 원인 분석용 표본(자동 실행에서만 탭 메모리가 있다). */
  phases: {
    name: string;
    wasmHeapBytes: number | null;
    tabMiB: number | null;
    jsHeapMiB: number | null;
  }[];
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
          let pages: number[] = [];
          let cold = new Map<number, number>();
          const c = await this.openDoc(bytes.slice(0));
          try {
            pages = this.breakdownPages(c, doc.judgePages ?? []);
            cold = await this.coldJudge(c, pages);
          } finally {
            c.dispose();
          }
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
    const away = (p: number) => (p === 0 ? Math.min(1, o.pageCount - 1) : 0);
    for (const p of pages) {
      const ms = await this.judgeVisit(o, p);
      if (ms !== null) first.push(ms);
    }
    for (const p of pages) {
      await o.controller.goToPage(away(p));
      const ms = await this.judgeVisit(o, p);
      if (ms !== null) reuse.push(ms);
    }
    result.judge = {
      first: measured(first, 'judge', o.pageCount),
      reuse: measured(reuse, 'judgeReuse', o.pageCount),
      breakdown: [],
    };
  }

  /** 분해할 쪽: 지정한 쪽 + 문서 앞쪽 8쪽 뒤로 고르게 2쪽. */
  private breakdownPages(o: Opened, extra: readonly number[]): number[] {
    const total = o.pageCount;
    const even = evenlySpaced(total, 2, Math.min(8, Math.max(0, total - 1)));
    return [...new Set([...extra.filter((p) => p < total), ...even])];
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

  private async scenarioPath(o: Opened, result: DocResult): Promise<void> {
    const edit = o.controller.edit;
    const paths = edit?.paths;
    if (!edit || !paths) throw new Error('패스 편집 호스트 없음');
    let found: { page: number; paintSeq: number; center: [number, number] } | null = null;
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
    if (!found) throw new Error('편집 가능한 패스 없음');
    await o.controller.goToPage(found.page);
    const view = o.controller.getState().view!;
    await paths.selectAt(found.page, found.center, view.layout.cssScale, false);
    const sel = o.controller.getState().edit.path.selection;
    if (!sel?.plan?.editable) throw new Error('패스 선택·판정 실패');
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
    const edit = o.controller.edit;
    if (!edit) return false;
    await o.controller.goToPage(page);
    await edit.begin(page, paragraphId, null);
    const session = edit.currentSession();
    if (!session) return false;
    session.typeText('x');
    await session.settle();
    return edit.commitActive();
  }

  // ── 메모리 왕복(1.1) ─────────────────────────────────────────────────

  private async scenarioMem(doc: BenchDoc, bytes: ArrayBuffer, result: DocResult): Promise<void> {
    const o = await this.openDoc(bytes.slice(0));
    try {
      result.pageCount ??= o.pageCount;
      const { pages, edits, saves } = this.options.mem;
      // 기준점 = 첫 저장 완료 직후.
      const first = await o.pdf.save({ changes: [] });
      const baseHeap = first.wasmHeapBytes;
      mark(M5_EVENTS.mem.start);
      const baseTab = await this.hooks.tabMemoryMiB('baseline', doc.id);

      const phases: MemResult['phases'] = [];
      const phase = async (name: string, wasmHeapBytes: number | null) => {
        const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
        phases.push({
          name,
          wasmHeapBytes,
          tabMiB: (await this.hooks.samplePhase?.(name, doc.id)) ?? null,
          jsHeapMiB: perf.memory ? perf.memory.usedJSHeapSize / MiB : null,
        });
      };
      await phase('baseline', baseHeap);
      // 구간 끝의 WASM 힙은 planSave 가 주지 않으므로 저장 없이 알 수 없다: 구간별 힙은 마지막 저장 값만 둔다.

      let navigations = 0;
      const span = Math.min(pages, o.pageCount);
      for (let p = 1; p < span; p++, navigations++) await o.controller.goToPage(p);
      for (let p = span - 2; p >= 0; p--, navigations++) await o.controller.goToPage(p);

      await phase('after-navigation', null);
      let done = 0;
      for (let p = 0; p < o.pageCount && done < edits; p++) {
        const e = await o.pdf.getPageEditability(p);
        for (const para of e.paragraphs) {
          if (done >= edits) break;
          if (!para.editable || para.cell || para.editedBlock) continue;
          if (await this.commitEdit(o, p, para.paragraphId)) done++;
        }
      }

      await phase('after-edits', null);
      let endHeap: number | null = null;
      for (let i = 0; i < saves; i++) endHeap = (await o.pdf.save({ changes: [] })).wasmHeapBytes;
      mark(M5_EVENTS.mem.end);
      await phase('end', endHeap);
      const endTab = await this.hooks.tabMemoryMiB('end', doc.id);

      const wasmDelta = baseHeap !== null && endHeap !== null ? (endHeap - baseHeap) / MiB : null;
      const tabDelta = baseTab !== null && endTab !== null ? endTab - baseTab : null;
      result.mem = {
        baseline: { wasmHeapBytes: baseHeap, tabMiB: baseTab },
        end: { wasmHeapBytes: endHeap, tabMiB: endTab },
        wasmHeapDeltaMiB: wasmDelta,
        tabDeltaMiB: tabDelta,
        navigations,
        edits: done,
        saves,
        pass: {
          wasmHeap: wasmDelta === null ? null : wasmDelta <= MEM_LIMITS_MIB.wasmHeap,
          tab: tabDelta === null ? null : tabDelta <= MEM_LIMITS_MIB.tab,
        },
        firstSavePeakHeapBytes: baseHeap,
        phases,
      };
    } finally {
      o.dispose();
    }
  }
}
