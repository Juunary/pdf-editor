/**
 * 편집 반응 시간 정식 측정(계약 8.4). 옵트인: 환경 변수 EDIT_LATENCY_CORPUS_DIR 이 있을 때만 돈다.
 *
 *   EDIT_LATENCY_CORPUS_DIR=/mnt/nas4/kjune/pdf-editor/fixtures/corpus \
 *     pnpm --filter @pdf-editor/extension exec playwright test e2e/edit-latency.spec.ts
 *
 * 모집단: 코퍼스 5문서 × 쪽 0(표지 등으로 모자라면 앞쪽부터 처음 충족하는 쪽, 최대 쪽 7) 의 편집 가능 문단 2개(50~500자) × 고정 텍스트 3종(라틴·한글·혼합)의 글자 단위 입력 전부.
 * 종점: 뷰어 자체 표식. `EditSession.latencies` 의 한 표본 = 입력 이벤트(`pendingT0` 최초 입력 시각) → 변경 영역을
 * 캔버스에 합성한 직후(`reportPainted`)의 `deps.now()` 차이(packages/viewer-ui/src/edit-session.ts). 같은 구간이
 * `performance.measure('pe-edit-latency')` 로도 남는다. 코어 쪽 성분은 `updateParagraphDraft` 응답의 `updateMs`.
 * 결과: out/m3-edit-latency/latency.json (`EDIT_LATENCY_OUT` 으로 파일 이름 변경).
 * 환경: Playwright 번들 Chromium, viewport 1600×1500(폭 맞춤 최대 1.5 에 걸려 cssScale 1.5), dpr 1.
 */
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = process.env.EDIT_LATENCY_CORPUS_DIR;
const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const OUT = resolve(
  fileURLToPath(new URL('../../../out/m3-edit-latency', import.meta.url)),
  process.env.EDIT_LATENCY_OUT ?? 'latency.json',
);

// 문서 순서 고정: 라틴(arXiv·NASA·NIST), 한글(공공누리·KCI 풍 학술지). 앞에서부터 2문단이 모자라면 뒤 후보로 대체한다.
const DOCS = [
  'arxiv-2609.09268',
  'nasa-eo-2024-janfeb',
  'kogl-nabo-rnd107',
  'zen-ko-kimtw-23386644',
  'nist-ai-100-1',
];
const RESERVE = [
  'kogl-mods-cpi-202609',
  'zen-ko-report-21333257',
  'fed-h41-current',
  'arxiv-2609.10511',
];

const TEXTS = [
  {
    kind: 'latin',
    text: 'The quick brown fox jumps over the lazy dog while editors measure every keystroke latency.',
  },
  { kind: 'korean', text: '다람쥐 헌 쳇바퀴에 타고파 가나다라마바사 아자차카타파하' },
  { kind: 'mixed', text: '2026년 國會 예산안 12.5% 증가, Q3 결과(v2)를 反映함' },
] as const;

interface Sample {
  doc: string;
  page: number;
  paragraphId: number;
  paragraph: string;
  textKind: string;
  index: number; // 텍스트 안 몇 번째 입력인지
  ms: number;
  updateMs: number | null;
  cssScale: number;
}

interface Pick {
  doc: string;
  page: number;
  paragraphId: number;
  chars: number;
  preview: string;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
function summarize(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.at(-1) ?? NaN, mean };
}
function groupBy<T>(xs: T[], key: (x: T) => string): Record<string, T[]> {
  const o: Record<string, T[]> = {};
  for (const x of xs) (o[key(x)] ??= []).push(x);
  return o;
}

test.describe('편집 반응 시간 정식 측정(계약 8.4, 옵트인)', () => {
  test.skip(!CORPUS, 'EDIT_LATENCY_CORPUS_DIR 가 없으면 건너뛴다');

  let context: BrowserContext;
  let userDataDir: string;
  let extensionId: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-e2e-lat-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1600, height: 1500 },
      deviceScaleFactor: 1,
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    extensionId = new URL(sw.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  async function open(file: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
    await page.waitForFunction(() => '__pe' in window);
    await page.setInputFiles('#open-file', file);
    await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered', {
      timeout: 120_000,
    });
    await expect(page.locator('#pe-notice', { hasText: '문단 편집' })).toHaveCount(0);
    return page;
  }

  /** 주어진 쪽의 편집 가능 문단 중 글자 수 50~500 인 앞의 2개(읽기 순서). */
  async function pickParagraphs(
    page: Page,
    pageIndex: number,
  ): Promise<Omit<Pick, 'doc' | 'page'>[]> {
    return page.evaluate(async (pi) => {
      type W = { __pe: { pdf: Record<string, (...a: unknown[]) => Promise<unknown>> } };
      const pe = (window as unknown as W).__pe;
      const e = (await pe.pdf.getPageEditability!(pi)) as {
        paragraphs: { paragraphId: number; bbox: number[]; editable: boolean }[];
      };
      const m = (await pe.pdf.extractPage!({ pageIndex: pi })) as {
        chars: { text: string; quad: number[] }[];
      };
      const out: { paragraphId: number; chars: number; preview: string }[] = [];
      for (const p of e.paragraphs) {
        if (!p.editable) continue;
        const [x0, y0, x1, y1] = p.bbox as [number, number, number, number];
        const inside = m.chars.filter((c) => {
          const cx = (c.quad[0]! + c.quad[2]! + c.quad[4]! + c.quad[6]!) / 4;
          const cy = (c.quad[1]! + c.quad[3]! + c.quad[5]! + c.quad[7]!) / 4;
          return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
        });
        const n = inside.length;
        if (n >= 50 && n <= 500) {
          out.push({
            paragraphId: p.paragraphId,
            chars: n,
            preview: inside
              .map((c) => c.text)
              .join('')
              .slice(0, 40),
          });
          if (out.length === 2) break;
        }
      }
      return out;
    }, pageIndex);
  }

  async function paragraphPoint(page: Page, id: number, pageIndex: number) {
    return page.evaluate(
      async ([pid, pi]) => {
        type W = { __pe: { pdf: Record<string, (...a: unknown[]) => Promise<unknown>> } };
        const e = (await (window as unknown as W).__pe.pdf.getPageEditability!(pi!)) as {
          paragraphs: { paragraphId: number; bbox: number[] }[];
        };
        const p = e.paragraphs.find((q) => q.paragraphId === pid)!;
        const el = document.getElementById('pe-page')!;
        const box = el.getBoundingClientRect();
        const scale = Number(el.dataset.cssScale);
        return {
          x: box.left + ((p.bbox[0]! + p.bbox[2]!) / 2) * scale,
          y: box.top + ((p.bbox[1]! + p.bbox[3]!) / 2) * scale,
          scale,
        };
      },
      [id, pageIndex] as const,
    );
  }

  test('10 문단 × 3 텍스트 키 입력 지연', async () => {
    test.setTimeout(30 * 60_000);
    const samples: Sample[] = [];
    const picks: Pick[] = [];
    const skipped: string[] = [];
    const env: Record<string, unknown> = {};

    const queue = [...DOCS];
    const reserve = [...RESERVE];
    let usedDocs = 0;
    while (usedDocs < 5 && queue.length > 0) {
      const doc = queue.shift()!;
      const page = await open(join(CORPUS!, `${doc}.pdf`));
      // 쪽 0 이 표지 등으로 조건을 못 채우면 앞쪽부터 처음 2개 이상 나오는 쪽을 쓴다(기록에 쪽 번호를 남긴다).
      const pageCount = await page.evaluate(
        () =>
          (
            window as unknown as { __pe: { controller: { getState(): { pageCount?: number } } } }
          ).__pe.controller.getState().pageCount ?? 1,
      );
      let found: Omit<Pick, 'doc' | 'page'>[] = [];
      let pageIndex = 0;
      for (; pageIndex < Math.min(pageCount, 8); pageIndex++) {
        found = await pickParagraphs(page, pageIndex);
        if (found.length >= 2) break;
      }
      if (found.length < 2) {
        skipped.push(`${doc}: 쪽 0~7 에 조건(50~500자) 문단 2개 없음`);
        await page.close();
        if (reserve.length) queue.push(reserve.shift()!);
        continue;
      }
      usedDocs++;
      if (pageIndex > 0) {
        await page.evaluate(
          (i) =>
            (
              window as unknown as { __pe: { controller: { goToPage(i: number): Promise<void> } } }
            ).__pe.controller.goToPage(i),
          pageIndex,
        );
        await expect(page.locator('#pe-page')).toHaveAttribute(
          'data-page-index',
          String(pageIndex),
        );
        await expect(page.locator('#status')).toHaveAttribute('data-state', 'rendered');
      }
      env.viewport = page.viewportSize();
      env.devicePixelRatio = await page.evaluate(() => window.devicePixelRatio);
      env.userAgent = await page.evaluate(() => navigator.userAgent);
      const client = await page.context().newCDPSession(page);

      for (const f of found) {
        picks.push({ ...f, doc, page: pageIndex });
        for (const t of TEXTS) {
          await page.mouse.move(1, 1);
          let pt = await paragraphPoint(page, f.paragraphId, pageIndex);
          await page.mouse.move(pt.x, pt.y, { steps: 3 });
          await expect(page.locator('#pe-edit-hover[data-editable="1"]')).toBeVisible();
          pt = await paragraphPoint(page, f.paragraphId, pageIndex);
          await page.evaluate(() => {
            type W = {
              __upd?: number[];
              __pe: { pdf: Record<string, (...a: unknown[]) => Promise<unknown>> };
            };
            const w = window as unknown as W;
            w.__upd = [];
            const pdf = w.__pe.pdf as Record<string, unknown> & { __wrapped?: boolean };
            if (!pdf.__wrapped) {
              pdf.__wrapped = true;
              const orig = pdf.updateParagraphDraft as (
                ...a: unknown[]
              ) => Promise<{ updateMs: number }>;
              pdf.updateParagraphDraft = async (...a: unknown[]) => {
                const r = await orig.apply(pdf, a);
                w.__upd!.push(r.updateMs);
                return r;
              };
            }
          });
          await page.mouse.dblclick(pt.x, pt.y);
          await expect(page.locator('#pe-edit-layer')).toBeVisible();
          // 열기 직후 초기 갱신이 끝나기를 기다린다.
          await page.waitForFunction(
            () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
          );
          const base = await page.evaluate(() => {
            const w = window as unknown as {
              __upd: number[];
              __pe: { controller: { edit: { currentSession(): { latencies: number[] } | null } } };
            };
            w.__upd.length = 0;
            return w.__pe.controller.edit.currentSession()!.latencies.length;
          });
          for (const ch of t.text) {
            await client.send('Input.insertText', { text: ch });
            await page.waitForFunction(
              () => document.getElementById('pe-edit-layer')?.getAttribute('data-updating') === '0',
            );
          }
          const res = await page.evaluate((b) => {
            const w = window as unknown as {
              __upd: number[];
              __pe: { controller: { edit: { currentSession(): { latencies: number[] } | null } } };
            };
            return {
              lat: w.__pe.controller.edit.currentSession()!.latencies.slice(b),
              upd: [...w.__upd],
            };
          }, base);
          const sameLen = res.lat.length === res.upd.length;
          res.lat.forEach((ms, i) =>
            samples.push({
              doc,
              page: pageIndex,
              paragraphId: f.paragraphId,
              paragraph: `${doc}:p${pageIndex}#${f.paragraphId}`,
              textKind: t.kind,
              index: i,
              ms,
              updateMs: sameLen ? res.upd[i]! : null,
              cssScale: pt.scale,
            }),
          );
          // 취소로 문서를 그대로 둔다.
          await page.click('#pe-edit-cancel');
          await expect(page.locator('#pe-edit-layer')).toHaveCount(0);
        }
      }
      await page.close();
    }

    const all = samples.map((s) => s.ms);
    const byP = groupBy(samples, (s) => s.paragraph);
    const byK = groupBy(samples, (s) => s.textKind);
    const upd = samples.filter((s) => s.updateMs !== null);
    const summary = {
      overall: summarize(all),
      perParagraph: Object.fromEntries(
        Object.entries(byP).map(([k, v]) => [k, summarize(v.map((s) => s.ms))]),
      ),
      perTextKind: Object.fromEntries(
        Object.entries(byK).map(([k, v]) => [k, summarize(v.map((s) => s.ms))]),
      ),
      coreUpdateMs: { pairedSamples: upd.length, ...summarize(upd.map((s) => s.updateMs!)) },
      p95Within100ms: summarize(all).p95 <= 100,
    };
    const slowest = [...samples].sort((a, b) => b.ms - a.ms).slice(0, 15);
    mkdirSync(resolve(OUT, '..'), { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          when: new Date().toISOString(),
          env,
          picks,
          skipped,
          texts: TEXTS,
          summary,
          slowest,
          samples,
        },
        null,
        1,
      ),
    );
    console.log(JSON.stringify({ out: OUT, summary }, null, 1));
    expect(samples.length).toBeGreaterThan(0);
    expect(picks.length).toBe(10);
  });
});
