// Chrome 128–150 DNR 폴백 경로 실측(PLAN.md 5.1, docs/m0-day1-log.md A5, docs/m0-corpus-recheck.md 4절).
//
// 기본 실행에서는 건너뛴다. Chrome for Testing 구버전을 받은 뒤 실행 파일 경로를 넘긴다.
//   node apps/extension/scripts/fetch-chrome-for-testing.mjs 128 140 150
//   PDF_EDITOR_LEGACY_CHROME=<경로1>,<경로2> pnpm --filter @pdf-editor/extension exec playwright test dnr-legacy
// 결과 JSON: out/m0-corpus/dnr/<버전>.json (git 제외)
//
// 측정 위주라 단언은 최소(서비스 워커 기동, mimeHandler 부재 시 동적 규칙 2개 등록)로 두고, 나머지 동작은
// 그대로 기록한다.
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E2E_LOCALE } from './locale.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');
const REPORT_DIR = fileURLToPath(new URL('../../../out/m0-corpus/dnr', import.meta.url));
const LEGACY = (process.env.PDF_EDITOR_LEGACY_CHROME ?? '').split(',').filter(Boolean);
/** Chrome 기본 PDF 뷰어(내장 확장) */
const BUILTIN_PDF_VIEWER = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

/** dist/diag 제공 + 요청 기록. attachment·POST 변형 경로를 더한다. */
function serve(): Promise<{ server: Server; base: string; log: string[] }> {
  const log: string[] = [];
  const pdf = readFileSync(SAMPLE);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    log.push(`${req.method} ${path}`);
    if (path === '/attachment.pdf') {
      res
        .writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="m0-sample.pdf"',
        })
        .end(pdf);
      return;
    }
    if (path === '/post.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
      return;
    }
    if (path === '/post-form.html') {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<form method="post" action="/post.pdf"><button id="go">go</button></form>');
      return;
    }
    if (path === '/ct-params.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf; qs=0.001' }).end(pdf);
      return;
    }
    const file = join(DIST, 'diag', basename(path));
    try {
      const body = readFileSync(file);
      const type = file.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}`, log });
    }),
  );
}

interface FrameState {
  url: string;
  badge: string | null;
  state: string | null;
  status: string | null;
  source: unknown;
}

/** 페이지의 확장 뷰어 프레임과 Chrome 기본 PDF 뷰어 프레임을 모은다. */
async function inspectFrames(page: Page, extensionId: string, waitMs: number) {
  const viewerPrefix = `chrome-extension://${extensionId}/viewer.html`;
  await page.waitForTimeout(waitMs);
  const viewers: FrameState[] = [];
  for (const f of page.frames().filter((x) => x.url().startsWith(viewerPrefix))) {
    await expect
      .poll(async () => f.getAttribute('#status', 'data-state'), { timeout: 20_000 })
      .toMatch(/rendered|error/)
      .catch(() => undefined);
    const log = JSON.parse((await f.textContent('#diag-log')) ?? '[]') as {
      event: string;
      data: unknown;
    }[];
    viewers.push({
      url: f.url(),
      badge: await f.getAttribute('body', 'data-context'),
      state: await f.getAttribute('#status', 'data-state'),
      status: await f.textContent('#status'),
      source: log.find((e) => e.event === 'source')?.data ?? null,
    });
  }
  return {
    pageUrl: page.url(),
    viewers,
    builtinPdfViewerFrames: page.frames().filter((f) => f.url().includes(BUILTIN_PDF_VIEWER))
      .length,
    frameUrls: page.frames().map((f) => f.url()),
  };
}

async function gotoLoose(page: Page, url: string): Promise<string | null> {
  try {
    await page.goto(url, { timeout: 15_000 });
    return null;
  } catch (e) {
    // DNR 리다이렉트·다운로드 전환 시 goto 가 ERR_ABORTED 로 끝날 수 있다. 결과는 프레임 상태로 판정한다.
    return String(e).split('\n')[0] ?? String(e);
  }
}

/** chrome://extensions 페이지 문맥의 `chrome.developerPrivate`(확장 관리 화면 내부 API) 일부. */
interface DeveloperPrivate {
  getExtensionInfo(id: string, cb: (info: Record<string, unknown>) => void): void;
  updateExtensionConfiguration(
    update: { extensionId: string; fileAccess: boolean },
    cb: () => void,
  ): void;
  getProfileConfiguration(cb: (c: { inDeveloperMode: boolean }) => void): void;
  updateProfileConfiguration(update: { inDeveloperMode: boolean }, cb: () => void): void;
}

async function onExtensionsPage<T>(
  context: BrowserContext,
  fn: (arg: [string, boolean]) => Promise<T>,
  arg: [string, boolean],
): Promise<T> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    return await page.evaluate(fn, arg);
  } finally {
    await page.close();
  }
}

/** 설치 경고(manifest 키 무시 등)·오류·파일 URL 접근 설정. */
function extensionInfo(context: BrowserContext, extensionId: string) {
  return onExtensionsPage(
    context,
    async ([id]: [string, boolean]) => {
      const dp = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      const info = await new Promise<Record<string, unknown>>((r) => dp.getExtensionInfo(id, r));
      return {
        state: info.state,
        disableReasons: info.disableReasons,
        location: info.location,
        installWarnings: info.installWarnings,
        manifestErrors: info.manifestErrors,
        runtimeErrors: info.runtimeErrors,
        fileAccess: info.fileAccess,
      };
    },
    [extensionId, false],
  );
}

/**
 * 개발자 모드를 켠다. 실제 사용자는 압축해제 확장을 개발자 모드에서 로드하며, Chrome 140·150 은 개발자 모드가
 * 꺼진 프로필에서 압축해제 확장이 다시 로드되면 `unsupportedDeveloperExtension` 으로 비활성화한다(실측).
 */
function enableDeveloperMode(context: BrowserContext) {
  return onExtensionsPage(context, async () => {
    const dp = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
    const get = () =>
      new Promise<boolean>((r) => dp.getProfileConfiguration((c) => r(c.inDeveloperMode)));
    const before = await get();
    await new Promise<void>((r) => dp.updateProfileConfiguration({ inDeveloperMode: true }, r));
    return { before, after: await get() };
  }, ['', true]);
}

/** "파일 URL에 대한 액세스 허용" 설정(확장이 다시 로드된다). */
function setFileAccess(context: BrowserContext, extensionId: string, allow: boolean) {
  return onExtensionsPage(
    context,
    async ([id, value]: [string, boolean]) => {
      const dp = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      await new Promise<void>((r) =>
        dp.updateExtensionConfiguration({ extensionId: id, fileAccess: value }, r),
      );
    },
    [extensionId, allow],
  );
}

async function serviceWorkerInfo(context: BrowserContext, extensionId: string) {
  const prefix = `chrome-extension://${extensionId}/`;
  const sw =
    context.serviceWorkers().find((w) => w.url().startsWith(prefix)) ??
    (await context.waitForEvent('serviceworker', {
      predicate: (w) => w.url().startsWith(prefix),
      timeout: 15_000,
    }));
  // onInstalled 의 비동기 등록을 기다린다.
  await expect
    .poll(
      () =>
        sw.evaluate(async () =>
          typeof chrome.mimeHandler === 'object'
            ? -1
            : (await chrome.declarativeNetRequest.getDynamicRules()).length,
        ),
      { timeout: 10_000 },
    )
    .not.toBe(0)
    .catch(() => undefined);
  return sw.evaluate(async () => ({
    userAgent: navigator.userAgent,
    hasMimeHandlerApi: typeof chrome.mimeHandler === 'object',
    isAllowedFileSchemeAccess: await chrome.extension.isAllowedFileSchemeAccess(),
    dynamicRules: await chrome.declarativeNetRequest.getDynamicRules(),
  }));
}

/**
 * 확장 페이지에서 본 상태. MV3 서비스 워커는 유휴 시 종료되므로 시작 직후가 아니면 확장 페이지에서 조회한다.
 */
async function extensionPageInfo(context: BrowserContext, extensionId: string) {
  let lastError = '';
  // 파일 URL 접근 설정을 바꾸면 확장이 다시 로드되며, 그동안 확장 페이지 이동은 ERR_BLOCKED_BY_CLIENT 로 막힌다.
  for (let attempt = 1; attempt <= 10; attempt++) {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/viewer.html`);
      return {
        attempt,
        ...(await page.evaluate(async () => ({
          hasMimeHandlerApi: typeof chrome.mimeHandler === 'object',
          isAllowedFileSchemeAccess: await chrome.extension.isAllowedFileSchemeAccess(),
          dynamicRuleIds: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id),
        }))),
      };
    } catch (e) {
      lastError = String(e).split('\n')[0] ?? String(e);
    } finally {
      await page.close();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { attempt: -1, error: lastError, extension: await extensionInfo(context, extensionId) };
}

async function measureFile(context: BrowserContext, extensionId: string, label: string) {
  const state = await extensionPageInfo(context, extensionId);
  const page = await context.newPage();
  const fileUrl = pathToFileURL(SAMPLE).href;
  const gotoError = await gotoLoose(page, fileUrl);
  const result = {
    label,
    ...state,
    url: fileUrl,
    gotoError,
    ...(await inspectFrames(page, extensionId, 3000)),
  };
  await page.close();
  return result;
}

if (LEGACY.length === 0) {
  test('Chrome 128–150 DNR 폴백 실측', () => {
    test.skip(true, 'PDF_EDITOR_LEGACY_CHROME 미지정(scripts/fetch-chrome-for-testing.mjs 참고)');
  });
}

for (const executablePath of LEGACY) {
  test(`Chrome 128–150 DNR 폴백 실측: ${executablePath}`, async () => {
    test.setTimeout(240_000);
    const { server, base, log } = await serve();
    const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-dnr-'));
    // Playwright 의 headless 는 `--headless` 를 넘기는데, Chrome 131 이하에서는 확장을 지원하지 않는
    // 구 headless 를 뜻할 수 있다. 버전과 무관하게 새 headless 를 쓰도록 직접 지정한다.
    const context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: false,
      locale: E2E_LOCALE,
      acceptDownloads: true,
      args: ['--headless=new', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    const report: Record<string, unknown> = { executablePath };
    try {
      const sw0 = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const extensionId = new URL(sw0.url()).host;
      const sw = await serviceWorkerInfo(context, extensionId);
      report.browserVersion = context.browser()?.version() ?? null;
      report.serviceWorker = sw;
      report.extension = await extensionInfo(context, extensionId);
      report.developerMode = await enableDeveloperMode(context);
      // onInstalled 의 비동기 등록이 늦을 수 있어(128 에서 시작 직후 0개 관찰) 확장 페이지에서 다시 조회한다.
      report.extensionPage = await extensionPageInfo(context, extensionId);

      // 1) http 최상위 GET PDF
      const p1 = await context.newPage();
      log.length = 0;
      const e1 = await gotoLoose(p1, `${base}/m0-sample.pdf`);
      report.httpTop = { gotoError: e1, ...(await inspectFrames(p1, extensionId, 1000)) };
      (report.httpTop as Record<string, unknown>).serverRequests = [...log];

      // 2) content-type 매개변수(`application/pdf; qs=…`) — 규칙 값 `application/pdf;*`
      const p2 = await context.newPage();
      log.length = 0;
      const e2 = await gotoLoose(p2, `${base}/ct-params.pdf`);
      report.httpContentTypeParams = {
        gotoError: e2,
        ...(await inspectFrames(p2, extensionId, 1000)),
        serverRequests: [...log],
      };

      // 3) content-disposition: attachment → 가로채지 않음(다운로드) 기대
      const p3 = await context.newPage();
      const download = p3.waitForEvent('download', { timeout: 8000 }).catch(() => null);
      const e3 = await gotoLoose(p3, `${base}/attachment.pdf`);
      const d = await download;
      report.httpAttachment = {
        gotoError: e3,
        downloaded: d ? d.suggestedFilename() : null,
        ...(await inspectFrames(p3, extensionId, 500)),
      };

      // 4) POST 로 생성된 PDF → GET 전용 규칙이라 가로채지 않음 기대
      const p4 = await context.newPage();
      await p4.goto(`${base}/post-form.html`);
      log.length = 0;
      await Promise.all([
        p4.waitForURL(/post\.pdf/, { timeout: 10_000 }).catch(() => undefined),
        p4.click('#go'),
      ]);
      report.httpPost = {
        ...(await inspectFrames(p4, extensionId, 2000)),
        serverRequests: [...log],
      };

      // 5) 임베드: <embed>·<iframe>·<object>
      const p5 = await context.newPage();
      await gotoLoose(p5, `${base}/embed-test.html`);
      report.httpEmbedded = await inspectFrames(p5, extensionId, 4000);

      // 6) file:// — 파일 URL 접근 기본값 → 반대값 순서로 측정
      const initial = sw.isAllowedFileSchemeAccess;
      const files: unknown[] = [];
      report.file = files;
      files.push(await measureFile(context, extensionId, `fileAccess=${initial}(기본값)`));
      await setFileAccess(context, extensionId, !initial);
      files.push(await measureFile(context, extensionId, `fileAccess=${!initial}(변경)`));
      report.extensionAfter = await extensionInfo(context, extensionId);
    } finally {
      mkdirSync(REPORT_DIR, { recursive: true });
      const version = String(report.browserVersion ?? basename(executablePath));
      writeFileSync(join(REPORT_DIR, `${version}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));
      await context.close();
      server.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
    const page = report.extensionPage as { hasMimeHandlerApi: boolean; dynamicRuleIds: number[] };
    if (!page.hasMimeHandlerApi) expect(page.dynamicRuleIds).toEqual([1001, 1002]);
  });
}
