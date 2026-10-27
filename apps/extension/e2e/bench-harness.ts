/**
 * Shared M5 benchmark server run helpers (contract 4.1): load the extension, serve documents over HTTP (CORS allowed), read the renderer VmRSS.
 * The measurement page is the same `bench.html` used for manual runs on Windows.
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
 * Measurement browser. Default viewport 1280×1000, dpr 1. To mimic the Windows reference PC, override with the environment variables `BENCH_VIEWPORT` (e.g. `1440x731`) and
 * `BENCH_DPR` (e.g. `2`) (headless emulation; classification uses the Windows values).
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

/** Serves a document file as `/<id>.pdf` (CORS allowed so the extension page's fetch works). */
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
 * PID of the extension process (renderer) of this browser (`userDataDir`). The viewer page and its dedicated Worker live in the same renderer.
 * The renderer is identified by `--extension-process`. If there are several, the one with the largest VmRSS.
 */
export function extensionRendererPids(userDataDir: string): number[] {
  const all = listPids().map((pid) => ({
    pid,
    // Some Chrome processes rewrite argv, so split on both NUL and spaces.
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

/** VmRSS (MiB) from `/proc/<pid>/status`. */
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
 * Sends a command to the page's dedicated Worker through the page's CDP session. Playwright `CDPSession.send` has no session id argument (so it cannot address a child
 * session of a flat session), so auto-attach is set to `flatten: false` and commands go through `Target.sendMessageToTarget`.
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

  /** Sends a command to the child session and returns the result (null on failure or no response within 5 s). */
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
 * Registers the measurement page's `benchTabMemory`: renderer VmRSS (MiB). If the label is `phase:end-after-gc`, it first forces GC in the page and the dedicated Worker
 * (CDP `HeapProfiler.collectGarbage`) and returns the value with collectable garbage removed.
 *
 * Also registers `benchTabDetail`: the tab memory breakdown (MiB). Renderer VmRSS, page JS heap, JS heaps of the live dedicated Workers
 * (used and allocated sizes from CDP `Runtime.getHeapUsage`), and the Worker's WASM linear memory (`$libmupdf_wasm_Module.HEAPU8`). These are server headless
 * values, so they differ from the Windows Task Manager values (for comparing the breakdown only).
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
