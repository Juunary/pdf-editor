// One save-heap measurement (docs/m5-heap.md section 2). A fresh Node process per measurement: WASM linear memory never shrinks, so the value right after the save is the peak.
// Usage: node tools/bench/heap-child.mjs <pdf> <full|none|full2|none2> [pages viewed]
//   full: append Korean text to the first editable paragraph and commit (embeds a fallback font) → planSave → save (full save)
//   none: planSave → save with no edits (no changes, incremental save)
//   full2·none2: two saves in the same session (docs/m5-heap.md 4.4). After the first save (full2 edits again), render the next N pages, then
//     planSave → save. plan2·peak2 in the result belong to the second save.
//   pages viewed (default 0): render the first N pages before saving (the user has paged through; heap history changes the peak steps).
// Writes one line of result JSON to stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// core must be loaded before mupdf so the WASM heap measurement object is attached (packages/core/src/wasm-module.ts).
import { PdfSession, wasmHeapBytes } from '../../packages/core/dist/index.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
/** Number of leading pages to search for an editable paragraph. */
const EDIT_SEARCH_PAGES = 8;
const RENDER_SCALE = 1.5;

export async function measure(path, variant, viewPages = 0) {
  const out = { path, variant, viewPages, ok: false, marks: {} };
  const mark = (name) => (out.marks[name] = wasmHeapBytes());
  try {
    const bytes = new Uint8Array(readFileSync(path));
    out.inputBytes = bytes.byteLength;
    const s = new PdfSession({ loadFallbackFont: async () => FONT });
    const opened = s.open(bytes);
    out.pages = opened.pageCount;
    out.openMs = opened.openMs;
    mark('open');
    s.renderPage({ pageIndex: 0, scale: RENDER_SCALE });
    mark('render');
    const t0 = performance.now();
    out.stats = s.documentStats();
    out.statsMs = performance.now() - t0;
    mark('stats');
    const editOnce = async (suffix) => {
      for (let p = 0; p < Math.min(EDIT_SEARCH_PAGES, opened.pageCount); p++) {
        const ed = await s.getPageEditability(p);
        for (const para of ed.paragraphs.filter((x) => x.editable)) {
          const plan = await s.planParagraphEdit(p, para.paragraphId);
          if (!plan.editable) continue;
          const started = await s.beginParagraphEdit(p, para.paragraphId, plan.revision);
          const text = plan.runs.map((r) => r.text).join('') + suffix;
          await s.updateParagraphDraft(started.draftId, {
            runs: [{ text, style: plan.runs[0].style }],
            format: plan.format,
            composition: null,
            renderScale: RENDER_SCALE,
          });
          await s.commitParagraphEdit(started.draftId);
          return { page: p, paragraphId: para.paragraphId };
        }
      }
      return null;
    };
    const edits = variant === 'full' || variant === 'full2';
    if (edits) {
      out.edit = await editOnce(' 수정 확인');
      mark('edit');
    }
    for (let p = 1; p <= Math.min(viewPages, opened.pageCount - 1); p++) {
      s.renderPage({ pageIndex: p, scale: RENDER_SCALE });
    }
    if (viewPages > 0) mark('view');
    const plan = s.planSave({ changes: [] });
    out.plan = { method: plan.method, heap: plan.heap };
    mark('plan');
    const res = s.save({ changes: [] });
    out.method = res.method;
    out.saveMs = res.saveMs;
    out.outputBytes = res.bytes.byteLength;
    out.peak = res.wasmHeapBytes;
    mark('save');
    if (variant === 'full2' || variant === 'none2') {
      if (edits) {
        out.edit2 = await editOnce(' 두 번째');
        mark('edit2');
      }
      const last = Math.min(2 * viewPages, opened.pageCount - 1);
      for (let p = viewPages + 1; p <= last; p++) {
        s.renderPage({ pageIndex: p, scale: RENDER_SCALE });
      }
      if (viewPages > 0) mark('view2');
      const plan2 = s.planSave({ changes: [] });
      out.plan2 = { method: plan2.method, heap: plan2.heap };
      mark('plan2');
      const res2 = s.save({ changes: [] });
      out.method2 = res2.method;
      out.saveMs2 = res2.saveMs;
      out.peak2 = res2.wasmHeapBytes;
      mark('save2');
    }
    out.ok = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    mark('error');
  }
  out.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, variant = 'full', view = '0'] = process.argv.slice(2);
  const r = await measure(path, variant, Number(view));
  process.stdout.write(`${JSON.stringify(r)}\n`);
}
