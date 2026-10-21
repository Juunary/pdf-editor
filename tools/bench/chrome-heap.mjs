/* global window, document */
// Chrome Worker 저장 힙 1회 검증(계약 4.2, docs/m5-heap.md 4.3). Playwright 번들 Chromium 에 dist 확장을 올리고 `viewer.html?e2e`
// 이음매(`__pe.pdf`, 뷰어 소유 Worker 의 RPC)로 열기 → (full) 첫 편집 가능 문단 편집·커밋 → planSave → save 를 부른다.
// 저장 전 판정(over-limit 중단)은 거치지 않고 저장해 실제 실패 양상을 본다. 탭 크래시는 미탐으로 센다.
// 사용: pnpm --filter @pdf-editor/extension build 후
//   node tools/bench/chrome-heap.mjs <pdf>:<full|none|full2|none2> [...] [--out out/m5-heap/chrome.jsonl]
// full2·none2: 같은 세션 저장 2회(docs/m5-heap.md 4.4). 첫 저장 뒤 (full2 는 다시 편집하고) 두 번째 planSave → save, 결과 plan2·peak2.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/extension/node_modules/@playwright/test/index.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'apps/extension/dist');
const args = process.argv.slice(2);
const outPath = args.includes('--out')
  ? resolve(args[args.indexOf('--out') + 1])
  : join(ROOT, 'out/m5-heap/chrome.jsonl');
const jobs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');

async function measure(context, extensionId, path, variant) {
  const page = await context.newPage();
  const out = { id: basename(path, '.pdf'), path, variant, crashed: false };
  page.on('crash', () => (out.crashed = true));
  try {
    await page.goto(`chrome-extension://${extensionId}/viewer.html?e2e`);
    await page.waitForFunction(() => '__pe' in window);
    const t0 = Date.now();
    await page.setInputFiles('#open-file', path);
    await page.waitForFunction(
      () => document.querySelector('#status')?.getAttribute('data-state') === 'rendered',
      null,
      { timeout: 120_000 },
    );
    out.openToRenderedMs = Date.now() - t0;
    const r = await page.evaluate(async (variant) => {
      const pdf = window.__pe.pdf;
      const res = { edit: null };
      const editOnce = async (suffix) => {
        for (let p = 0; p < 8; p++) {
          const ed = await pdf.getPageEditability(p);
          const para = ed.paragraphs.find((x) => x.editable);
          if (!para) continue;
          const plan = await pdf.planParagraphEdit(p, para.paragraphId);
          if (!plan.editable) continue;
          const started = await pdf.beginParagraphEdit(p, para.paragraphId, plan.revision);
          const text = plan.runs.map((x) => x.text).join('') + suffix;
          await pdf.updateParagraphDraft(started.draftId, {
            runs: [{ text, style: plan.runs[0].style }],
            format: plan.format,
            composition: null,
            renderScale: 1.5,
          });
          await pdf.commitParagraphEdit(started.draftId);
          return { page: p };
        }
        return null;
      };
      const edits = variant === 'full' || variant === 'full2';
      if (edits) res.edit = await editOnce(' 수정 확인');
      const plan = await pdf.planSave({ changes: [] });
      res.method = plan.method;
      res.heap = plan.heap;
      try {
        const saved = await pdf.save({ changes: [] });
        res.ok = true;
        res.saveMs = saved.saveMs;
        res.peak = saved.wasmHeapBytes;
        res.outputBytes = saved.bytes.byteLength;
      } catch (e) {
        res.ok = false;
        res.error = `${e?.name ?? ''}: ${e?.message ?? e}`;
      }
      if (res.ok && (variant === 'full2' || variant === 'none2')) {
        if (edits) res.edit2 = await editOnce(' 두 번째');
        const plan2 = await pdf.planSave({ changes: [] });
        res.method2 = plan2.method;
        res.heap2 = plan2.heap;
        try {
          const saved2 = await pdf.save({ changes: [] });
          res.ok2 = true;
          res.saveMs2 = saved2.saveMs;
          res.peak2 = saved2.wasmHeapBytes;
        } catch (e) {
          res.ok2 = false;
          res.error2 = `${e?.name ?? ''}: ${e?.message ?? e}`;
        }
      }
      return res;
    }, variant);
    Object.assign(out, r);
  } catch (e) {
    out.ok = false;
    out.error = String(e);
  }
  // 미탐: 측정 피크 > 예상 피크, 또는 탭 크래시. 저장 실패(Worker 복구)는 예상이 over-limit 이 아니면 미탐.
  const est = out.heap?.estimatedPeakBytes ?? 0;
  out.miss = out.crashed || (out.ok ? out.peak > est : out.heap?.level !== 'over-limit');
  if (out.heap2) {
    const est2 = out.heap2.estimatedPeakBytes;
    out.miss2 = out.crashed || (out.ok2 ? out.peak2 > est2 : out.heap2.level !== 'over-limit');
  }
  await page.close().catch(() => {});
  return out;
}

const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-editor-m5-heap-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
});
const results = [];
try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  for (const job of jobs) {
    const i = job.lastIndexOf(':');
    const r = await measure(context, extensionId, resolve(job.slice(0, i)), job.slice(i + 1));
    r.browser = context.browser()?.version() ?? null;
    results.push(r);
    const mib = (v) => (v ? (v / 2 ** 20).toFixed(1) : '-');
    process.stderr.write(
      `${r.id} ${r.variant}: ok=${r.ok} crashed=${r.crashed} peak=${mib(r.peak)} 예상=${mib(r.heap?.estimatedPeakBytes)} ${r.heap?.level ?? ''} miss=${r.miss}${r.heap2 ? ` | 2회째 ok=${r.ok2} peak=${mib(r.peak2)} 예상=${mib(r.heap2.estimatedPeakBytes)} ${r.heap2.level}${r.heap2.grownHeapBasis ? '(커진 힙)' : ''} miss=${r.miss2}` : ''}${r.error ? ` ${r.error.slice(0, 160)}` : ''}\n`,
    );
  }
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
writeFileSync(outPath, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
