/**
 * 릴리스 스테이징 스모크(계약 D6·D7): `pnpm package` 가 만든 out/release/staging 을 압축해제 확장으로 로드해
 * http 로 제공한 PDF 의 열기·렌더·저장과 스토어 빌드의 성질(DNR·호스트 권한·WAR 없음, 진단 UI 숨김, downloads 저장 메뉴 없음,
 * 정보 대화상자)을 확인한다.
 */
import { chromium, expect, test, type BrowserContext, type Frame } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAGING = join(EXT_ROOT, 'out', 'release', 'staging');
const SAMPLE = fileURLToPath(new URL('../../../fixtures/m0/m0-sample.pdf', import.meta.url));
const VERSION = (
  JSON.parse(readFileSync(join(EXT_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

let context: BrowserContext;
let server: Server;
let base: string;
let userDataDir: string;
let extensionId: string;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  // 패키지 생성(스토어 빌드 → 스테이징 → zip → verify-dist --release).
  const built = spawnSync('pnpm', ['run', 'package'], { cwd: EXT_ROOT, encoding: 'utf8' });
  expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);

  const pdf = readFileSync(SAMPLE);
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/sample.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
    } else if (path === '/framer.html') {
      // 웹 페이지가 확장 뷰어를 iframe 으로 띄우려는 시도(D7 위험): WAR 가 없으므로 막혀야 한다.
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<iframe id="f" src="chrome-extension://${extensionId}/viewer.html?file=${base}/sample.pdf"></iframe>`,
        );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-release-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${STAGING}`, `--load-extension=${STAGING}`],
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

async function openSample(init?: () => void): Promise<Frame> {
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.goto(`${base}/sample.pdf`);
  const prefix = `chrome-extension://${extensionId}/viewer.html`;
  await expect.poll(() => page.frames().filter((f) => f.url().startsWith(prefix)).length).toBe(1);
  return page.frames().find((f) => f.url().startsWith(prefix))!;
}

test('스테이징 확장: 스토어 매니페스트, DNR 서비스 워커 경로 없음', async () => {
  const sw = context.serviceWorkers()[0]!;
  const info = await sw.evaluate(() => ({
    manifest: chrome.runtime.getManifest(),
    hasDnr: 'declarativeNetRequest' in chrome,
    hasMimeHandler: typeof chrome.mimeHandler === 'object',
  }));
  expect(info.manifest.name).toBe('PDF Editor');
  expect(info.manifest.version).toBe(VERSION);
  expect(info.manifest.minimum_chrome_version).toBe('151');
  expect(info.manifest.permissions).toEqual(['downloads']);
  expect(info.manifest.host_permissions).toBeUndefined();
  expect(info.manifest.web_accessible_resources).toBeUndefined();
  expect(info.hasDnr).toBe(false);
  expect(info.hasMimeHandler).toBe(true);
});

test('열기·렌더·저장: 최상위 MIME handler, 진단 UI 는 숨김, downloads 저장 메뉴 없음', async () => {
  // FSA 를 쓸 수 없는 문맥처럼 피커를 없앤다(헤드리스는 피커를 바로 취소한다): 저장 → chrome.downloads 폴백.
  const frame = await openSample(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  const ink = await frame.evaluate(() => {
    const c = document.getElementById('page-canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i]! < 200 || d[i + 1]! < 200 || d[i + 2]! < 200) n++;
    return n;
  });
  expect(ink).toBeGreaterThan(5000);

  // 진단 패널·진단 버튼은 DOM 에 있으나 보이지 않는다.
  await expect(frame.locator('html')).toHaveAttribute('data-build', 'store');
  await expect(frame.locator('#diag')).toBeHidden();
  await expect(frame.locator('#bench-full-save')).toBeHidden();
  // 벤치 측정 페이지는 개발 빌드 전용(D6): 링크가 없다.
  expect(await frame.locator('#open-bench').count()).toBe(0);
  expect(await frame.locator('#diag').count()).toBe(1);

  // 저장 메뉴(사용자 요청 2026-10-22): 스토어 빌드에는 downloads 저장(M0 진단) 항목이 없다.
  expect(await frame.locator('#save-downloads').count()).toBe(0);
  await frame.click('#save-menu-button');
  await expect(frame.locator('#save-menu [role="menuitem"]')).toHaveText([
    /^\s*저장\s*Ctrl\+S\s*$/,
    '다른 이름으로 저장',
  ]);

  // 저장: FSA 피커가 없으므로 chrome.downloads 로 저장한다. 편집 없는 문서라 원본과 같은 크기.
  const page = frame.page();
  const [download] = await Promise.all([page.waitForEvent('download'), frame.click('#save')]);
  expect(statSync(await download.path()).size).toBe(statSync(SAMPLE).size);
  await expect(frame.locator('#save-menu')).toBeHidden();
});

test('정보 대화상자: 버전·라이선스·버전 태그 소스 링크·고지', async () => {
  const frame = await openSample();
  await expect(frame.locator('#status')).toHaveAttribute('data-state', 'rendered', {
    timeout: 30_000,
  });
  await frame.click('#about');
  const dialog = frame.locator('#app-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`버전 ${VERSION}`);
  await expect(dialog).toContainText('AGPL-3.0-or-later');
  await expect(dialog.locator('a', { hasText: '소스 코드' })).toHaveAttribute(
    'href',
    `https://github.com/Juunary/pdf-editor/tree/v${VERSION}`,
  );
  const notices = dialog.locator('a', { hasText: '서드파티' });
  await expect(notices).toHaveAttribute(
    'href',
    `chrome-extension://${extensionId}/THIRD_PARTY_NOTICES.txt`,
  );
  const text = await frame.evaluate(
    async (url) => (await fetch(url)).text(),
    `chrome-extension://${extensionId}/THIRD_PARTY_NOTICES.txt`,
  );
  expect(text).toContain('mupdf 1.28.1');
  expect(text).toContain('SIL OPEN FONT LICENSE');
});

test('웹 페이지는 확장 뷰어를 iframe 으로 띄울 수 없다(WAR 없음, D7)', async () => {
  const page = await context.newPage();
  await page.goto(`${base}/framer.html`);
  await page.waitForTimeout(1500);
  const loaded = page
    .frames()
    .filter((f) => f.url().startsWith(`chrome-extension://${extensionId}/viewer.html`));
  // 막힌 프레임은 오류 페이지로 남는다.
  expect(page.frames().some((f) => f.url().startsWith('chrome-error://'))).toBe(true);
  expect(loaded).toHaveLength(0);
});
