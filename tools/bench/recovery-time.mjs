// Recovery time (contract D4 user decision 2026-10-21, docs/m5-followup.md): on one page, edit different paragraphs in turn N times (when they run out, re-edit the edit
// blocks in turn) and save after the (N − after)th edit. Then measure two recoveries in a new session.
//   original: open the original + reapply N edits (no checkpoint, the previous approach)
//   baseline: open the saved bytes + reapply the after edits made since the save (checkpoint at save time)
// Reapply sends edits one at a time (`replayEdits([op], { more })`) like the viewer recovery layer. Also checks that both results' page text matches the original session.
// Usage: node tools/bench/recovery-time.mjs <pdf> <page (0-based)> <N> <after>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PdfSession } from '../../packages/core/dist/index.js';

const FONT = new Uint8Array(
  readFileSync(
    fileURLToPath(new URL('../../assets/fonts/NotoSansKR-Regular-subset.ttf', import.meta.url)),
  ),
);
const SCALE = 1.5;

const [path, pageArg, nArg, afterArg] = process.argv.slice(2);
const page = Number(pageArg);
const n = Number(nArg);
const after = Number(afterArg);
if (!path || !(n > 0) || !(after >= 0 && after <= n)) {
  throw new Error('사용: recovery-time.mjs <pdf> <쪽> <N> <after>');
}
const bytes = new Uint8Array(readFileSync(path));
const text = (s) =>
  s
    .extractPage({ pageIndex: page })
    .chars.map((c) => c.text)
    .join('');

const out = { path, page, n, after };
const live = new PdfSession({ loadFallbackFont: async () => FONT });
live.open(bytes);
live.renderPage({ pageIndex: page, scale: SCALE });
const ops = [];
let saved = null;
let blockTurn = 0;
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  if (i === n - after) {
    const t = performance.now();
    saved = live.save({ changes: [] }).bytes;
    out.saveMs = performance.now() - t;
    out.savedBytes = saved.byteLength;
  }
  const paras = (await live.getPageEditability(page)).paragraphs.filter((p) => p.editable);
  let cur = paras.find((p) => p.editedBlock === null);
  if (!cur) {
    const blocks = paras.filter((p) => p.editedBlock !== null);
    cur = blocks[blockTurn++ % Math.max(1, blocks.length)];
  }
  if (!cur) throw new Error(`${i}회: 편집할 문단 없음`);
  const plan = await live.planParagraphEdit(page, cur.paragraphId);
  const started = await live.beginParagraphEdit(page, cur.paragraphId, plan.revision);
  const base = plan.runs.map((r) => r.text).join('');
  await live.updateParagraphDraft(started.draftId, {
    runs: [{ text: `${base.replace(/ #\d+$/, '')} #${i + 1}`, style: plan.runs[0].style }],
    format: plan.format,
    composition: null,
    renderScale: SCALE,
  });
  ops.push((await live.commitParagraphEdit(started.draftId)).op);
}
if (after === 0) {
  const t = performance.now();
  saved = live.save({ changes: [] }).bytes;
  out.saveMs = performance.now() - t;
  out.savedBytes = saved.byteLength;
}
out.editMs = performance.now() - t0;
const expected = text(live);
live.close();

async function recover(label, source, list) {
  const s = new PdfSession({ loadFallbackFont: async () => FONT });
  const t = performance.now();
  s.open(source);
  const openMs = performance.now() - t;
  const r0 = performance.now();
  for (const [i, op] of list.entries()) {
    await s.replayEdits([op], { more: i < list.length - 1 });
  }
  if (list.length === 0) await s.replayEdits([]);
  const replayMs = performance.now() - r0;
  // First screen after recovery: render that page.
  const g = performance.now();
  s.renderPage({ pageIndex: page, scale: SCALE });
  const renderMs = performance.now() - g;
  out[label] = {
    edits: list.length,
    openMs,
    replayMs,
    renderMs,
    totalMs: performance.now() - t,
    sameText: text(s) === expected,
  };
  s.close();
}

await recover('original', bytes, ops);
await recover('baseline', saved, ops.slice(n - after));
process.stdout.write(`${JSON.stringify(out)}\n`);
