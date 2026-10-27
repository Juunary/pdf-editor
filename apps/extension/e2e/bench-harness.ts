/**
 * M5 벤치마크 서버 실행 공용(계약 4.1): 확장 로드, 문서 HTTP 제공(CORS 허용), 렌더러 VmRSS 읽기.
 * 측정 페이지는 Windows 수동 실행과 같은 `bench.html` 이다.
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_LOCALE } from './locale.js';

export const DIST = fileURLToPath(new URL('../dist', import.meta.url));
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));

export interface BenchDocFile {
  id: string;
  path: string;
  bytes: number;
  pages: number | null;
  judgePages?: number[];
}

export interface BenchBrowser {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  close(): Promise<void>;
}

/**
 * 측정 브라우저. 기본 뷰포트 1280×1000·dpr 1. Windows 기준 PC 조건을 흉내 낼 때는 환경 변수 `BENCH_VIEWPORT`(예 `1440x731`)·
 * `BENCH_DPR`(예 `2`)로 바꾼다(헤드리스 에뮬레이션, 판정은 Windows 값).
 */
export async function launchBenchBrowser(): Promise<BenchBrowser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-bench-'));
  const [vw, vh] = (process.env.BENCH_VIEWPORT ?? '1280x1000').split('x').map(Number);
  const dpr = Number(process.env.BENCH_DPR ?? '1');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    locale: E2E_LOCALE,
    viewport: { width: vw || 1280, height: vh || 1000 },
    deviceScaleFactor: dpr > 0 ? dpr : 1,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    extensionId: new URL(sw.url()).host,
    userDataDir,
    close: async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** 문서 파일을 `/<id>.pdf` 로 제공한다(확장 페이지의 fetch 를 위해 CORS 허용). */
export async function serveDocs(
  docs: readonly BenchDocFile[],
): Promise<{ server: Server; base: string }> {
  const byPath = new Map(docs.map((d) => [`/${d.id}.pdf`, d.path]));
  const server = createServer((req, res) => {
    const file = byPath.get(new URL(req.url ?? '/', 'http://x').pathname);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': statSync(file).size,
      'access-control-allow-origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const proc = (pid: number, file: string): string => {
  try {
    return readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return '';
  }
};

function listPids(): number[] {
  return readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .map(Number);
}

/**
 * 이 브라우저(`userDataDir`)의 확장 프로세스(렌더러) PID. 뷰어 페이지와 그 전용 Worker 가 같은 렌더러에 있다.
 * 렌더러는 `--extension-process` 로 구분한다. 여러 개면 VmRSS 가 가장 큰 것.
 */
export function extensionRendererPids(userDataDir: string): number[] {
  const all = listPids().map((pid) => ({
    pid,
    // Chrome 은 argv 를 고쳐 쓰는 프로세스가 있어 NUL 과 공백 둘 다로 자른다.
    cmd: proc(pid, 'cmdline').split(/[\0 ]/),
    ppid: Number(/^\S+ \(.*\) \S (\d+)/.exec(proc(pid, 'stat'))?.[1] ?? 0),
  }));
  const root = all.find(
    (p) =>
      p.cmd.some((a) => a === `--user-data-dir=${userDataDir}`) &&
      !p.cmd.some((a) => a.startsWith('--type=')),
  );
  if (!root) return [];
  const family = new Set<number>([root.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) {
      if (!family.has(p.pid) && family.has(p.ppid)) {
        family.add(p.pid);
        grew = true;
      }
    }
  }
  return all
    .filter(
      (p) =>
        family.has(p.pid) &&
        p.cmd.includes('--type=renderer') &&
        p.cmd.includes('--extension-process'),
    )
    .map((p) => p.pid);
}

/** `/proc/<pid>/status` 의 VmRSS(MiB). */
export function vmRssMiB(pid: number): number | null {
  const m = /VmRSS:\s+(\d+) kB/.exec(proc(pid, 'status'));
  return m ? Number(m[1]) / 1024 : null;
}

export function extensionRssMiB(userDataDir: string): number | null {
  const xs = extensionRendererPids(userDataDir)
    .map(vmRssMiB)
    .filter((v): v is number => v !== null);
  return xs.length > 0 ? Math.max(...xs) : null;
}

export async function openBenchPage(b: BenchBrowser): Promise<Page> {
  const page = await b.context.newPage();
  await page.goto(`chrome-extension://${b.extensionId}/bench.html`);
  await page.waitForFunction(() => '__bench' in window);
  return page;
}

export function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO }).toString().trim();
  } catch {
    return 'unknown';
  }
}

interface CdpLike {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, fn: (e: never) => void): void;
}

interface AttachEvent {
  sessionId: string;
  targetInfo?: { type?: string };
}

const MiB = 2 ** 20;

/**
 * 페이지 CDP 세션으로 그 페이지의 전용 Worker 에 명령을 보낸다. Playwright `CDPSession.send` 는 세션 id 인자가 없어(평면 세션의
 * 하위 세션으로 보낼 수 없음) 자동 연결을 `flatten: false` 로 두고 `Target.sendMessageToTarget` 으로 보낸다.
 */
class WorkerChannel {
  readonly sessions = new Map<string, string>();
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();

  constructor(private readonly cdp: CdpLike) {
    cdp.on('Target.attachedToTarget', (e: AttachEvent) =>
      this.sessions.set(e.sessionId, e.targetInfo?.type ?? ''),
    );
    cdp.on('Target.detachedFromTarget', (e: AttachEvent) => this.sessions.delete(e.sessionId));
    cdp.on('Target.receivedMessageFromTarget', (e: { message: string }) => {
      const m = JSON.parse(e.message) as { id?: number; result?: unknown };
      const done = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (done && m.id !== undefined) {
        this.pending.delete(m.id);
        done(m.result ?? null);
      }
    });
  }

  async start(): Promise<void> {
    await this.cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
    });
  }

  workers(): string[] {
    return [...this.sessions].filter(([, type]) => type === 'worker').map(([id]) => id);
  }

  /** 하위 세션에 명령을 보내고 결과(실패·5 s 무응답이면 null)를 받는다. */
  send(sessionId: string, method: string, params: object = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, 5000);
      this.cdp
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(() => {
          if (this.pending.delete(id)) resolve(null);
        });
    });
  }
}

/**
 * 측정 페이지의 `benchTabMemory` 를 등록한다: 렌더러 VmRSS(MiB). 라벨이 `phase:end-after-gc` 면 먼저 페이지와 전용 Worker 에서
 * 강제 GC 를 돌려 수거 가능한 쓰레기를 뺀 값을 돌려준다(CDP `HeapProfiler.collectGarbage`).
 *
 * `benchTabDetail` 도 등록한다: 탭 메모리 구성(MiB). 렌더러 VmRSS, 페이지 JS 힙, 살아 있는 전용 Worker 들의 JS 힙
 * (CDP `Runtime.getHeapUsage` 의 사용·할당 크기), Worker 의 WASM 선형 메모리(`$libmupdf_wasm_Module.HEAPU8`). 서버 헤드리스
 * 값이라 Windows 작업 관리자 값과 같지 않다(구성 비교용).
 */
export async function exposeTabMemory(
  b: BenchBrowser,
  page: Page,
  onSample?: (label: string, docId: string, mib: number | null) => void,
): Promise<void> {
  const cdp = (await b.context.newCDPSession(page)) as unknown as CdpLike;
  const workers = new WorkerChannel(cdp);
  await workers.start();
  await page.exposeFunction('benchTabMemory', async (label: string, docId: string) => {
    if (label === 'phase:end-after-gc') {
      await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
      for (const id of workers.workers()) await workers.send(id, 'HeapProfiler.collectGarbage');
      await new Promise((r) => setTimeout(r, 1500));
    }
    const mib = extensionRssMiB(b.userDataDir);
    onSample?.(label, docId, mib);
    return mib;
  });
  await page.exposeFunction('benchTabDetail', async () => {
    type Usage = { usedSize: number; totalSize: number };
    const pageHeap = (await cdp.send('Runtime.getHeapUsage').catch(() => null)) as Usage | null;
    let count = 0;
    let workerUsed = 0;
    let workerTotal = 0;
    let wasm: number | null = null;
    for (const id of workers.workers()) {
      const h = (await workers.send(id, 'Runtime.getHeapUsage')) as Usage | null;
      if (!h) continue;
      count++;
      workerUsed += h.usedSize;
      workerTotal += h.totalSize;
      const ev = (await workers.send(id, 'Runtime.evaluate', {
        expression: 'globalThis.$libmupdf_wasm_Module?.HEAPU8?.byteLength ?? null',
        returnByValue: true,
      })) as { result?: { value?: number | null } } | null;
      const v = ev?.result?.value;
      if (typeof v === 'number') wasm = (wasm ?? 0) + v;
    }
    return {
      rssMiB: extensionRssMiB(b.userDataDir),
      pageJsUsedMiB: pageHeap ? pageHeap.usedSize / MiB : null,
      pageJsTotalMiB: pageHeap ? pageHeap.totalSize / MiB : null,
      workers: count,
      workerJsUsedMiB: count > 0 ? workerUsed / MiB : null,
      workerJsTotalMiB: count > 0 ? workerTotal / MiB : null,
      wasmLinearMiB: wasm === null ? null : wasm / MiB,
    };
  });
}
