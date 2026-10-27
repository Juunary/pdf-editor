// Measurement of the Chrome 128–150 DNR fallback path (PLAN.md 5.1, docs/m0-day1-log.md A5, docs/m0-corpus-recheck.md section 4).
//
// Skipped in the default run. Download old Chrome for Testing versions, then pass the executable paths.
//   node apps/extension/scripts/fetch-chrome-for-testing.mjs 128 140 150
//   PDF_EDITOR_LEGACY_CHROME=<path1>,<path2> pnpm --filter @pdf-editor/extension exec playwright test dnr-legacy
// Result JSON: out/m0-corpus/dnr/<version>.json (excluded from git)
//
// This is measurement-oriented, so assertions are minimal (service worker starts, 2 dynamic rules registered when the mimeHandler is absent); the rest of the behavior is
// recorded as is.
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
/** Chrome's default PDF viewer (built-in extension) */
const BUILTIN_PDF_VIEWER = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

/** Serves dist/diag + records requests. Adds the attachment and POST variant paths. */
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

/** Collects the page's extension viewer frame and Chrome's default PDF viewer frame. */
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
    // goto may end with ERR_ABORTED on a DNR redirect or a switch to download. The result is judged from the frame state.
    return String(e).split('\n')[0] ?? String(e);
  }
}

/** Part of `chrome.developerPrivate` (internal API of the extensions management page) in the chrome://extensions page context. */
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

/** Install warnings (ignored manifest keys etc.), errors and the file URL access setting. */
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
 * Turns on developer mode. Real users load unpacked extensions in developer mode, and Chrome 140·150 disable an unpacked extension with `unsupportedDeveloperExtension`
 * when it is reloaded in a profile where developer mode is off (measured).
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

/** The "파일 URL에 대한 액세스 허용" (Allow access to file URLs) setting (the extension is reloaded). */
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
  // Wait for the asynchronous registration in onInstalled.
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
 * State as seen from the extension page. The MV3 service worker is terminated when idle, so unless it is right after startup, query from an extension page.
 */
async function extensionPageInfo(context: BrowserContext, extensionId: string) {
  let lastError = '';
  // Changing the file URL access setting reloads the extension, and navigating an extension page in the meantime is blocked with ERR_BLOCKED_BY_CLIENT.
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
  test('Chrome 128–150 DNR fallback measurement', () => {
    test.skip(true, 'PDF_EDITOR_LEGACY_CHROME 미지정(scripts/fetch-chrome-for-testing.mjs 참고)');
  });
}

for (const executablePath of LEGACY) {
  test(`Chrome 128–150 DNR fallback measurement: ${executablePath}`, async () => {
    test.setTimeout(240_000);
    const { server, base, log } = await serve();
    const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-dnr-'));
    // Playwright's headless passes `--headless`, which in Chrome 131 and below may mean the old headless
    // that does not support extensions. Specify the new headless explicitly regardless of version.
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
      // The asynchronous registration in onInstalled may be late (0 observed right after startup on 128), so query again from the extension page.
      report.extensionPage = await extensionPageInfo(context, extensionId);

      // 1) http top-level GET PDF
      const p1 = await context.newPage();
      log.length = 0;
      const e1 = await gotoLoose(p1, `${base}/m0-sample.pdf`);
      report.httpTop = { gotoError: e1, ...(await inspectFrames(p1, extensionId, 1000)) };
      (report.httpTop as Record<string, unknown>).serverRequests = [...log];

      // 2) content-type parameter (`application/pdf; qs=…`) — rule value `application/pdf;*`
      const p2 = await context.newPage();
      log.length = 0;
      const e2 = await gotoLoose(p2, `${base}/ct-params.pdf`);
      report.httpContentTypeParams = {
        gotoError: e2,
        ...(await inspectFrames(p2, extensionId, 1000)),
        serverRequests: [...log],
      };

      // 3) content-disposition: attachment -> expected not to be intercepted (download)
      const p3 = await context.newPage();
      const download = p3.waitForEvent('download', { timeout: 8000 }).catch(() => null);
      const e3 = await gotoLoose(p3, `${base}/attachment.pdf`);
      const d = await download;
      report.httpAttachment = {
        gotoError: e3,
        downloaded: d ? d.suggestedFilename() : null,
        ...(await inspectFrames(p3, extensionId, 500)),
      };

      // 4) PDF generated by POST -> expected not to be intercepted because the rule is GET-only
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

      // 5) embedding: <embed>, <iframe>, <object>
      const p5 = await context.newPage();
      await gotoLoose(p5, `${base}/embed-test.html`);
      report.httpEmbedded = await inspectFrames(p5, extensionId, 4000);

      // 6) file:// — measured in the order default file URL access value -> opposite value
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
