/**
 * M3 통합 e2e(실제 core 편집 RPC). 2026-10-20 m3 통합에서 켰다(docs/m3-viewer-ui.md 5절, docs/m3-integration.md).
 * 본문은 가짜 호스트로 검증한 같은 DOM 식별자(`#pe-edit-*`)와 `?e2e` 이음매(`window.__pe`)를 쓴다.
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
    // 편집이 켜져 있어야 한다(기능이 꺼지면 #pe-notice 에 "문단 편집" 안내가 생긴다).
    await expect(page.locator('#pe-notice', { hasText: '문단 편집' })).toHaveCount(0);
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
    // 복구는 활성 로그만 다시 적용하고 undo 이력은 잃는다(계약 D6). 그래서 편집 두 번 뒤 undo 의 렌더에서 트랩을 내고,
    // 복구 결과가 첫 편집만 반영한 화면과 같은지 본다(비어 있지 않은 로그의 재적용).
    const page = await open(SAMPLE);
    const p = await firstEditable(page);
    const client = await cdp(page);
    const canvas = () =>
      page.evaluate(() =>
        (document.getElementById('page-canvas') as HTMLCanvasElement).toDataURL(),
      );

    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '복구' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    await expect(page.locator('#pe-doc-undo')).toBeEnabled();
    const afterFirst = await canvas();

    // 커밋 뒤 쪽 편집 가능 정보가 다시 올 때까지 기다린다(그 전 더블클릭은 대상 문단을 모른다).
    // 마우스가 이미 그 자리에 있으면 이동 이벤트가 없어 테두리가 갱신되지 않으므로 비켰다가 다시 올린다.
    await page.mouse.move(1, 1);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
    await page.mouse.dblclick(p.x, p.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await client.send('Input.insertText', { text: '둘째' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    expect(await canvas()).not.toBe(afterFirst);

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
    await expect(page.locator('#notice-bar [data-notice="recovered"]')).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => (window as unknown as PeWindow).__pe.controller.getState().edit.session === null,
    );
    await expect.poll(canvas, { timeout: 30_000 }).toBe(afterFirst);
  });
  test('B1(docs/m3-integration.md 9절): 커밋한 블록을 레이아웃이 두 문단으로 나눠도 마우스 오버 테두리는 하나', async () => {
    const page = await open(SAMPLE);
    const geo = () =>
      page.evaluate(async () => {
        const pe = (window as unknown as PeWindow).__pe;
        const layout = (await pe.pdf.getPageLayout!(0)) as {
          paragraphs: { id: number; text: string; bbox: number[] }[];
        };
        const box = document.getElementById('pe-page')!.getBoundingClientRect();
        const scale = Number(document.getElementById('pe-page')!.dataset.cssScale);
        return {
          paragraphs: layout.paragraphs.map((p) => ({
            text: p.text,
            x: box.left + ((p.bbox[0]! + p.bbox[2]!) / 2) * scale,
            y: box.top + ((p.bbox[1]! + p.bbox[3]!) / 2) * scale,
          })),
        };
      });
    const target = (await geo()).paragraphs.find((p) => p.text.startsWith('This paragraph'))!;
    // 편집 판정이 올 때까지 기다린다(그 전 더블클릭은 대상 문단을 모른다).
    await page.mouse.move(target.x, target.y, { steps: 3 });
    await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
    await page.mouse.dblclick(target.x, target.y);
    await expect(page.locator('#pe-edit-layer')).toBeVisible();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Short line one.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Short line two.');
    await page.waitForFunction(
      () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
    );
    await page.keyboard.press('Escape');
    await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
    // 전제: 레이아웃 복원은 강제 줄바꿈 뒤 짧은 줄을 다른 문단으로 본다.
    await expect
      .poll(
        async () => (await geo()).paragraphs.filter((p) => p.text.startsWith('Short line')).length,
      )
      .toBe(2);
    const lines = (await geo()).paragraphs.filter((p) => p.text.startsWith('Short line'));
    const hoverAt = async (x: number, y: number) => {
      await page.mouse.move(1, 1);
      await page.mouse.move(x, y, { steps: 3 });
      const hover = page.locator('#pe-edit-hover');
      await expect(hover).toBeVisible();
      return {
        id: await hover.getAttribute('data-paragraph'),
        box: (await hover.boundingBox())!,
      };
    };
    const a = await hoverAt(lines[0]!.x, lines[0]!.y);
    const b = await hoverAt(lines[1]!.x, lines[1]!.y);
    expect(b.id).toBe(a.id);
    // 테두리 하나가 두 줄을 모두 덮는다.
    expect(a.box.y).toBeLessThan(lines[0]!.y);
    expect(a.box.y + a.box.height).toBeGreaterThan(lines[1]!.y);
  });
});
