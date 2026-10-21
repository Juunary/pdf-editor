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

export const DIST = fileURLToPath(new URL('../dist', import.meta.url));
export const REPO = fileURLToPath(new URL('../../..', import.meta.url));

export interface BenchDocFile {
  id: string;
  path: string;
  bytes: number;
  pages: number | null;
}

export interface BenchBrowser {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
  close(): Promise<void>;
}

export async function launchBenchBrowser(): Promise<BenchBrowser> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-bench-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 1000 },
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
