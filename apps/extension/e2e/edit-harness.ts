/**
 * 편집 UI 하니스(M3 viewer-ui e2e 공용): viewer-ui 빌드 산출물과 가짜 편집 호스트(`packages/viewer-ui/test/fake-edit-host.ts`,
 * TypeScript `transpileModule` 로 JS 로 바꿔 서빙)를 실제 Chromium 에서 구동한다. 실제 core 편집 RPC 가 필요 없다.
 */
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import type { PageModel, Rect } from '@pdf-editor/shared-types';
import type { FakeParagraph, FakePath } from '../../../packages/viewer-ui/test/fake-edit-host.js';
import { makePageModel } from '../../../packages/viewer-ui/test/fixtures.js';

const UI_ROOT = fileURLToPath(new URL('../../../packages/viewer-ui/', import.meta.url));
const FAKE_HOST_TS = join(UI_ROOT, 'test/fake-edit-host.ts');

const requireFromUi = createRequire(join(UI_ROOT, 'package.json'));
const PREACT_DIR = dirname(requireFromUi.resolve('preact/package.json'));
const VENDOR_FILES: Record<string, string> = {
  '/vendor/preact.js': join(PREACT_DIR, 'dist/preact.module.js'),
  '/vendor/hooks.js': join(PREACT_DIR, 'hooks/dist/hooks.module.js'),
  '/vendor/jsx-runtime.js': join(PREACT_DIR, 'jsx-runtime/dist/jsxRuntime.module.js'),
};

export interface EditHarnessConfig {
  /** 원 문서 글자 모델(시작 캐럿 계산용). */
  model: PageModel;
  paragraphs: FakeParagraph[];
  /** 영역 상한(기본 [0, 0, 612, 792]). */
  areaLimit?: Rect;
  /** pt → CSS px 고정 배율. */
  cssScale: number;
  /** 가짜 호스트 리플로우의 글자 폭 등. */
  layout?: { charWidth?: number; newlineInLine?: boolean };
  pageCount?: number;
  /** 벡터 패스(M4). 편집은 가짜 호스트가 반영해 돌려준다. */
  paths?: FakePath[];
  /** 표 레이아웃(getPageLayout). 없으면 미구현 예외. */
  layout2?: unknown;
}

const HARNESS_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<script type="importmap">${JSON.stringify({
  imports: {
    preact: '/vendor/preact.js',
    'preact/hooks': '/vendor/hooks.js',
    'preact/jsx-runtime': '/vendor/jsx-runtime.js',
  },
})}</script>
<link rel="stylesheet" href="/ui/style.css">
<style>
  body { margin: 0; background: #525659; font: 13px system-ui, sans-serif; }
  #toolbar { position: sticky; top: 0; z-index: 20; display: flex; gap: 8px; align-items: center;
    padding: 6px 10px; background: #323639; color: #eee; }
  #page-container { display: flex; justify-content: center; padding: 16px; }
</style></head>
<body>
<header id="toolbar"><div id="viewer-controls"></div></header>
<main id="page-container"></main>
<script type="module" src="/harness.js"></script>
</body></html>`;

const HARNESS_JS = `
import { ViewerController, mountViewer, EditLog } from '/ui/index.js';
import { FakeEditHost } from '/fake-edit-host.js';
const cfg = window.__cfg;
const log = [];
window.__log = log;
const fake = new FakeEditHost({ paragraphs: cfg.paragraphs, areaLimit: cfg.areaLimit, layout: cfg.layout, paths: cfg.paths });
window.__edit = fake;
const model = cfg.model;
const size = { width: model.bounds[2] - model.bounds[0], height: model.bounds[3] - model.bounds[1] };
const unimpl = (name) => async () => { throw new Error('M1 미구현: ' + name); };
const host = {
  getPageInfo: async (i) => ({ pageIndex: i, bounds: model.bounds, size, rotation: 0 }),
  renderPage: async (req) => {
    const width = Math.ceil(size.width * req.scale);
    const height = Math.ceil(size.height * req.scale);
    window.__renders = (window.__renders || 0) + 1;
    return { pageIndex: req.pageIndex, width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255), renderMs: 1, clip: null };
  },
  extractPage: async (req) => ({ ...model, pageIndex: req.pageIndex, paths: cfg.paths ? fake.pathInfos() : model.paths }),
  getSourceMap: unimpl('getSourceMap'),
  linkPage: unimpl('linkPage'),
  searchText: unimpl('searchText'),
  getPageLayout: cfg.layout2 ? async (i) => ({ ...cfg.layout2, pageIndex: i }) : unimpl('getPageLayout'),
  getPageEditability: (i) => fake.getPageEditability(i),
  planParagraphEdit: (i, p) => fake.planParagraphEdit(i, p),
  beginParagraphEdit: (i, p, r, s) => fake.beginParagraphEdit(i, p, r, s),
  planPathEdit: (i, s) => fake.planPathEdit(i, s),
  beginPathEdit: (i, s, r) => fake.beginPathEdit(i, s, r),
  updatePathDraft: (d, e, scale) => fake.updatePathDraft(d, e, scale),
  commitPathEdit: (d) => fake.commitPathEdit(d),
  cancelPathEdit: (d) => fake.cancelPathEdit(d),
  updateParagraphDraft: (d, input) => fake.updateParagraphDraft(d, input),
  commitParagraphEdit: (d) => fake.commitParagraphEdit(d),
  cancelParagraphEdit: (d) => fake.cancelParagraphEdit(d),
  undo: () => fake.undo(),
  redo: () => fake.redo(),
  getEditHistory: () => fake.getEditHistory(),
  log: (event, data) => log.push({ event, data }),
};
const editLog = new EditLog();
window.__editLog = editLog;
const controller = new ViewerController({
  host,
  pageCount: cfg.pageCount ?? 1,
  getEnvironment: () => ({ devicePixelRatio: window.devicePixelRatio || 1, availableWidth: document.documentElement.clientWidth }),
  cssScaleFor: () => cfg.cssScale,
  onPagePainted: (e) => { document.body.dataset.painted = String(e.pageIndex); },
  editLog,
});
window.__controller = controller;
mountViewer(
  { controls: document.getElementById('viewer-controls'), pages: document.getElementById('page-container') },
  controller,
);
await controller.start();
document.body.dataset.ready = '1';
`;

let server: Server | null = null;
let base = '';
let fakeHostJs = '';

export function startEditHarness(): Promise<void> {
  fakeHostJs = ts.transpileModule(readFileSync(FAKE_HOST_TS, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (file: string, type: string) => {
      try {
        res.writeHead(200, { 'content-type': type }).end(readFileSync(file));
      } catch {
        res.writeHead(404).end();
      }
    };
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HARNESS_HTML);
    } else if (path === '/harness.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(HARNESS_JS);
    } else if (path === '/fake-edit-host.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(fakeHostJs);
    } else if (path in VENDOR_FILES) {
      send(VENDOR_FILES[path]!, 'text/javascript');
    } else if (path === '/ui/style.css') {
      send(join(UI_ROOT, 'src/style.css'), 'text/css');
    } else if (
      path.startsWith('/ui/') &&
      /^\/ui\/[\w./-]+\.js$/.test(path) &&
      !path.includes('..')
    ) {
      send(join(UI_ROOT, 'dist', path.slice('/ui/'.length)), 'text/javascript');
    } else {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) =>
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    }),
  );
}

export function stopEditHarness(): void {
  server?.close();
  server = null;
}

export async function openEditHarness(page: Page, cfg: EditHarnessConfig): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((c) => {
    (window as unknown as { __cfg: unknown }).__cfg = c;
  }, cfg);
  await page.goto(`${base}/`);
  await page.waitForSelector('body[data-ready="1"]');
  return errors;
}

/** 합성 원 문서: 줄 0 "Hello World"(글자 0–10, x 20–130, y 20–34), 줄 1 "표 셀"(글자 11–13). */
export function editModel(): PageModel {
  return makePageModel(['Hello World', { text: '표 셀', y: 46 }]);
}
