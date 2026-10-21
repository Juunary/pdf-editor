// 복구 시간(계약 D4 사용자 결정 2026-10-21, docs/m5-followup.md): 한 쪽에서 서로 다른 문단을 차례로 N 번 고치되(다 쓰면 편집
// 블록을 차례로 다시 고침) N − after 번째 편집 뒤에 저장한다. 그 뒤 두 가지 복구를 새 세션에서 잰다.
//   original: 원본 열기 + 편집 N 건 재적용(기준점 없는 경우, 이전 방식)
//   baseline: 저장 바이트 열기 + 저장 뒤 편집 after 건 재적용(저장 시점 기준점)
// 재적용은 뷰어 복구 계층처럼 한 건씩(`replayEdits([op], { more })`) 보낸다. 두 결과의 쪽 텍스트가 원래 세션과 같은지도 본다.
// 사용: node tools/bench/recovery-time.mjs <pdf> <쪽(0부터)> <N> <after>
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
  // 복구 뒤 첫 화면: 그 쪽 렌더.
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
