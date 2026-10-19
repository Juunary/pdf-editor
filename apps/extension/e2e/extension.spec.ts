import { chromium, expect, test, type Frame, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');

/** dist/diag 를 http 로 제공한다(MIME handler 가로채기 대상). */
function serveDiag(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const file = join(DIST, 'diag', basename(new URL(req.url ?? '/', 'http://x').pathname));
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
      resolve({ server, base: `http://127.0.0.1:${port}` });
    }),
  );
}

interface DiagEntry {
  event: string;
  data: Record<string, unknown>;
}

async function diagOf(frame: Frame): Promise<DiagEntry[]> {
  return JSON.parse((await frame.textContent('#diag-log')) ?? '[]') as DiagEntry[];
}

async function viewerFrames(page: Page, extensionId: string, count: number): Promise<Frame[]> {
  const prefix = `chrome-extension://${extensionId}/viewer.html`;
  await expect
    .poll(() => page.frames().filter((f) => f.url().startsWith(prefix)).length)
    .toBe(count);
  return page.frames().filter((f) => f.url().startsWith(prefix));
}

/** 렌더 완료·캔버스 잉크 확인 후, 저장 두 경로를 눌러 결과를 모은다. */
async function exercise(page: Page, frame: Frame, label: string) {
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 20_000,
  });
  const ink = await frame.evaluate(() => {
    const c = document.getElementById('page-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i]! < 200 || d[i + 1]! < 200 || d[i + 2]! < 200) n++;
    return { width: c.width, height: c.height, nonWhite: n };
  });
  expect(ink.nonWhite, `${label}: 캔버스에 페이지가 그려져야 한다`).toBeGreaterThan(5000);

  // downloads 폴백: 다운로드 이벤트와 바이트 수
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    frame.click('#save-downloads'),
  ]);
  const downloaded = statSync(await download.path()).size;
  expect(downloaded).toBe(statSync(SAMPLE).size);

  // FSA: 헤드리스 Chromium 은 피커를 즉시 취소한다. 결과(오류 종류)만 기록한다.
  await frame.click('#save-as');
  await expect
    .poll(async () => (await diagOf(frame)).filter((e) => e.event === 'save').length)
    .toBe(2);
  const log = await diagOf(frame);
  const env = log.find((e) => e.event === 'env')!.data;
  const saves = log.filter((e) => e.event === 'save').map((e) => e.data);
  return {
    label,
    badge: await frame.textContent('#context-badge'),
    isTopLevel: env.isTopLevel,
    hasShowSaveFilePicker: env.hasShowSaveFilePicker,
    canvas: ink,
    downloadsBytes: downloaded,
    fsa: saves[1],
  };
}

test('확장 로드: 서비스 워커, MIME handler 세 문맥 렌더, 저장 경로', async () => {
  const testInfo = test.info();
  const { server, base } = await serveDiag();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(sw.url()).host;
    const swInfo = await sw.evaluate(async () => ({
      hasMimeHandlerApi: typeof chrome.mimeHandler === 'object',
      userAgent: navigator.userAgent,
      dynamicRules: (await chrome.declarativeNetRequest.getDynamicRules()).length,
    }));
    // 번들 Chromium(150+)은 MIME handler 경로 → DNR 폴백 규칙이 없어야 한다.
    expect(swInfo.hasMimeHandlerApi).toBe(true);
    expect(swInfo.dynamicRules).toBe(0);

    const results = [];

    // 1) 일반 뷰어 페이지(viewer.html?file=)
    const p1 = await context.newPage();
    await p1.goto(`chrome-extension://${extensionId}/viewer.html?file=${base}/m0-sample.pdf`);
    await expect(p1.locator('#context-badge')).toHaveText('url-param');
    results.push(await exercise(p1, p1.mainFrame(), 'viewer-page'));

    // 2) 최상위 MIME handler: http PDF 로 직접 이동
    const p2 = await context.newPage();
    await p2.goto(`${base}/m0-sample.pdf`);
    const [top] = await viewerFrames(p2, extensionId, 1);
    await expect(top!.locator('#context-badge')).toHaveText('mime-handler-top');
    results.push(await exercise(p2, top!, 'mime-handler-top'));

    // 3) 임베디드 MIME handler: <embed>, <iframe>, <object>
    const p3 = await context.newPage();
    await p3.goto(`${base}/embed-test.html`);
    const embedded = await viewerFrames(p3, extensionId, 3);
    for (const [i, f] of embedded.entries()) {
      await expect(f.locator('#context-badge')).toHaveText('mime-handler-embedded');
      results.push(await exercise(p3, f, `mime-handler-embedded#${i}`));
    }

    const report = { browser: context.browser()?.version() ?? null, sw: swInfo, results };
    writeFileSync(testInfo.outputPath('m0-contexts.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('m0-contexts', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
