// Journal retention measurement (D4, docs/m5-heap.md section 5). Edits and commits the same paragraph on one page N times, recording the WASM heap and the journal retention estimate,
// then measures the estimated peak (planSave), the actual save peak, and the time to reapply the same log to a new session.
// Usage: node tools/bench/journal-child.mjs <pdf> <page> <N> <same|distinct> [--no-save] [--no-replay]
//   same: edit the same paragraph N times (after the first edit, its edit block). Only the block stream changes.
//   distinct: edit not-yet-edited paragraphs in turn (page content changes each time). When they run out, edit the edit blocks in turn.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfSession, wasmHeapBytes } from '../../packages/core/dist/index.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
const SCALE = 1.5;
const EVERY = 10;

const [path, pageArg, nArg, mode = 'same'] = process.argv.slice(2);
const page = Number(pageArg);
const n = Number(nArg);
const flags = new Set(process.argv.slice(6));
const bytes = new Uint8Array(readFileSync(path));
const out = { path, page, n, mode, steps: [], ok: false };
const s = new PdfSession({ loadFallbackFont: async () => FONT });
s.open(bytes);
out.baseHeap = wasmHeapBytes();
s.renderPage({ pageIndex: page, scale: SCALE });
const ops = [];
const t0 = performance.now();
try {
  const ed = await s.getPageEditability(page);
  const para = ed.paragraphs.find((p) => p.editable);
  if (!para) throw new Error('편집 가능 문단 없음');
  out.paragraphId = para.paragraphId;
  let blockTurn = 0;
  for (let i = 0; i < n; i++) {
    const paras = (await s.getPageEditability(page)).paragraphs.filter((p) => p.editable);
    let cur;
    if (mode === 'distinct') {
      cur = paras.find((p) => p.editedBlock === null);
      if (!cur) {
        const blocks = paras.filter((p) => p.editedBlock !== null);
        cur = blocks[blockTurn++ % Math.max(1, blocks.length)];
      }
    } else {
      // Find the same paragraph again even after it became an edit block (a block is one paragraph).
      cur = paras.find((p) =>
        i === 0 ? p.paragraphId === para.paragraphId : p.editedBlock !== null,
      );
    }
    if (!cur) throw new Error(`${i}회: 편집할 문단을 다시 찾지 못함`);
    const plan = await s.planParagraphEdit(page, cur.paragraphId);
    const started = await s.beginParagraphEdit(page, cur.paragraphId, plan.revision);
    const base = plan.runs.map((r) => r.text).join('');
    await s.updateParagraphDraft(started.draftId, {
      runs: [{ text: `${base.replace(/ #\d+$/, '')} #${i + 1}`, style: plan.runs[0].style }],
      format: plan.format,
      composition: null,
      renderScale: SCALE,
    });
    const { op } = await s.commitParagraphEdit(started.draftId);
    ops.push(op);
    if ((i + 1) % EVERY === 0 || i === 0) {
      out.steps.push({
        edits: i + 1,
        heap: wasmHeapBytes(),
        // Engine internal value: the same value as the public session path (planSave).
        journalBytes: s.planSave({ changes: [] }).heap.journalBytes ?? null,
        firstEdits: paras.filter((p) => p.editedBlock === null).length,
        ms: performance.now() - t0,
      });
    }
  }
  out.editMs = performance.now() - t0;
  const plan = s.planSave({ changes: [] });
  out.plan = plan.heap;
  if (!flags.has('--no-save')) {
    const r = s.save({ changes: [] });
    out.savePeak = r.wasmHeapBytes;
    out.saveMs = r.saveMs;
  }
  out.ok = true;
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e);
  out.failHeap = wasmHeapBytes();
  out.failAt = ops.length;
}
s.close();
if (!flags.has('--no-replay') && ops.length > 0) {
  // Reapply (D6 recovery path): time to open in a new session and apply the whole log. Checkpoint criterion (D4: 2 s).
  const r = new PdfSession({ loadFallbackFont: async () => FONT });
  r.open(bytes);
  const t1 = performance.now();
  try {
    await r.replayEdits(ops);
    out.replayMs = performance.now() - t1;
  } catch (e) {
    out.replayError = e instanceof Error ? e.message : String(e);
  }
  out.replayHeap = wasmHeapBytes();
}
process.stdout.write(`${JSON.stringify(out)}\n`);
