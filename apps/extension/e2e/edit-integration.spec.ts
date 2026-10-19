/**
 * M3 통합 시 켜는 e2e(실제 core 편집 RPC 필요). 지금은 core(S3)·pdf-ops(S1)·reflow(S2)가 m3 에 머지되지 않아 `test.skip` 이다.
 * 켜는 방법: 아래 `test.skip(true, …)` 한 줄을 지우고 실제 값(기대 텍스트·p95 기준)을 측정해 조정한다(docs/m3-viewer-ui.md 5절).
 * 본문은 가짜 호스트로 검증한 같은 DOM 식별자(`#pe-edit-*`)와 `?e2e` 이음매(`window.__pe`)를 쓴다. 통합 전에는 실행한 적이 없다.
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const SAMPLE = join(DIST, 'diag/m0-sample.pdf');
const REASON =
  'core 편집 RPC(S3)·pdf-ops(S1)·reflow(S2)가 m3 에 머지된 뒤 켠다 — docs/m3-viewer-ui.md 5절';

interface PeWindow {
  __pe: {
    pdf: Record<string, (...args: unknown[]) => Promise<unknown>> & { current: { api: unknown } };
    controller: {
      getState(): { edit: { session: { editor: { text: string } } | null } };
      edit: { currentSession(): { latencies: number[] } | null };
    };
  };
}

test.describe('통합(실제 core 편집 RPC 필요)', () => {
  test.skip(true, REASON);

  let context: BrowserContext;
  let userDataDir: string;
  let extensionId: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-int-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  async function open(file: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
    await page.waitForFunction(() => '__pe' in window);
    await page.setInputFiles('#open-file', file);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 30_000,
    });
    await expect(page.locator('#pe-notice')).not.toContainText('문단 편집'); // 편집이 켜져 있어야 한다
    return page;
  }

  /** 쪽 0 의 첫 편집 가능 문단의 화면 좌표(문단 가운데). */
  async function firstEditable(page: Page): Promise<{ x: number; y: number; id: number }> {
    const info = await page.evaluate(async () => {
      const pe = (window as unknown as PeWindow).__pe;
      const e = (await pe.pdf.getPageEditability!(0)) as {
        paragraphs: { paragraphId: number; bbox: number[]; editable: boolean }[];
      };
      const p = e.paragraphs.find((q) => q.editable)!;
      const box = document.getElementById('pe-page')!.getBoundingClientRect();
      const scale = Number(document.getElementById('pe-page')!.dataset.cssScale);
      return {
        id: p.paragraphId,
        x: box.left + ((p.bbox[0]! + p.bbox[2]!) / 2) * scale,
        y: box.top + ((p.bbox[1]! + p.bbox[3]!) / 2) * scale,
      };
    });
    return info;
  }

  const editorText = (page: Page) =>
    page.evaluate(
      () =>
        (window as unknown as PeWindow).__pe.controller.getState().edit.session?.editor.text ??
        null,
    );

  async function cdp(page: Page): Promise<CDPSession> {
    return page.context().newCDPSession(page);
  }

  test('DoD 흐름: 한글 조합 → 확정 → 커밋 → 저장 → 재열기 → 검색·복사 텍스트 → 같은 문단 재편집', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    await client.send('Input.imeSetComposition', {
      text: '한',
      selectionStart: 1,
      selectionEnd: 1,
    });
    await client.send('Input.insertText', { text: '한' });
    expect(await editorText(page)).toContain('한');
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    // 저장(downloads 경로) 후 재열기
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#save-downloads'),
    ]);
    const saved = await download.path();
    expect(readFileSync(saved).byteLength).toBeGreaterThan(0);
    const reopened = await open(saved);
    const text = await reopened.evaluate(async () => {
      const m = (await (window as unknown as PeWindow).__pe.pdf.extractPage!({ pageIndex: 0 })) as {
        chars: { text: string }[];
      };
      return m.chars.map((c) => c.text).join('');
    });
    expect(text).toContain('한');
    // 같은 문단을 새 세션에서 다시 편집할 수 있다(편집 블록 재편집, /PdfEditorFormat).
    const q = await firstEditable(reopened);
    await reopened.mouse.dblclick(q.x, q.y);
    await expect(reopened.locator('#pe-edit-layer')).toBeVisible();
    expect(await editorText(reopened)).toContain('한');
  });

  test('편집 반응 시간(계약 8.4): 입력 → 변경 영역 합성 p95 ≤ 100 ms(잠정, 측정 뒤 사용자 확인으로 고정)', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    for (const ch of 'The quick brown fox jumps over the lazy dog') {
      await client.send('Input.insertText', { text: ch });
      await page.waitForFunction(
        () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
      );
    }
    const ms = await page.evaluate(() =>
      performance.getEntriesByName('pe-edit-latency').map((e) => e.duration),
    );
    ms.sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    console.log(JSON.stringify({ samples: ms.length, p95, max: ms.at(-1) }));
    expect(p95).toBeLessThanOrEqual(100);
  });

  test('폴백(한글)·없는 글자 경고가 실제 plan/draft 경고와 일치', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    const client = await cdp(page);
    await client.send('Input.insertText', { text: '한글' }); // 영문 서브셋 폰트에 없는 글자 → 폴백
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await expect(page.locator('.pe-edit-fb')).not.toHaveCount(0);
    await expect(page.locator('#pe-edit-warnings li[data-kind="font-fallback"]')).toBeVisible();
    await client.send('Input.insertText', { text: '' }); // 폴백에도 없는 사설 영역 글자
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await expect(page.locator('.pe-edit-missing')).toHaveCount(1);
    await expect(page.locator('#pe-edit-warnings li[data-kind="glyph-missing"]')).toBeVisible();
  });

  test('Worker 치명 오류 → 복구 → replayEdits 결과 = 복구 전 화면(D6, A3-3)', async () => {
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    await page.mouse.dblclick(p.x, p.y);
    const client = await cdp(page);
    await client.send('Input.insertText', { text: '복구' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    const before = await page.evaluate(() =>
      (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
    );
    // 다음 renderPage 가 wasm 트랩(RuntimeError)을 내도록 지금 Worker 핸들을 감싼다.
    await page.evaluate(() => {
      const handle = (window as unknown as PeWindow).__pe.pdf.current as { api: unknown };
      const real = handle.api as Record<string, (...a: unknown[]) => Promise<unknown>>;
      let armed = true;
      handle.api = new Proxy(
        {},
        {
          get:
            (_t, name: string) =>
            (...args: unknown[]) => {
              if (armed && name === 'renderPage') {
                armed = false;
                const e = new Error('memory access out of bounds');
                e.name = 'RuntimeError';
                return Promise.reject(e);
              }
              return real[name]!(...args);
            },
        },
      );
    });
    await page.click('#pe-doc-undo');
    await page.click('#pe-doc-redo');
    await expect(page.locator('#notice-bar [data-notice="recovered"]')).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => (window as unknown as PeWindow).__pe.controller.getState().edit.session === null,
    );
    const after = await page.evaluate(() =>
      (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
    );
    expect(after).toBe(before);
  });
});
