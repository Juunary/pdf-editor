/**
 * 벤치 하네스 스모크: bench.html 이 실제 확장·Worker 에서 작은 문서(m0-sample.pdf)로 지표를 낸다.
 * 값의 크기는 보지 않고(작은 문서) 형태·표식·메모리 시나리오 동작만 확인한다.
 */
import { expect, test } from '@playwright/test';
import {
  exposeTabMemory,
  launchBenchBrowser,
  openBenchPage,
  type BenchBrowser,
} from './bench-harness.js';

interface Result {
  schema: string;
  mode: string;
  docs: {
    id: string;
    pageCount: number | null;
    errors: string[];
    open?: { samples: number[] };
    save?: { clean: { samples: number[] } };
    judge?: { first: { samples: number[] }; breakdown: unknown[] };
    mem?: {
      wasmHeapDeltaMiB: number | null;
      wasmLinearDeltaMiB: number | null;
      tabDeltaMiB: number | null;
      tabDeltaBeforeWaitMiB: number | null;
      settleMs: number;
      saves: number;
      firstSavePeakHeapBytes: number | null;
      firstSave: {
        heapBeforeBytes: number | null;
        heapAfterBytes: number | null;
        predictedPeakBytes: number | null;
        withinPrediction: boolean | null;
      };
      editLog: { pageIndex: number; committed: boolean; journalBytes: number | null }[];
      tabInputs: { label: string; mib: number | null }[];
      phases: { name: string; detail?: Record<string, number | null> | null }[];
    };
  }[];
  p95: Record<string, number>;
}

let b: BenchBrowser;
test.beforeAll(async () => {
  b = await launchBenchBrowser();
});
test.afterAll(async () => {
  await b.close();
});

test('bench.html: m0-sample.pdf 로 열기·판정·저장·메모리 지표가 나온다', async () => {
  const page = await openBenchPage(b);
  await exposeTabMemory(b, page);
  const url = `chrome-extension://${b.extensionId}/diag/m0-sample.pdf`;
  const result = (await page.evaluate(
    (u) =>
      window.__bench.run([{ id: 'm0-sample', name: 'm0-sample.pdf', url: u, bytes: 11674 }], {
        scenarios: ['open', 'judge', 'save', 'mem'],
        repeats: { open: 2, save: 2, breakdown: 1 },
        judgePages: 1,
        mem: { pages: 3, edits: 1, saves: 1, settleMs: 0 },
      }),
    url,
  )) as unknown as Result;

  expect(result.schema).toBe('m5-bench/2');
  expect(result.mode).toBe('auto');
  const doc = result.docs[0]!;
  expect(doc.errors).toEqual([]);
  expect(doc.pageCount).toBe(1);
  expect(doc.open?.samples).toHaveLength(2);
  expect(doc.judge?.first.samples.length).toBeGreaterThan(0);
  expect(doc.save?.clean.samples).toHaveLength(2);
  // 판정값(WASM: emptyStore 뒤 사용 중 힙, 탭: 대기 뒤)과 이전 정의 값(선형 메모리, 대기 전)이 모두 나온다.
  expect(doc.mem?.wasmHeapDeltaMiB).not.toBeNull();
  expect(doc.mem?.wasmLinearDeltaMiB).not.toBeNull();
  expect(doc.mem?.tabDeltaMiB).not.toBeNull();
  expect(doc.mem?.tabDeltaBeforeWaitMiB).not.toBeNull();
  expect(doc.mem?.settleMs).toBe(0);
  // 첫 저장: 저장 전·뒤 선형 메모리와 D5 예상 피크(저장 뒤 값 = 기준점 값).
  const firstSave = doc.mem!.firstSave;
  expect(firstSave.heapBeforeBytes).not.toBeNull();
  expect(firstSave.predictedPeakBytes).toBeGreaterThan(0);
  expect(firstSave.heapAfterBytes).toBe(doc.mem!.firstSavePeakHeapBytes);
  expect(firstSave.withinPrediction).toBe(true);
  // 편집 기록·탭 입력 기록·탭 메모리 구성(서버 자동화: Worker JS 힙·WASM 선형 메모리).
  expect(doc.mem!.editLog.filter((e) => e.committed)).toHaveLength(1);
  expect(doc.mem!.editLog[0]!.journalBytes).toBeGreaterThan(0);
  expect(doc.mem!.tabInputs.map((t) => t.label)).toEqual(['baseline', 'end', 'end-settled']);
  const detail = doc.mem!.phases.find((p) => p.name === 'end')?.detail;
  expect(detail?.workers).toBe(1);
  expect(detail?.workerJsUsedMiB).toBeGreaterThan(0);
  expect(detail?.wasmLinearMiB).toBeGreaterThan(0);
  expect(Object.keys(result.p95)).toContain('m0-sample.open');

  // 지표 이벤트가 performance 타임라인에 남는다.
  const marks = await page.evaluate(() =>
    [...new Set(performance.getEntriesByType('mark').map((m) => m.name))].filter((n) =>
      n.startsWith('m5:'),
    ),
  );
  expect(marks).toEqual(
    expect.arrayContaining([
      'm5:open:bytes-received',
      'm5:open:first-page-shown',
      'm5:judge:page-enter',
      'm5:judge:editability-ready',
      'm5:save:start',
      'm5:save:bytes-ready',
      'm5:mem:baseline',
      'm5:mem:end',
    ]),
  );
});
